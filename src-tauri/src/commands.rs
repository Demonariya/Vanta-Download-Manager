use crate::cookies;
use crate::engines::EngineManager;
use crate::logging;
use crate::models::{
    AppSettings, CategoryItem, CookieStatus, CookieTestResult, CookieValidationResult,
    CreateTaskPayload, DetectedBrowserInfo, DiagnosticLogInfo, DiagnosticResult, DownloadTask,
    EngineStatusMap, EngineUpdateInfo, EngineUpdateResult, ManagedEngineInfo, MediaMetadata,
    NotificationItem, TaskLogEntry, TaskPriority, TaskStatus,
};
use crate::process;
use crate::state::AppState;
use std::collections::HashMap;
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, Window};

struct InspectionDropGuard<'a> {
    state: &'a AppState,
    request_id: String,
}

impl<'a> Drop for InspectionDropGuard<'a> {
    fn drop(&mut self) {
        self.state.remove_inspection(&self.request_id);
    }
}

fn format_bytes_rust(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let idx = (bytes.log(1024.0).floor() as usize).min(units.len() - 1);
    let val = bytes / 1024_f64.powi(idx as i32);
    if idx == 0 {
        format!("{:.0} B", val)
    } else {
        format!("{:.1} {}", val, units[idx])
    }
}

fn format_duration_rust(sec: u64) -> String {
    let h = sec / 3600;
    let m = (sec % 3600) / 60;
    let s = sec % 60;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

fn resolve_unique_dest(dir: &Path, filename: &str, strategy: &str) -> (PathBuf, bool) {
    let safe_name = crate::sanitize_filename(filename);
    let final_name = if safe_name.trim().is_empty() {
        format!("download_{}.bin", chrono::Utc::now().timestamp())
    } else {
        safe_name
    };
    let candidate = dir.join(&final_name);
    if !candidate.exists() || strategy == "overwrite" {
        return (candidate, false);
    }
    if strategy == "skip" {
        if let Ok(meta) = fs::metadata(&candidate) {
            if meta.is_file() && meta.len() > 0 {
                return (candidate, true);
            }
        }
        return (candidate, false);
    }

    let stem = candidate
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = candidate
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    for i in 1..=999 {
        let next = dir.join(format!("{} ({}){}", stem, i, ext));
        if !next.exists() {
            return (next, false);
        }
    }
    (
        dir.join(format!("{}_{}{}", stem, chrono::Utc::now().timestamp(), ext)),
        false,
    )
}

#[tauri::command]
pub fn get_tasks(state: State<'_, AppState>) -> Result<Vec<DownloadTask>, String> {
    Ok(state.get_tasks())
}

#[tauri::command]
pub async fn create_task(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: CreateTaskPayload,
) -> Result<DownloadTask, String> {
    let settings = state.get_settings();
    let trimmed_url = payload.url.trim().to_string();
    let is_spotify = crate::spotify::is_spotify_url(&trimmed_url);
    let is_direct = !is_spotify && EngineManager::is_direct_file_url(&trimmed_url);
    let is_audio = payload.is_audio_only.unwrap_or(is_spotify);

    if !is_direct {
        let requires_ffmpeg = is_audio
            || settings.embed_thumbnail
            || settings.embed_metadata
            || payload.format_id.as_deref().unwrap_or("best") == "best";

        tokio::task::spawn_blocking(move || {
            EngineManager::ensure_required_engines(requires_ffmpeg, is_spotify)
        })
        .await
        .map_err(|e| format!("Engine preflight failed: {}", e))??;
    }

    let mut resolved_url = trimmed_url.clone();
    let mut resolved_title = payload.title.clone().unwrap_or_default().trim().to_string();
    let mut resolved_uploader = payload
        .uploader
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut resolved_duration = payload.duration;
    let mut resolved_duration_str = payload.duration_string.clone();
    let mut resolved_thumbnail = payload
        .thumbnail
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut resolved_album = payload
        .album
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut resolved_content_type = payload
        .content_type
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let is_placeholder_title = resolved_title.is_empty()
        || resolved_title == "Queued Download"
        || resolved_title == "Download Task"
        || resolved_title == "Queued Item"
        || resolved_title == "Spotify Track / Album"
        || resolved_title == "Spotify Music Track"
        || resolved_title == "Spotify Album / Playlist"
        || resolved_title.starts_with("Batch Item:");

    if is_spotify && (is_placeholder_title || resolved_thumbnail.is_none()) {
        let meta = crate::spotify::resolve_spotify_metadata_async(&trimmed_url, None).await?;
        if !meta.url.is_empty() {
            resolved_url = meta.url;
        }
        resolved_title = meta.title;
        if let Some(ref artists) = meta.artists {
            if !artists.is_empty() {
                resolved_uploader = Some(artists.join(", "));
            }
        }
        if resolved_uploader.is_none() {
            resolved_uploader = meta.owner.or(meta.uploader);
        }
        if resolved_duration.is_none() {
            resolved_duration = meta.duration;
        }
        if resolved_duration_str.is_none() {
            resolved_duration_str = meta.duration_string;
        }
        if resolved_thumbnail.is_none() {
            resolved_thumbnail = meta.album_artwork.or(meta.thumbnail);
        }
        if resolved_album.is_none() {
            resolved_album = meta.album;
        }
        if resolved_content_type.is_none() {
            resolved_content_type = meta.content_type;
        }
    }

    let id = format!(
        "task_{}_{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().to_string()[..5]
    );

    let engine = if is_spotify {
        "spotdl".to_string()
    } else if is_direct {
        "direct".to_string()
    } else {
        "yt-dlp".to_string()
    };

    let ext = payload.ext.unwrap_or_else(|| {
        if is_audio {
            settings.default_audio_format.clone()
        } else if is_direct {
            Path::new(&trimmed_url)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("bin")
                .split('?')
                .next()
                .unwrap_or("bin")
                .to_lowercase()
        } else {
            "mp4".to_string()
        }
    });

    let categories = state.get_categories();
    let matched_cat = payload
        .category_id
        .clone()
        .and_then(|cid| categories.iter().find(|c| c.id == cid).cloned())
        .or_else(|| {
            let clean_ext = ext.to_lowercase();
            categories
                .iter()
                .find(|c| c.extensions.iter().any(|e| e.eq_ignore_ascii_case(&clean_ext)))
                .cloned()
        });

    let max_order = state
        .get_tasks()
        .iter()
        .map(|t| t.queue_order)
        .max()
        .unwrap_or(0);
    let known_total = payload.total_bytes.unwrap_or(0);

    let task = DownloadTask {
        id: id.clone(),
        url: resolved_url,
        title: if resolved_title.is_empty() {
            "Queued Download".to_string()
        } else {
            resolved_title
        },
        uploader: resolved_uploader,
        duration: resolved_duration,
        duration_string: resolved_duration_str,
        thumbnail: resolved_thumbnail,
        album: resolved_album,
        content_type: resolved_content_type,
        engine: engine.clone(),
        status: TaskStatus::Queued,
        progress_percentage: 0.0,
        percentage_known: known_total > 0 || engine != "spotdl",
        speed_str: "0 B/s".to_string(),
        speed_bytes_per_sec: 0.0,
        avg_speed_bytes_per_sec: 0.0,
        downloaded_bytes: 0,
        total_bytes: known_total,
        remaining_bytes: known_total,
        eta_str: "--".to_string(),
        eta_seconds: None,
        elapsed_seconds: 0,
        active_connections: 0,
        last_progress_at: None,
        current_phase: "Queued".to_string(),
        format_id: payload.format_id.unwrap_or_else(|| "best".to_string()),
        format_note: payload.format_note,
        ext,
        video_codec: None,
        audio_codec: None,
        resolution_label: None,
        is_audio_only: is_audio,
        audio_format: payload
            .audio_format
            .or_else(|| Some(settings.default_audio_format.clone())),
        audio_bitrate: payload
            .audio_bitrate
            .or_else(|| Some(settings.default_audio_bitrate.clone())),
        audio_sample_rate: payload
            .audio_sample_rate
            .or(settings.default_audio_sample_rate),
        audio_bit_depth: payload.audio_bit_depth.or(settings.default_audio_bit_depth),
        audio_channels: payload.audio_channels,
        is_lossy_source: payload.is_lossy_source.or(Some(is_spotify)),
        verified_audio_info: None,
        verified_sha256: None,
        expected_sha256: payload.expected_sha256,
        checksum_verified: None,
        output_path: payload
            .output_path
            .or_else(|| matched_cat.as_ref().and_then(|c| c.destination_dir.clone()))
            .unwrap_or_else(|| settings.download_dir.clone()),
        custom_filename: payload.custom_filename,
        category_id: matched_cat.map(|c| c.id),
        playlist_mode: payload.playlist_mode,
        error_message: None,
        logs: vec![TaskLogEntry {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: "info".to_string(),
            message: format!("Task queued via {}", engine),
        }],
        priority: payload.priority.unwrap_or(TaskPriority::Normal),
        queue_order: max_order + 1,
        created_at: chrono::Utc::now().to_rfc3339(),
        started_at: None,
        completed_at: None,
        retries: 0,
        max_retries: settings.max_retries,
    };

    state.upsert_task(&task);
    let _ = app.emit("task_added", &task);

    logging::info("queue", &format!("Created task '{}' ({})", task.id, task.engine));
    schedule_next(&app, &state);

    Ok(task)
}

#[tauri::command]
pub fn pause_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.trigger_direct_cancel(&id);
    let removed_pid = {
        let mut procs = state
            .active_processes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        procs.remove(&id)
    };
    if let Some(pid) = removed_pid {
        process::kill_process_tree(pid);
    }

    if let Some(mut t) = state.get_task_by_id(&id) {
        t.status = TaskStatus::Paused;
        t.current_phase = "Paused by user".to_string();
        t.speed_str = "0 B/s".to_string();
        t.speed_bytes_per_sec = 0.0;
        t.eta_seconds = None;
        t.eta_str = "--".to_string();
        t.active_connections = 0;
        state.upsert_task(&t);
        let _ = app.emit("task_updated", &t);
    }

    schedule_next(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn resume_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(mut t) = state.get_task_by_id(&id) {
        t.status = TaskStatus::Queued;
        t.current_phase = "Queued to resume".to_string();
        state.upsert_task(&t);
        let _ = app.emit("task_updated", &t);
        schedule_next(&app, &state);
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.trigger_direct_cancel(&id);
    let removed_pid = {
        let mut procs = state
            .active_processes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        procs.remove(&id)
    };
    if let Some(pid) = removed_pid {
        process::kill_process_tree(pid);
    }

    if let Some(mut t) = state.get_task_by_id(&id) {
        t.status = TaskStatus::Cancelled;
        t.current_phase = "Cancelled".to_string();
        t.speed_str = "0 B/s".to_string();
        t.speed_bytes_per_sec = 0.0;
        t.eta_seconds = None;
        t.eta_str = "--".to_string();
        t.active_connections = 0;
        state.upsert_task(&t);
        let _ = app.emit("task_updated", &t);
    }

    schedule_next(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn retry_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(mut t) = state.get_task_by_id(&id) {
        t.status = TaskStatus::Queued;
        t.current_phase = "Queued for retry".to_string();
        t.error_message = None;
        t.retries = 0;
        t.progress_percentage = 0.0;
        t.speed_str = "0 B/s".to_string();
        t.speed_bytes_per_sec = 0.0;
        t.eta_seconds = None;
        t.eta_str = "--".to_string();
        state.upsert_task(&t);
        let _ = app.emit("task_updated", &t);
        schedule_next(&app, &state);
    }
    Ok(())
}

#[tauri::command]
pub fn delete_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    delete_file: Option<bool>,
) -> Result<(), String> {
    state.trigger_direct_cancel(&id);
    let removed_pid = {
        let mut procs = state
            .active_processes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        procs.remove(&id)
    };
    if let Some(pid) = removed_pid {
        process::kill_process_tree(pid);
    }
    state.delete_task_with_options(&id, delete_file.unwrap_or(false));
    let _ = app.emit("task_deleted", serde_json::json!({ "id": id }));
    schedule_next(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn delete_downloaded_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let removed = state.delete_downloaded_file(&id);
    if let Some(t) = state.get_task_by_id(&id) {
        let _ = app.emit("task_updated", &t);
    }
    Ok(removed)
}

#[tauri::command]
pub fn pause_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let pids: Vec<u32> = {
        let mut procs = state
            .active_processes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        procs.drain().map(|(_id, pid)| pid).collect()
    };
    for pid in pids {
        process::kill_process_tree(pid);
    }
    {
        let mut directs = state
            .active_direct_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (_id, flag) in directs.drain() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    let tasks = state.get_tasks();
    for mut t in tasks {
        if t.status.is_active() || t.status == TaskStatus::Queued {
            t.status = TaskStatus::Paused;
            t.current_phase = "Paused".to_string();
            t.speed_str = "0 B/s".to_string();
            t.speed_bytes_per_sec = 0.0;
            t.eta_seconds = None;
            t.eta_str = "--".to_string();
            t.active_connections = 0;
            state.upsert_task(&t);
            let _ = app.emit("task_updated", &t);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn resume_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let tasks = state.get_tasks();
    for mut t in tasks {
        if t.status == TaskStatus::Paused {
            t.status = TaskStatus::Queued;
            t.current_phase = "Queued".to_string();
            state.upsert_task(&t);
            let _ = app.emit("task_updated", &t);
        }
    }
    schedule_next(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn clear_completed(
    app: AppHandle,
    state: State<'_, AppState>,
    delete_files: Option<bool>,
) -> Result<(), String> {
    state.clear_completed_tasks_with_options(delete_files.unwrap_or(false));
    let remaining = state.get_tasks();
    let _ = app.emit("tasks_cleared", &remaining);
    Ok(())
}

#[tauri::command]
pub fn clear_failed(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.clear_failed_tasks();
    let remaining = state.get_tasks();
    let _ = app.emit("tasks_cleared", &remaining);
    Ok(())
}

#[tauri::command]
pub fn clear_all(
    app: AppHandle,
    state: State<'_, AppState>,
    delete_files: Option<bool>,
) -> Result<(), String> {
    let _ = pause_all(app.clone(), state.clone());
    state.clear_all_tasks(delete_files.unwrap_or(false));
    let remaining = state.get_tasks();
    let _ = app.emit("tasks_cleared", &remaining);
    Ok(())
}

#[tauri::command]
pub fn move_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    direction: String,
) -> Result<Vec<DownloadTask>, String> {
    let updated = state.move_task_order(&id, &direction);
    let _ = app.emit("tasks_cleared", &updated);
    Ok(updated)
}

#[tauri::command]
pub fn update_task_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    priority: Option<TaskPriority>,
    category_id: Option<String>,
    custom_filename: Option<String>,
) -> Result<DownloadTask, String> {
    let mut task = state
        .get_task_by_id(&id)
        .ok_or_else(|| "Task not found".to_string())?;
    if let Some(p) = priority {
        task.priority = p;
    }
    if category_id.is_some() {
        task.category_id = category_id.filter(|s| !s.trim().is_empty());
    }
    if custom_filename.is_some() {
        task.custom_filename = custom_filename.filter(|s| !s.trim().is_empty());
    }
    state.upsert_task(&task);
    let _ = app.emit("task_updated", &task);
    Ok(task)
}

#[tauri::command]
pub fn rename_task_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    filename: String,
) -> Result<DownloadTask, String> {
    let updated = state.rename_task_file(&id, &filename)?;
    let _ = app.emit("task_updated", &updated);
    Ok(updated)
}

#[tauri::command]
pub fn verify_task_checksum(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    expected_sha256: Option<String>,
) -> Result<serde_json::Value, String> {
    let (task, sha256, matches) = state.verify_task_checksum(&id, expected_sha256)?;
    let _ = app.emit("task_updated", &task);
    Ok(serde_json::json!({
        "task": task,
        "sha256": sha256,
        "matches": matches
    }))
}

#[tauri::command]
pub fn bulk_task_action(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    action: String,
    delete_files: Option<bool>,
) -> Result<(), String> {
    for id in ids {
        match action.as_str() {
            "pause" => {
                let _ = pause_task(app.clone(), state.clone(), id);
            }
            "resume" => {
                let _ = resume_task(app.clone(), state.clone(), id);
            }
            "retry" => {
                let _ = retry_task(app.clone(), state.clone(), id);
            }
            "cancel" => {
                let _ = cancel_task(app.clone(), state.clone(), id);
            }
            "delete" => {
                let _ = delete_task(app.clone(), state.clone(), id, delete_files);
            }
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_categories(state: State<'_, AppState>) -> Result<Vec<CategoryItem>, String> {
    Ok(state.get_categories())
}

#[tauri::command]
pub fn save_category(
    state: State<'_, AppState>,
    category: CategoryItem,
) -> Result<CategoryItem, String> {
    Ok(state.save_category(category))
}

#[tauri::command]
pub fn delete_category(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.delete_category(&id);
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.get_settings())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    state.save_settings(&settings);
    let _ = app.emit("settings_updated", &settings);
    Ok(settings)
}

#[tauri::command]
pub fn get_notifications(state: State<'_, AppState>) -> Result<Vec<NotificationItem>, String> {
    Ok(state.get_notifications())
}

#[tauri::command]
pub fn clear_notifications(state: State<'_, AppState>) -> Result<(), String> {
    state.clear_notifications();
    Ok(())
}

const ENGINE_STATUS_CACHE_TTL: Duration = Duration::from_secs(15);

#[tauri::command]
pub async fn get_engine_status(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> Result<EngineStatusMap, String> {
    let force = force_refresh.unwrap_or(false);
    if !force {
        let cached = state
            .cached_engine_status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some((captured_at, status)) = cached {
            if captured_at.elapsed() < ENGINE_STATUS_CACHE_TTL {
                return Ok(status);
            }
        }
    }

    if state.is_scanning_engines.swap(true, Ordering::SeqCst) {
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if !state.is_scanning_engines.load(Ordering::SeqCst) {
                let cached = state
                    .cached_engine_status
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Some((_ts, status)) = cached {
                    return Ok(status);
                }
                break;
            }
        }
        state.is_scanning_engines.store(true, Ordering::SeqCst);
    }

    let scan_res = tokio::task::spawn_blocking(EngineManager::get_engine_status)
        .await
        .map_err(|e| format!("Engine scan task failed: {}", e));

    state.is_scanning_engines.store(false, Ordering::SeqCst);

    let status = scan_res?;
    {
        let mut cache = state
            .cached_engine_status
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *cache = Some((Instant::now(), status.clone()));
    }
    Ok(status)
}

#[tauri::command]
pub async fn get_managed_engine_info() -> Result<ManagedEngineInfo, String> {
    tokio::task::spawn_blocking(EngineManager::get_managed_engine_info)
        .await
        .map_err(|e| format!("Managed engine lookup failed: {}", e))
}

#[tauri::command]
pub async fn run_diagnostics(state: State<'_, AppState>) -> Result<Vec<DiagnosticResult>, String> {
    if state.is_running_diagnostics.swap(true, Ordering::SeqCst) {
        return Err("Diagnostics check is already running.".to_string());
    }

    let res = tokio::task::spawn_blocking(EngineManager::run_diagnostics)
        .await
        .map_err(|e| format!("Diagnostics task failed: {}", e));

    state.is_running_diagnostics.store(false, Ordering::SeqCst);
    res
}

#[tauri::command]
pub async fn check_engine_updates() -> Result<HashMap<String, EngineUpdateInfo>, String> {
    let status = tokio::task::spawn_blocking(EngineManager::get_engine_status)
        .await
        .map_err(|e| format!("Update check failed: {}", e))?;

    let mut updates = HashMap::new();
    updates.insert(
        "ytdlp".to_string(),
        EngineUpdateInfo {
            current_version: status.ytdlp.version.clone(),
            latest_version: status.ytdlp.version,
            update_available: !status.ytdlp.available,
        },
    );
    updates.insert(
        "spotdl".to_string(),
        EngineUpdateInfo {
            current_version: status.spotdl.version.clone(),
            latest_version: status.spotdl.version,
            update_available: !status.spotdl.available,
        },
    );
    updates.insert(
        "ffmpeg".to_string(),
        EngineUpdateInfo {
            current_version: status.ffmpeg.version.clone(),
            latest_version: status.ffmpeg.version,
            update_available: !status.ffmpeg.available,
        },
    );
    updates.insert(
        "ffprobe".to_string(),
        EngineUpdateInfo {
            current_version: status.ffprobe.version.clone(),
            latest_version: status.ffprobe.version,
            update_available: !status.ffprobe.available,
        },
    );
    Ok(updates)
}

#[tauri::command]
pub async fn install_engine(
    app: AppHandle,
    name: String,
    force: Option<bool>,
) -> Result<EngineUpdateResult, String> {
    Ok(EngineManager::install_engine_async(Some(&app), &name, force.unwrap_or(false)).await)
}

#[tauri::command]
pub async fn install_all_engines(
    app: AppHandle,
    include_spotdl: Option<bool>,
    force: Option<bool>,
) -> Result<Vec<EngineUpdateResult>, String> {
    Ok(EngineManager::install_all_required_async(
        Some(&app),
        include_spotdl.unwrap_or(true),
        force.unwrap_or(false),
    )
    .await)
}

#[tauri::command]
pub async fn update_engine(app: AppHandle, name: String) -> Result<EngineUpdateResult, String> {
    Ok(EngineManager::update_engine_async(Some(&app), &name).await)
}

#[tauri::command]
pub async fn update_all_engines(app: AppHandle) -> Result<Vec<EngineUpdateResult>, String> {
    Ok(EngineManager::install_all_required_async(Some(&app), true, true).await)
}

#[tauri::command]
pub async fn remove_managed_engine(
    state: State<'_, AppState>,
    name: String,
) -> Result<EngineUpdateResult, String> {
    let res = tokio::task::spawn_blocking(move || EngineManager::remove_managed_engine(&name))
        .await
        .map_err(|e| format!("Failed removing engine: {}", e))?;
    let mut cache = state
        .cached_engine_status
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *cache = None;
    Ok(res)
}

#[tauri::command]
pub async fn inspect_url(
    state: State<'_, AppState>,
    url: String,
    request_id: Option<String>,
    include_playlist: Option<bool>,
) -> Result<MediaMetadata, String> {
    let validated_url = EngineManager::validate_inspection_url(&url)?;
    let req_id = request_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("insp_{}", uuid::Uuid::new_v4()));

    let tracked = state.register_inspection(&req_id);
    let _guard = InspectionDropGuard {
        state: state.inner(),
        request_id: req_id.clone(),
    };

    if crate::spotify::is_spotify_url(&validated_url) {
        return crate::spotify::resolve_spotify_metadata_async(
            &validated_url,
            Some(tracked.cancelled),
        )
        .await;
    }

    let settings = state.get_settings();
    if EngineManager::is_direct_file_url(&validated_url) {
        return EngineManager::inspect_direct_url_async(&validated_url, &settings).await;
    }

    tokio::task::spawn_blocking(move || {
        EngineManager::inspect_url_with_tracking_opts(
            &req_id,
            &validated_url,
            &settings,
            Some(tracked.cancelled),
            Some(tracked.pid),
            include_playlist,
        )
    })
    .await
    .map_err(|e| format!("URL inspection worker panicked: {}", e))?
}

#[tauri::command]
pub fn cancel_inspection(state: State<'_, AppState>, request_id: String) -> Result<bool, String> {
    Ok(state.cancel_inspection(&request_id))
}

#[tauri::command]
pub fn get_cookie_status(state: State<'_, AppState>) -> Result<CookieStatus, String> {
    let settings = state.get_settings();
    Ok(cookies::get_cookie_status(&settings))
}

#[tauri::command]
pub fn validate_cookies_text(content: String) -> Result<CookieValidationResult, String> {
    Ok(cookies::validate_netscape_cookies(&content))
}

#[tauri::command]
pub fn save_cookies(
    app: AppHandle,
    state: State<'_, AppState>,
    content: String,
) -> Result<CookieStatus, String> {
    let status = cookies::save_cookies_file(&state, &content)?;
    let updated_settings = state.get_settings();
    let _ = app.emit("settings_updated", &updated_settings);
    Ok(status)
}

#[tauri::command]
pub fn remove_cookies(app: AppHandle, state: State<'_, AppState>) -> Result<CookieStatus, String> {
    let status = cookies::remove_cookies_file(&state)?;
    let updated_settings = state.get_settings();
    let _ = app.emit("settings_updated", &updated_settings);
    Ok(status)
}

#[tauri::command]
pub fn detect_browsers() -> Result<Vec<DetectedBrowserInfo>, String> {
    Ok(cookies::detect_installed_browsers())
}

#[tauri::command]
pub async fn test_cookie_extraction(
    state: State<'_, AppState>,
    browser: Option<String>,
    profile: Option<String>,
    test_url: Option<String>,
) -> Result<CookieTestResult, String> {
    let settings = state.get_settings();
    tokio::task::spawn_blocking(move || {
        cookies::test_cookie_extraction(
            &settings,
            browser.as_deref(),
            profile.as_deref(),
            test_url.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Cookie test failed: {}", e))
}

#[tauri::command]
pub fn get_diagnostic_log_info(max_lines: Option<usize>) -> Result<DiagnosticLogInfo, String> {
    Ok(logging::get_diagnostic_log_info(max_lines.unwrap_or(100)))
}

#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    let dir = logging::logs_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed creating logs folder: {}", e))?;
    open_file_or_folder(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_file_or_folder(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err("File or directory does not exist".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        if target.is_file() {
            Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| format!("Failed opening Explorer: {}", e))?;
        } else {
            Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed opening Explorer: {}", e))?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if target.is_file() {
            Command::new("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| format!("Failed opening Finder: {}", e))?;
        } else {
            Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed opening Finder: {}", e))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let open_target = if target.is_file() {
            target
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path)
        } else {
            path
        };
        Command::new("xdg-open")
            .arg(open_target)
            .spawn()
            .map_err(|e| format!("Failed opening path: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn select_directory() -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_maximize_toggle(window: Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn window_close(window: Window, state: State<'_, AppState>) -> Result<(), String> {
    state.safe_shutdown();
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_safe_shutdown(state: State<'_, AppState>) -> Result<(), String> {
    state.safe_shutdown();
    Ok(())
}

pub fn schedule_next(app: &AppHandle, state: &AppState) {
    if state.is_shutting_down.load(Ordering::SeqCst) {
        return;
    }

    let settings = state.get_settings();
    let tasks = state.get_tasks();

    let active_count = tasks.iter().filter(|t| t.status.is_active()).count();
    let max_concurrent = settings.max_concurrent_downloads.max(1) as usize;
    let available_slots = max_concurrent.saturating_sub(active_count);
    if available_slots == 0 {
        return;
    }

    let mut queued: Vec<DownloadTask> = tasks
        .into_iter()
        .filter(|t| t.status == TaskStatus::Queued)
        .collect();

    queued.sort_by(|a, b| {
        a.priority
            .order_rank()
            .cmp(&b.priority.order_rank())
            .then_with(|| a.queue_order.cmp(&b.queue_order))
            .then_with(|| a.created_at.cmp(&b.created_at))
    });

    for mut next_task in queued.into_iter().take(available_slots) {
        next_task.status = TaskStatus::Connecting;
        next_task.current_phase = "Starting engine...".to_string();
        if next_task.started_at.is_none() {
            next_task.started_at = Some(chrono::Utc::now().to_rfc3339());
        }
        state.upsert_task(&next_task);
        let _ = app.emit("task_updated", &next_task);

        let app_clone = app.clone();
        let task_id = next_task.id.clone();
        tokio::spawn(async move {
            run_download_task(app_clone, task_id).await;
        });
    }
}

async fn run_download_task(app: AppHandle, task_id: String) {
    let is_direct = {
        let state = app.state::<AppState>();
        state
            .get_task_by_id(&task_id)
            .map(|t| t.engine == "direct")
            .unwrap_or(false)
    };

    if is_direct {
        run_direct_download_task(&app, &task_id).await;
    } else {
        let app_for_blocking = app.clone();
        let tid_for_blocking = task_id.clone();
        let _ = tokio::task::spawn_blocking(move || {
            run_download_task_blocking(&app_for_blocking, &tid_for_blocking);
        })
        .await;
    }

    let state = app.state::<AppState>();
    schedule_next(&app, &state);
}

async fn run_direct_download_task(app: &AppHandle, task_id: &str) {
    let state = app.state::<AppState>();
    let mut task = match state.get_task_by_id(task_id) {
        Some(t) => t,
        None => return,
    };

    let settings = state.get_settings();
    let cancel_flag = state.register_direct_cancel(task_id);

    let out_dir = PathBuf::from(&task.output_path);
    if let Err(e) = fs::create_dir_all(&out_dir) {
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(format!("Failed creating output directory: {}", e));
        state.remove_direct_cancel(task_id);
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let preferred_name = task
        .custom_filename
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if task.title.contains('.') {
                task.title.clone()
            } else {
                format!("{}.{}", task.title, task.ext)
            }
        });

    let (dest_path, skipped) =
        resolve_unique_dest(&out_dir, &preferred_name, &settings.conflict_strategy);

    if skipped {
        let size = fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
        task.status = TaskStatus::Completed;
        task.progress_percentage = 100.0;
        task.percentage_known = true;
        task.downloaded_bytes = size;
        task.total_bytes = size;
        task.remaining_bytes = 0;
        task.output_path = dest_path.to_string_lossy().to_string();
        task.completed_at = Some(chrono::Utc::now().to_rfc3339());
        task.eta_str = "Finished".to_string();
        task.current_phase = "Completed (existing file skipped)".to_string();
        state.remove_direct_cancel(task_id);
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let part_path = PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
    let existing_offset = fs::metadata(&part_path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .unwrap_or(0);

    let ua = settings
        .user_agent
        .clone()
        .unwrap_or_else(|| "Mozilla/5.0".to_string());
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(ua)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            task.status = TaskStatus::Failed;
            task.error_message = Some(format!("HTTP client error: {}", e));
            state.remove_direct_cancel(task_id);
            state.upsert_task(&task);
            let _ = app.emit("task_updated", &task);
            return;
        }
    };

    let mut req = client.get(&task.url);
    if existing_offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={}-", existing_offset));
    }

    let mut res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            task.status = TaskStatus::Failed;
            task.current_phase = "Failed".to_string();
            task.error_message = Some(format!("Network error: {}", e));
            state.remove_direct_cancel(task_id);
            state.upsert_task(&task);
            let _ = app.emit("task_updated", &task);
            return;
        }
    };

    let status_code = res.status().as_u16();
    if !res.status().is_success() {
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(format!("HTTP {} returned from remote server.", status_code));
        state.remove_direct_cancel(task_id);
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let is_partial = status_code == 206;
    let mut downloaded = if is_partial { existing_offset } else { 0 };
    let mut total_bytes: u64 = 0;
    if is_partial {
        if let Some(cr) = res
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
        {
            if let Some((_, tot)) = cr.rsplit_once('/') {
                total_bytes = tot.trim().parse().unwrap_or(0);
            }
        }
    }
    if total_bytes == 0 {
        if let Some(cl) = res
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
        {
            let cl_val: u64 = cl.trim().parse().unwrap_or(0);
            total_bytes = if is_partial { downloaded + cl_val } else { cl_val };
        }
    }

    let mut file = match fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(is_partial)
        .truncate(!is_partial)
        .open(&part_path)
    {
        Ok(f) => f,
        Err(e) => {
            task.status = TaskStatus::Failed;
            task.error_message = Some(format!("Failed opening part file: {}", e));
            state.remove_direct_cancel(task_id);
            state.upsert_task(&task);
            let _ = app.emit("task_updated", &task);
            return;
        }
    };

    if !is_partial {
        let _ = file.seek(SeekFrom::Start(0));
    }

    let started = Instant::now();
    let mut last_sample_time = Instant::now();
    let mut last_sample_bytes = downloaded;
    let mut ema_speed: f64 = 0.0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::SeqCst) || state.is_shutting_down.load(Ordering::SeqCst) {
            state.remove_direct_cancel(task_id);
            return;
        }

        match res.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk) {
                    task.status = TaskStatus::Failed;
                    task.error_message = Some(format!("Disk write error: {}", e));
                    state.remove_direct_cancel(task_id);
                    state.upsert_task(&task);
                    let _ = app.emit("task_updated", &task);
                    return;
                }
                downloaded += chunk.len() as u64;

                if last_emit.elapsed() >= Duration::from_millis(250) {
                    let dt = last_sample_time.elapsed().as_secs_f64().max(0.05);
                    let inst = (downloaded.saturating_sub(last_sample_bytes) as f64) / dt;
                    ema_speed = if ema_speed == 0.0 {
                        inst
                    } else {
                        0.3 * inst + 0.7 * ema_speed
                    };
                    last_sample_time = Instant::now();
                    last_sample_bytes = downloaded;
                    last_emit = Instant::now();

                    let elapsed = started.elapsed().as_secs();
                    let remaining = total_bytes.saturating_sub(downloaded);
                    let pct_known = total_bytes > 0;
                    let pct = if total_bytes > 0 {
                        ((downloaded as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
                    } else {
                        0.0
                    };
                    let eta_sec = if total_bytes > 0 && ema_speed >= 1.0 && remaining > 0 {
                        Some((remaining as f64 / ema_speed).ceil() as u64)
                    } else {
                        None
                    };

                    task.status = TaskStatus::Downloading;
                    task.current_phase = "Downloading".to_string();
                    task.downloaded_bytes = downloaded;
                    task.total_bytes = total_bytes;
                    task.remaining_bytes = remaining;
                    task.percentage_known = pct_known;
                    task.progress_percentage = pct;
                    task.speed_bytes_per_sec = ema_speed;
                    task.avg_speed_bytes_per_sec = if elapsed > 0 {
                        downloaded as f64 / elapsed as f64
                    } else {
                        ema_speed
                    };
                    task.speed_str = format!("{}/s", format_bytes_rust(ema_speed));
                    task.eta_seconds = eta_sec;
                    task.eta_str = eta_sec
                        .map(format_duration_rust)
                        .unwrap_or_else(|| "--".to_string());
                    task.elapsed_seconds = elapsed;
                    task.active_connections = 1;
                    task.last_progress_at = Some(chrono::Utc::now().to_rfc3339());
                    state.upsert_task(&task);
                    let _ = app.emit("task_updated", &task);
                }
            }
            Ok(None) => break,
            Err(e) => {
                task.status = TaskStatus::Failed;
                task.error_message = Some(format!("Stream read error: {}", e));
                state.remove_direct_cancel(task_id);
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
        }
    }

    let _ = file.flush();
    drop(file);
    state.remove_direct_cancel(task_id);

    if cancel_flag.load(Ordering::SeqCst) {
        return;
    }

    let part_size = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    if part_size == 0 || (total_bytes > 0 && part_size < total_bytes) {
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some("Downloaded file incomplete or empty (0 bytes).".to_string());
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    if settings.conflict_strategy == "overwrite" && dest_path.exists() {
        let _ = fs::remove_file(&dest_path);
    }
    if let Err(e) = fs::rename(&part_path, &dest_path) {
        task.status = TaskStatus::Failed;
        task.error_message = Some(format!("Failed finalizing output file: {}", e));
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    task.output_path = dest_path.to_string_lossy().to_string();
    task.status = TaskStatus::Verifying;
    task.current_phase = "Verifying SHA-256 integrity...".to_string();
    state.upsert_task(&task);
    let _ = app.emit("task_updated", &task);

    if let Ok((verified_task, _sha, matches)) = state.verify_task_checksum(task_id, None) {
        task = verified_task;
        if matches == Some(false) {
            task.status = TaskStatus::Failed;
            task.current_phase = "Checksum verification failed".to_string();
            task.error_message = Some("SHA-256 checksum mismatch against expected value.".to_string());
            state.upsert_task(&task);
            let _ = app.emit("task_updated", &task);
            return;
        }
    }

    let total_elapsed = started.elapsed().as_secs();
    task.status = TaskStatus::Completed;
    task.progress_percentage = 100.0;
    task.percentage_known = true;
    task.downloaded_bytes = part_size;
    task.total_bytes = part_size;
    task.remaining_bytes = 0;
    task.elapsed_seconds = total_elapsed;
    task.speed_bytes_per_sec = 0.0;
    task.avg_speed_bytes_per_sec = if total_elapsed > 0 {
        part_size as f64 / total_elapsed as f64
    } else {
        part_size as f64
    };
    task.speed_str = "0 B/s".to_string();
    task.eta_seconds = Some(0);
    task.eta_str = "Finished".to_string();
    task.active_connections = 0;
    task.current_phase = "Completed".to_string();
    task.completed_at = Some(chrono::Utc::now().to_rfc3339());
    state.upsert_task(&task);
    let _ = app.emit("task_updated", &task);

    let notif = NotificationItem {
        id: format!("notif_{}", chrono::Utc::now().timestamp_millis()),
        r#type: "success".to_string(),
        title: "Download Complete".to_string(),
        message: format!("'{}' downloaded successfully.", task.title),
        timestamp: chrono::Utc::now().to_rfc3339(),
        task_id: Some(task.id.clone()),
    };
    state.add_notification(&notif);
    let _ = app.emit("notification", &notif);
}

fn find_recent_output_file(dir: &Path, started_at_unix: i64, is_audio: bool) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let audio_exts = ["mp3", "flac", "wav", "m4a", "aac", "opus", "ogg"];
    let media_exts = [
        "mp4", "mkv", "webm", "mov", "avi", "m4v", "flv", "mp3", "flac", "m4a", "opus",
    ];
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let valid_ext = if is_audio {
            audio_exts.contains(&ext.as_str())
        } else {
            media_exts.contains(&ext.as_str())
        };
        if !valid_ext {
            continue;
        }
        if let Ok(meta) = fs::metadata(&p) {
            if meta.len() == 0 {
                continue;
            }
            if let Ok(mtime) = meta.modified() {
                let mtime_secs = mtime
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                if mtime_secs + 3 >= started_at_unix {
                    let replace = best
                        .as_ref()
                        .map(|(prev_t, _)| mtime > *prev_t)
                        .unwrap_or(true);
                    if replace {
                        best = Some((mtime, p));
                    }
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

fn run_download_task_blocking(app: &AppHandle, task_id: &str) {
    let state = app.state::<AppState>();
    let mut task = match state.get_task_by_id(task_id) {
        Some(t) => t,
        None => return,
    };

    if matches!(task.status, TaskStatus::Paused | TaskStatus::Cancelled)
        || state.is_shutting_down.load(Ordering::SeqCst)
    {
        return;
    }

    let settings = state.get_settings();
    let is_spotdl = task.engine == "spotdl" || crate::spotify::is_spotify_url(&task.url);
    let requires_ffmpeg = task.is_audio_only
        || is_spotdl
        || settings.embed_thumbnail
        || settings.embed_metadata
        || task.format_id == "best";

    if let Err(err_msg) = EngineManager::ensure_required_engines(requires_ffmpeg, is_spotdl) {
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(err_msg);
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let out_dir = PathBuf::from(&task.output_path);
    if let Err(e) = fs::create_dir_all(&out_dir) {
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(format!("Failed creating output directory: {}", e));
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let custom_stem = task
        .custom_filename
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let cleaned = crate::sanitize_filename(s);
            Path::new(&cleaned)
                .file_stem()
                .and_then(|st| st.to_str())
                .unwrap_or(&cleaned)
                .to_string()
        });

    let (exec_path, args) = if is_spotdl {
        let spotdl_path = match EngineManager::find_executable("spotdl") {
            Some(p) => p,
            None => {
                task.status = TaskStatus::Failed;
                task.error_message = Some("spotDL executable not found.".to_string());
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
        };

        let target_url = match crate::spotify::try_parse_spotify_input(&task.url) {
            Some(crate::spotify::ParsedSpotifyInput::Resource { canonical_url, .. }) => {
                canonical_url
            }
            Some(crate::spotify::ParsedSpotifyInput::Invalid { error }) => {
                task.status = TaskStatus::Failed;
                task.error_message = Some(error);
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
            _ => task.url.clone(),
        };

        let format = task
            .audio_format
            .clone()
            .unwrap_or_else(|| settings.default_audio_format.clone());
        let bitrate = task
            .audio_bitrate
            .clone()
            .unwrap_or_else(|| settings.default_audio_bitrate.clone());

        let output_template = if let Some(stem) = custom_stem {
            out_dir.join(format!("{}.{{output-ext}}", stem))
        } else if matches!(
            task.content_type.as_deref(),
            Some("album") | Some("playlist")
        ) {
            out_dir
                .join("{list-name}")
                .join("{artists} - {title}.{output-ext}")
        } else {
            out_dir.join("{artists} - {title}.{output-ext}")
        };

        let args = vec![
            "download".to_string(),
            target_url,
            "--output".to_string(),
            output_template.to_string_lossy().to_string(),
            "--format".to_string(),
            format,
            "--bitrate".to_string(),
            bitrate,
            "--log-level".to_string(),
            "INFO".to_string(),
        ];
        (spotdl_path, args)
    } else {
        let ytdlp_path = match EngineManager::find_executable("yt-dlp") {
            Some(p) => p,
            None => {
                task.status = TaskStatus::Failed;
                task.error_message = Some("yt-dlp executable not found.".to_string());
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
        };

        let template = if let Some(stem) = custom_stem {
            out_dir.join(format!("{}.%(ext)s", stem))
        } else {
            out_dir.join(&settings.filename_template)
        };

        let mut args = vec![
            "--newline".to_string(),
            "--no-colors".to_string(),
            "--progress-template".to_string(),
            "%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s".to_string(),
            "--print".to_string(),
            "after_move:VANTA_OUTPUT_FILE:%(filepath)s".to_string(),
            "-o".to_string(),
            template.to_string_lossy().to_string(),
            "--retries".to_string(),
            "10".to_string(),
            "--fragment-retries".to_string(),
            "10".to_string(),
            "--file-access-retries".to_string(),
            "5".to_string(),
            "--socket-timeout".to_string(),
            "30".to_string(),
        ];

        if task.playlist_mode.as_deref() == Some("single") {
            args.push("--no-playlist".to_string());
        } else if task.playlist_mode.as_deref() == Some("playlist") {
            args.push("--yes-playlist".to_string());
        }

        if settings.conflict_strategy == "overwrite" {
            args.push("--force-overwrites".to_string());
        } else {
            args.push("--no-overwrites".to_string());
        }

        match EngineManager::build_ytdlp_request_args(&task.url, &settings) {
            Ok(req_args) => args.extend(req_args),
            Err(cookie_err) => {
                task.status = TaskStatus::Failed;
                task.error_message = Some(cookie_err);
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
        }

        if !settings.proxy_url.trim().is_empty() {
            args.push("--proxy".to_string());
            args.push(settings.proxy_url.trim().to_string());
        }

        if settings.global_bandwidth_limit_kbps > 0 {
            args.push("--limit-rate".to_string());
            args.push(format!("{}K", settings.global_bandwidth_limit_kbps));
        } else if settings.per_task_bandwidth_limit_kbps > 0 {
            args.push("--limit-rate".to_string());
            args.push(format!("{}K", settings.per_task_bandwidth_limit_kbps));
        }

        if settings.fragment_concurrency > 1 {
            args.push("-N".to_string());
            args.push(settings.fragment_concurrency.to_string());
        }

        if task.retries > 0 {
            args.push("--no-cache-dir".to_string());
            args.push("--extractor-args".to_string());
            args.push("youtube:player_client=default,web,android".to_string());
        }

        if task.is_audio_only {
            args.push("-x".to_string());
            let fmt = task
                .audio_format
                .clone()
                .unwrap_or_else(|| "mp3".to_string());
            args.push("--audio-format".to_string());
            args.push(fmt);
            if let Some(ref q) = task.audio_bitrate {
                args.push("--audio-quality".to_string());
                args.push(q.clone());
            }
            if task.audio_sample_rate.is_some() || task.audio_bit_depth.is_some() {
                let mut pp = "ExtractAudio:".to_string();
                if let Some(sr) = task.audio_sample_rate {
                    pp.push_str(&format!(" -ar {}", sr));
                }
                if let Some(24) = task.audio_bit_depth {
                    pp.push_str(" -sample_fmt s24");
                }
                args.push("--postprocessor-args".to_string());
                args.push(pp);
            }
        } else {
            let selector = if task.format_id == "best" || task.format_id.trim().is_empty() {
                "bestvideo+bestaudio/best".to_string()
            } else if task.format_id.contains('+') || task.format_id.contains('/') {
                task.format_id.clone()
            } else {
                format!("{}+bestaudio/best", task.format_id)
            };
            args.push("-f".to_string());
            args.push(selector);
            args.push("--merge-output-format".to_string());
            args.push("mp4".to_string());
        }

        if settings.embed_thumbnail {
            args.push("--embed-thumbnail".to_string());
        }
        if settings.embed_metadata {
            args.push("--embed-metadata".to_string());
        }

        let validated_url = match EngineManager::validate_inspection_url(&task.url) {
            Ok(u) => u,
            Err(url_err) => {
                task.status = TaskStatus::Failed;
                task.error_message = Some(url_err);
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
        };

        args.push("--".to_string());
        args.push(validated_url);
        (ytdlp_path, args)
    };

    let started_unix = chrono::Utc::now().timestamp();
    let started_instant = Instant::now();
    let mut ema_speed: f64 = 0.0;

    task.status = TaskStatus::Connecting;
    task.current_phase = "Connecting to engine...".to_string();
    state.upsert_task(&task);
    let _ = app.emit("task_updated", &task);

    let mut cmd = Command::new(&exec_path);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    EngineManager::apply_engine_env(&mut cmd);
    process::configure_background_command(&mut cmd);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            task.status = TaskStatus::Failed;
            task.error_message = Some(format!("Failed to spawn engine: {}", e));
            state.upsert_task(&task);
            let _ = app.emit("task_updated", &task);
            return;
        }
    };

    let pid = child.id();
    {
        let mut procs = state
            .active_processes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        procs.insert(task_id.to_string(), pid);
    }

    let mut detected_output_path: Option<String> = None;

    let stream_res = process::stream_child_lines(child, |line| {
        if state.is_shutting_down.load(Ordering::SeqCst) {
            process::kill_process_tree(pid);
            return false;
        }

        let mut current = match state.get_task_by_id(task_id) {
            Some(t) => t,
            None => {
                process::kill_process_tree(pid);
                return false;
            }
        };

        if matches!(current.status, TaskStatus::Paused | TaskStatus::Cancelled) {
            process::kill_process_tree(pid);
            return false;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            return true;
        }

        if is_spotdl {
            current.percentage_known = false;
            if trimmed.contains("Searching for") || trimmed.contains("Found") {
                current.status = TaskStatus::Connecting;
                current.current_phase = "Matching audio source...".to_string();
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
            } else if trimmed.contains("Downloading") {
                current.status = TaskStatus::Downloading;
                current.current_phase = "Downloading audio stream...".to_string();
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
            } else if trimmed.contains("Converting") || trimmed.contains("Embedding") {
                current.status = TaskStatus::Processing;
                current.current_phase = "Embedding metadata & artwork...".to_string();
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
            }
            return true;
        }

        if let Some(printed) = trimmed.strip_prefix("VANTA_OUTPUT_FILE:") {
            let p = printed.trim();
            if !p.is_empty() {
                detected_output_path = Some(p.to_string());
            }
            return true;
        }

        if let Some(idx) = trimmed.find("Destination:") {
            let dest = trimmed[idx + "Destination:".len()..]
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            if !dest.is_empty() {
                detected_output_path = Some(dest.to_string());
            }
        } else if let Some(idx) = trimmed.find("Merging formats into") {
            let dest = trimmed[idx + "Merging formats into".len()..]
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            if !dest.is_empty() {
                detected_output_path = Some(dest.to_string());
            }
            current.status = TaskStatus::Muxing;
            current.current_phase = "Muxing video & audio streams...".to_string();
            current.speed_bytes_per_sec = 0.0;
            current.speed_str = "0 B/s".to_string();
            state.upsert_task(&current);
            let _ = app.emit("task_updated", &current);
            return true;
        }

        if trimmed.contains("[ExtractAudio]") || trimmed.contains("[Metadata]") {
            current.status = TaskStatus::Processing;
            current.current_phase = "Processing & embedding metadata...".to_string();
            current.speed_bytes_per_sec = 0.0;
            current.speed_str = "0 B/s".to_string();
            state.upsert_task(&current);
            let _ = app.emit("task_updated", &current);
            return true;
        }

        if trimmed.contains('|') {
            let parts: Vec<&str> = trimmed.split('|').collect();
            if parts.len() >= 6 {
                let pct_raw = parts[0].trim_end_matches('%').trim();
                let pct_val: Option<f64> = pct_raw.parse().ok();
                let downloaded = crate::parse_bytes(parts[1]);
                let total = crate::parse_bytes(parts[2]);
                let speed_bytes = crate::parse_bytes(parts[3].trim_end_matches("/s")) as f64;
                if speed_bytes > 0.0 {
                    ema_speed = if ema_speed == 0.0 {
                        speed_bytes
                    } else {
                        0.3 * speed_bytes + 0.7 * ema_speed
                    };
                }
                let elapsed = started_instant.elapsed().as_secs();
                let remaining = total.saturating_sub(downloaded);
                let eta_sec = if total > 0 && ema_speed >= 1.0 && remaining > 0 {
                    Some((remaining as f64 / ema_speed).ceil() as u64)
                } else {
                    None
                };

                let pct_known = total > 0 || pct_val.is_some();
                let pct = if total > 0 {
                    ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
                } else {
                    pct_val.unwrap_or(0.0).clamp(0.0, 100.0)
                };

                let phase_raw = parts[5].trim();
                current.status = if phase_raw.eq_ignore_ascii_case("processing")
                    || phase_raw.eq_ignore_ascii_case("postprocessing")
                {
                    TaskStatus::Processing
                } else {
                    TaskStatus::Downloading
                };
                current.downloaded_bytes = downloaded;
                current.total_bytes = total;
                current.remaining_bytes = remaining;
                current.percentage_known = pct_known;
                current.progress_percentage = pct;
                current.speed_bytes_per_sec = ema_speed;
                current.avg_speed_bytes_per_sec = if elapsed > 0 {
                    downloaded as f64 / elapsed as f64
                } else {
                    ema_speed
                };
                current.speed_str = format!("{}/s", format_bytes_rust(ema_speed));
                current.eta_seconds = eta_sec;
                current.eta_str = eta_sec
                    .map(format_duration_rust)
                    .unwrap_or_else(|| "--".to_string());
                current.elapsed_seconds = elapsed;
                current.active_connections = settings.fragment_concurrency.max(1);
                current.last_progress_at = Some(chrono::Utc::now().to_rfc3339());
                current.current_phase = if phase_raw.is_empty() || phase_raw.eq_ignore_ascii_case("na") {
                    "Downloading".to_string()
                } else {
                    phase_raw.to_string()
                };

                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
            }
        }

        true
    });

    {
        let mut procs = state
            .active_processes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        procs.remove(task_id);
    }

    let mut t = match state.get_task_by_id(task_id) {
        Some(t) => t,
        None => return,
    };

    if matches!(t.status, TaskStatus::Cancelled | TaskStatus::Paused)
        || state.is_shutting_down.load(Ordering::SeqCst)
    {
        return;
    }

    match stream_res {
        Ok((status, _err_log)) if status.success() => {
            let candidate_path = detected_output_path
                .map(PathBuf::from)
                .filter(|p| p.is_file())
                .or_else(|| find_recent_output_file(&out_dir, started_unix, t.is_audio_only));

            let valid_file = candidate_path.and_then(|p| {
                fs::metadata(&p)
                    .ok()
                    .filter(|m| m.is_file() && m.len() > 0)
                    .map(|m| (p, m.len()))
            });

            let Some((final_path, file_size)) = valid_file else {
                t.status = TaskStatus::Failed;
                t.current_phase = "Verification failed".to_string();
                t.error_message = Some("Engine exited cleanly, but no non-empty output file was found on disk.".to_string());
                state.upsert_task(&t);
                let _ = app.emit("task_updated", &t);
                return;
            };

            t.status = TaskStatus::Verifying;
            t.current_phase = "Verifying output file & codecs...".to_string();
            state.upsert_task(&t);
            let _ = app.emit("task_updated", &t);

            if let Some((audio_sum, acodec, vcodec, res_lbl)) = EngineManager::verify_media_file(&final_path) {
                t.verified_audio_info = audio_sum;
                t.audio_codec = acodec;
                t.video_codec = vcodec;
                t.resolution_label = res_lbl;
            }

            if let Some(ext_str) = final_path.extension().and_then(|s| s.to_str()) {
                t.ext = ext_str.to_lowercase();
            }

            t.status = TaskStatus::Completed;
            t.progress_percentage = 100.0;
            t.percentage_known = true;
            t.downloaded_bytes = file_size;
            t.total_bytes = file_size;
            t.remaining_bytes = 0;
            t.speed_str = "0 B/s".to_string();
            t.speed_bytes_per_sec = 0.0;
            t.eta_seconds = Some(0);
            t.eta_str = "Finished".to_string();
            t.active_connections = 0;
            t.current_phase = "Completed".to_string();
            t.completed_at = Some(chrono::Utc::now().to_rfc3339());
            t.output_path = final_path.to_string_lossy().to_string();

            state.upsert_task(&t);
            let _ = app.emit("task_updated", &t);

            let notif = NotificationItem {
                id: format!("notif_{}", chrono::Utc::now().timestamp_millis()),
                r#type: "success".to_string(),
                title: "Download Complete".to_string(),
                message: format!("'{}' downloaded successfully.", t.title),
                timestamp: chrono::Utc::now().to_rfc3339(),
                task_id: Some(t.id.clone()),
            };
            state.add_notification(&notif);
            let _ = app.emit("notification", &notif);
        }
        Ok((status, err_log)) => {
            let clean_err = logging::redact_secrets(&err_log);
            let is_410 = clean_err.contains("HTTP Error 410")
                || clean_err.contains("410 Gone")
                || clean_err.contains("URL expired");
            let can_retry = t.retries < t.max_retries;

            if is_410 && can_retry {
                t.retries += 1;
                t.status = TaskStatus::Queued;
                t.current_phase = format!(
                    "HTTP 410 detected. Refreshing tokens ({}/{})...",
                    t.retries, t.max_retries
                );
                state.upsert_task(&t);
                let _ = app.emit("task_updated", &t);
            } else if can_retry && settings.auto_retry_failed {
                t.retries += 1;
                t.status = TaskStatus::Queued;
                t.current_phase = format!("Retrying ({}/{})...", t.retries, t.max_retries);
                state.upsert_task(&t);
                let _ = app.emit("task_updated", &t);
            } else {
                t.status = TaskStatus::Failed;
                t.current_phase = "Failed".to_string();
                t.error_message = Some(if clean_err.is_empty() {
                    format!("Process exited with code {:?}", status.code())
                } else {
                    clean_err
                });
                t.speed_str = "0 B/s".to_string();
                t.speed_bytes_per_sec = 0.0;
                t.active_connections = 0;
                state.upsert_task(&t);
                let _ = app.emit("task_updated", &t);

                let notif = NotificationItem {
                    id: format!("notif_{}", chrono::Utc::now().timestamp_millis()),
                    r#type: "error".to_string(),
                    title: "Download Failed".to_string(),
                    message: format!(
                        "'{}' failed: {}",
                        t.title,
                        t.error_message.as_deref().unwrap_or("Unknown error")
                    ),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    task_id: Some(t.id.clone()),
                };
                state.add_notification(&notif);
                let _ = app.emit("notification", &notif);
            }
        }
        Err(wait_err) => {
            let clean_err = logging::redact_secrets(&wait_err);
            t.status = TaskStatus::Failed;
            t.current_phase = "Failed".to_string();
            t.error_message = Some(clean_err);
            t.speed_str = "0 B/s".to_string();
            t.active_connections = 0;
            state.upsert_task(&t);
            let _ = app.emit("task_updated", &t);
        }
    }
}
