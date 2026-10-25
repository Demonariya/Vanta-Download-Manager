use crate::{
    engines,
    models::{AppSettings, DownloadTask, EngineType, EngineUpdateResult, MediaMetadata, TaskPriority, TaskStatus},
    state::{AppState, ControlAction},
};
use serde_json::Value;
use std::{
    path::PathBuf,
    process::Command as StdCommand,
    sync::atomic::Ordering,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::watch;

#[tauri::command]
pub fn get_tasks(state: State<'_, AppState>) -> Result<Vec<DownloadTask>, String> {
    state.tasks_snapshot()
}

#[tauri::command]
pub fn get_task(id: String, state: State<'_, AppState>) -> Result<Option<DownloadTask>, String> {
    state.task_by_id(&id)
}

#[tauri::command]
pub async fn inspect_url(app: AppHandle, state: State<'_, AppState>, url: String) -> Result<MediaMetadata, String> {
    let settings = state.settings_snapshot()?;
    engines::inspect_url(&app, state.inner(), &url, &settings.proxy_url).await
}

#[tauri::command]
pub async fn get_available_formats(app: AppHandle, state: State<'_, AppState>, url: String) -> Result<Vec<crate::models::FormatOption>, String> {
    Ok(inspect_url(app, state, url).await?.formats)
}

fn value_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(ToString::to_string)
}
fn value_u64(value: &Value, field: &str) -> Option<u64> { value.get(field).and_then(Value::as_u64) }
fn value_u32(value: &Value, field: &str) -> Option<u32> { value_u64(value, field).and_then(|n| u32::try_from(n).ok()) }
fn value_bool(value: &Value, field: &str) -> Option<bool> { value.get(field).and_then(Value::as_bool) }

fn infer_engine(url: &str) -> EngineType {
    if url.to_ascii_lowercase().contains("open.spotify.com/") { EngineType::Spotdl } else { EngineType::YtDlp }
}

fn new_task(task_data: &Value, settings: &AppSettings) -> Result<DownloadTask, String> {
    let url = value_string(task_data, "url").ok_or_else(|| "A download URL is required.".to_string())?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only HTTP and HTTPS URLs are supported.".into());
    }
    let engine = task_data.get("engine").and_then(|v| serde_json::from_value::<EngineType>(v.clone()).ok()).unwrap_or_else(|| infer_engine(&url));
    let priority = task_data.get("priority").and_then(|v| serde_json::from_value::<TaskPriority>(v.clone()).ok()).unwrap_or_default();
    let audio_only = value_bool(task_data, "is_audio_only").unwrap_or(false);
    let output_path = value_string(task_data, "output_path").unwrap_or_else(|| settings.download_dir.clone());
    Ok(DownloadTask {
        id: format!("task_{}", uuid::Uuid::new_v4()),
        url,
        title: value_string(task_data, "title").unwrap_or_else(|| "Queued download".into()),
        uploader: value_string(task_data, "uploader"),
        duration: value_u64(task_data, "duration"),
        duration_string: value_string(task_data, "duration_string"),
        thumbnail: value_string(task_data, "thumbnail"),
        engine,
        status: TaskStatus::Queued,
        progress_percentage: 0.0,
        speed_str: "0 B/s".into(),
        speed_bytes_per_sec: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        eta_str: "--:--".into(),
        current_phase: "Queued".into(),
        format_id: value_string(task_data, "format_id").unwrap_or_else(|| if audio_only { "bestaudio".into() } else { "best".into() }),
        format_note: value_string(task_data, "format_note"),
        ext: value_string(task_data, "ext").unwrap_or_else(|| if audio_only { settings.default_audio_format.clone() } else { "mp4".into() }),
        is_audio_only: audio_only,
        audio_format: value_string(task_data, "audio_format").or_else(|| Some(settings.default_audio_format.clone())),
        audio_bitrate: value_string(task_data, "audio_bitrate").or_else(|| Some(settings.default_audio_bitrate.clone())),
        audio_sample_rate: value_u32(task_data, "audio_sample_rate").or(settings.default_audio_sample_rate),
        audio_bit_depth: value_u32(task_data, "audio_bit_depth").or(settings.default_audio_bit_depth),
        audio_channels: value_u32(task_data, "audio_channels"),
        is_lossy_source: value_bool(task_data, "is_lossy_source"),
        verified_audio_info: None,
        output_path,
        error_message: None,
        priority,
        created_at: chrono::Utc::now().to_rfc3339(),
        completed_at: None,
        retries: 0,
        max_retries: settings.max_retries,
    })
}

#[tauri::command]
pub fn create_download_task(app: AppHandle, state: State<'_, AppState>, task_data: Value) -> Result<DownloadTask, String> {
    let settings = state.settings_snapshot()?;
    let task = new_task(&task_data, &settings)?;
    state.save_task(task.clone())?;
    let _ = app.emit("task_added", &task);
    notify(&app, state.inner(), "info", "Added to download queue", &task.title, Some(task.id.clone()));
    schedule_queue(app, state.inner().clone());
    Ok(task)
}

#[tauri::command]
pub fn start_download(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<DownloadTask, String> {
    let mut task = state.task_by_id(&id)?.ok_or_else(|| "Task not found.".to_string())?;
    if matches!(task.status, TaskStatus::Completed | TaskStatus::Downloading | TaskStatus::Extracting | TaskStatus::Processing) {
        return Ok(task);
    }
    task.status = TaskStatus::Queued;
    task.current_phase = "Queued".into();
    task.error_message = None;
    state.save_task(task.clone())?;
    schedule_queue(app, state.inner().clone());
    Ok(task)
}

fn priority_rank(priority: &TaskPriority) -> u8 {
    match priority { TaskPriority::Highest => 0, TaskPriority::High => 1, TaskPriority::Normal => 2, TaskPriority::Low => 3 }
}

pub fn schedule_queue(app: AppHandle, state: AppState) {
    if state.scheduler_running.swap(true, Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn(async move {
        loop {
            let max_active = match state.settings_snapshot() {
                Ok(settings) => settings.max_concurrent_downloads.max(1) as usize,
                Err(_) => 1,
            };
            if state.active_count.load(Ordering::SeqCst) >= max_active { break; }
            let mut queued = match state.tasks_snapshot() {
                Ok(tasks) => tasks.into_iter().filter(|t| t.status == TaskStatus::Queued).collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            };
            if queued.is_empty() { break; }
            queued.sort_by_key(|t| (priority_rank(&t.priority), t.created_at.clone()));
            let Some(mut task) = queued.into_iter().next() else { break; };
            task.status = TaskStatus::Extracting;
            task.current_phase = "Starting engine".into();
            task.error_message = None;
            if state.save_task(task.clone()).is_err() { break; }
            let _ = app.emit("task_updated", &task);
            state.active_count.fetch_add(1, Ordering::SeqCst);
            let (control_tx, control_rx) = watch::channel(ControlAction::None);
            if let Ok(mut controls) = state.controls.lock() { controls.insert(task.id.clone(), control_tx); }
            let app2 = app.clone();
            let state2 = state.clone();
            tauri::async_runtime::spawn(async move {
                engines::run_download_task(app2.clone(), state2.clone(), task.clone(), control_rx).await;
                state2.active_count.fetch_sub(1, Ordering::SeqCst);
                if let Ok(mut controls) = state2.controls.lock() { controls.remove(&task.id); }
                schedule_queue(app2, state2);
            });
        }
        state.scheduler_running.store(false, Ordering::SeqCst);
        let has_queued = state.tasks_snapshot().map(|ts| ts.iter().any(|t| t.status == TaskStatus::Queued)).unwrap_or(false);
        let max_active = state.settings_snapshot().map(|s| s.max_concurrent_downloads.max(1) as usize).unwrap_or(1);
        if has_queued && state.active_count.load(Ordering::SeqCst) < max_active {
            schedule_queue(app.clone(), state.clone());
        }
    });
}

fn notify(app: &AppHandle, state: &AppState, kind: &str, title: &str, message: &str, task_id: Option<String>) {
    state.add_notification(kind, title, message, task_id);
    if let Ok(items) = state.notifications_snapshot() {
        if let Some(item) = items.first() { let _ = app.emit("notification", item); }
    }
}

#[tauri::command]
pub fn pause_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut task = state.task_by_id(&id)?.ok_or_else(|| "Task not found.".to_string())?;
    if task.status == TaskStatus::Queued {
        task.status = TaskStatus::Paused;
        task.current_phase = "Paused in queue".into();
        state.save_task(task.clone())?;
        let _ = app.emit("task_updated", &task);
        return Ok(());
    }
    let sender = state.controls.lock().map_err(|_| "Download control lock is poisoned".to_string())?.get(&id).cloned();
    if let Some(sender) = sender {
        sender.send(ControlAction::Pause).map_err(|_| "The download process is no longer controllable.".to_string())?;
        Ok(())
    } else if task.status == TaskStatus::Paused {
        Ok(())
    } else {
        Err("Task is not currently running.".into())
    }
}

#[tauri::command]
pub fn resume_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut task = state.task_by_id(&id)?.ok_or_else(|| "Task not found.".to_string())?;
    if task.status != TaskStatus::Paused { return Err("Only a paused task can be resumed.".into()); }
    task.status = TaskStatus::Queued;
    task.current_phase = "Queued to resume".into();
    task.error_message = None;
    task.speed_str = "0 B/s".into();
    task.speed_bytes_per_sec = 0.0;
    state.save_task(task.clone())?;
    let _ = app.emit("task_updated", &task);
    schedule_queue(app, state.inner().clone());
    Ok(())
}

#[tauri::command]
pub fn cancel_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut task = state.task_by_id(&id)?.ok_or_else(|| "Task not found.".to_string())?;
    let sender = state.controls.lock().map_err(|_| "Download control lock is poisoned".to_string())?.get(&id).cloned();
    if let Some(sender) = sender {
        sender.send(ControlAction::Cancel).map_err(|_| "The download process is no longer controllable.".to_string())?;
    } else {
        task.status = TaskStatus::Cancelled;
        task.current_phase = "Cancelled".into();
        task.speed_str = "0 B/s".into();
        task.speed_bytes_per_sec = 0.0;
        state.save_task(task.clone())?;
        let _ = app.emit("task_updated", &task);
    }
    Ok(())
}

#[tauri::command]
pub fn retry_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut task = state.task_by_id(&id)?.ok_or_else(|| "Task not found.".to_string())?;
    if matches!(task.status, TaskStatus::Downloading | TaskStatus::Extracting | TaskStatus::Processing) {
        return Err("Cancel the active process before retrying it.".into());
    }
    task.status = TaskStatus::Queued;
    task.progress_percentage = 0.0;
    task.downloaded_bytes = 0;
    task.total_bytes = 0;
    task.speed_str = "0 B/s".into();
    task.speed_bytes_per_sec = 0.0;
    task.eta_str = "--:--".into();
    task.current_phase = "Queued for retry".into();
    task.error_message = None;
    task.completed_at = None;
    task.retries = 0;
    state.save_task(task.clone())?;
    let _ = app.emit("task_updated", &task);
    schedule_queue(app, state.inner().clone());
    Ok(())
}

#[tauri::command]
pub fn delete_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if state.controls.lock().map_err(|_| "Download control lock is poisoned".to_string())?.contains_key(&id) {
        return Err("Cancel the active download and wait for it to stop before deleting its record.".into());
    }
    state.delete_task(&id)?;
    let _ = app.emit("task_deleted", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn pause_all_downloads(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let tasks = state.tasks_snapshot()?;
    for task in tasks {
        if task.status == TaskStatus::Queued {
            let mut t = task.clone();
            t.status = TaskStatus::Paused;
            t.current_phase = "Paused in queue".into();
            state.save_task(t.clone())?;
            let _ = app.emit("task_updated", &t);
        } else if matches!(task.status, TaskStatus::Downloading | TaskStatus::Extracting | TaskStatus::Processing) {
            if let Some(sender) = state.controls.lock().map_err(|_| "Download control lock is poisoned".to_string())?.get(&task.id).cloned() {
                let _ = sender.send(ControlAction::Pause);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn resume_all_downloads(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    for mut task in state.tasks_snapshot()? {
        if task.status == TaskStatus::Paused {
            task.status = TaskStatus::Queued;
            task.current_phase = "Queued to resume".into();
            task.error_message = None;
            state.save_task(task.clone())?;
            let _ = app.emit("task_updated", &task);
        }
    }
    schedule_queue(app, state.inner().clone());
    Ok(())
}

#[tauri::command]
pub fn clear_completed_tasks(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.clear_completed()?;
    let _ = app.emit("tasks_cleared", state.tasks_snapshot()?);
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.settings_snapshot()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<'_, AppState>, settings: Value) -> Result<AppSettings, String> {
    let current = state.settings_snapshot()?;
    let mut merged = serde_json::to_value(current).map_err(|e| e.to_string())?;
    let incoming = settings.as_object().ok_or_else(|| "Settings payload must be an object.".to_string())?;
    let map = merged.as_object_mut().ok_or_else(|| "Internal settings representation is invalid.".to_string())?;
    for (key, value) in incoming {
        if map.contains_key(key) { map.insert(key.clone(), value.clone()); }
    }
    let updated: AppSettings = serde_json::from_value(merged).map_err(|e| format!("Invalid settings: {e}"))?;
    state.save_settings(updated.clone())?;
    let _ = app.emit("settings_updated", &updated);
    Ok(updated)
}

#[tauri::command]
pub async fn get_engine_status(app: AppHandle, state: State<'_, AppState>) -> Result<crate::models::EngineStatusMap, String> {
    Ok(engines::get_engine_status(&app, state.inner()).await)
}

#[tauri::command]
pub async fn run_engine_diagnostics(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<crate::models::DiagnosticResult>, String> {
    Ok(engines::run_diagnostics(&app, state.inner()).await)
}

#[tauri::command]
pub async fn check_engine_updates(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    engines::check_engine_updates(&app, state.inner()).await
}

#[tauri::command]
pub async fn update_engine(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<EngineUpdateResult, String> {
    let result = engines::update_engine(&app, state.inner(), &name).await?;
    let _ = app.emit("engine_status_updated", engines::get_engine_status(&app, state.inner()).await);
    Ok(result)
}

#[tauri::command]
pub async fn update_all_engines(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let updates = engines::check_engine_updates(&app, state.inner()).await?;
    let object = updates.as_object().ok_or_else(|| "Upstream update response was invalid.".to_string())?;
    let mut results = Vec::new();
    for (name, item) in object {
        if item.get("updateAvailable").and_then(Value::as_bool) == Some(true) {
            match engines::update_engine(&app, state.inner(), name).await {
                Ok(result) => results.push(serde_json::to_value(result).map_err(|e| e.to_string())?),
                Err(error) => results.push(serde_json::json!({ "engine": name, "success": false, "message": error })),
            }
        }
    }
    Ok(serde_json::json!({ "success": results.iter().all(|r| r.get("success").and_then(Value::as_bool).unwrap_or(false)), "results": results }))
}

#[tauri::command]
pub fn get_notifications(state: State<'_, AppState>) -> Result<Vec<crate::models::NotificationItem>, String> {
    state.notifications_snapshot()
}

#[tauri::command]
pub fn clear_notifications(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.clear_notifications()?;
    let _ = app.emit("notifications_cleared", true);
    Ok(())
}

#[tauri::command]
pub fn get_download_history(state: State<'_, AppState>) -> Result<Vec<DownloadTask>, String> {
    state.history_snapshot()
}

#[tauri::command]
pub fn delete_download_history_entry(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.delete_history_entry(&id)
}

#[tauri::command]
pub fn clear_download_history(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.clear_download_history()?;
    let _ = app.emit("download_history_cleared", true);
    Ok(())
}

#[tauri::command]
pub fn open_downloaded_file(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_file() { return Err("The requested file does not exist.".into()); }
    #[cfg(target_os = "windows")]
    let result = StdCommand::new("explorer.exe").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let result = StdCommand::new("open").arg(&path).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let result = StdCommand::new("xdg-open").arg(&path).spawn();
    result.map(|_| ()).map_err(|e| format!("Could not open file: {e}"))
}

#[tauri::command]
pub fn reveal_download_in_folder(path: String) -> Result<(), String> {
    let requested = PathBuf::from(path);
    let target = if requested.is_file() { requested.parent().map(PathBuf::from).unwrap_or(requested) } else { requested };
    if !target.exists() { return Err("The requested path does not exist.".into()); }
    #[cfg(target_os = "windows")]
    let result = if PathBuf::from(&target).is_file() {
        StdCommand::new("explorer.exe").args(["/select,", target.to_string_lossy().as_ref()]).spawn()
    } else {
        StdCommand::new("explorer.exe").arg(&target).spawn()
    };
    #[cfg(target_os = "macos")]
    let result = StdCommand::new("open").arg(&target).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let result = StdCommand::new("xdg-open").arg(&target).spawn();
    result.map(|_| ()).map_err(|e| format!("Could not reveal path: {e}"))
}

#[tauri::command]
pub fn choose_download_directory(state: State<'_, AppState>) -> Result<String, String> {
    // The existing settings screen has a path field and does not require a native picker.
    // Returning the persisted value is deliberately explicit rather than pretending a picker opened.
    Ok(state.settings_snapshot()?.download_dir)
}
