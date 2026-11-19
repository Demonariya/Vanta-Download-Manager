use crate::cookies;
use crate::engines::EngineManager;
use crate::logging;
use crate::models::{
    AppSettings, CookieStatus, CookieTestResult, CookieValidationResult, CreateTaskPayload,
    DetectedBrowserInfo, DiagnosticLogInfo, DiagnosticResult, DownloadTask, EngineStatusMap,
    EngineUpdateResult, ManagedEngineInfo, MediaMetadata, NotificationItem, TaskPriority,
    TaskStatus,
};
use crate::process;
use crate::state::AppState;
use std::fs;
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
    let is_audio = payload.is_audio_only.unwrap_or(is_spotify);
    let requires_ffmpeg = is_audio
        || settings.embed_thumbnail
        || settings.embed_metadata
        || payload.format_id.as_deref().unwrap_or("best") == "best";

    tokio::task::spawn_blocking(move || {
        EngineManager::ensure_required_engines(requires_ffmpeg, is_spotify)
    })
    .await
    .map_err(|e| format!("Engine preflight failed: {}", e))??;

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
    } else {
        "yt-dlp".to_string()
    };

    let ext = payload.ext.unwrap_or_else(|| {
        if is_audio {
            settings.default_audio_format.clone()
        } else {
            "mp4".to_string()
        }
    });

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
        engine,
        status: TaskStatus::Queued,
        progress_percentage: 0.0,
        speed_str: "0 B/s".to_string(),
        speed_bytes_per_sec: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        eta_str: "--:--".to_string(),
        current_phase: "Queued".to_string(),
        format_id: payload.format_id.unwrap_or_else(|| "best".to_string()),
        format_note: payload.format_note,
        ext,
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
        output_path: payload
            .output_path
            .unwrap_or_else(|| settings.download_dir.clone()),
        error_message: None,
        priority: payload.priority.unwrap_or(TaskPriority::Normal),
        created_at: chrono::Utc::now().to_rfc3339(),
        completed_at: None,
        retries: 0,
        max_retries: settings.max_retries,
    };

    state.upsert_task(&task);
    let _ = app.emit("task_updated", &task);

    logging::info("queue", &format!("Created task '{}' ({})", task.id, task.engine));
    schedule_next(&app, &state);

    Ok(task)
}

#[tauri::command]
pub fn pause_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
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
        t.current_phase = "Paused".to_string();
        t.speed_str = "0 B/s".to_string();
        t.speed_bytes_per_sec = 0.0;
        state.upsert_task(&t);
        let _ = app.emit("task_updated", &t);
    }

    schedule_next(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn resume_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
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
pub fn cancel_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
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
        state.upsert_task(&t);
        let _ = app.emit("task_updated", &t);
    }

    schedule_next(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn retry_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if let Some(mut t) = state.get_task_by_id(&id) {
        t.status = TaskStatus::Queued;
        t.current_phase = "Queued for retry".to_string();
        t.error_message = None;
        t.retries = 0;
        t.progress_percentage = 0.0;
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
) -> Result<(), String> {
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
    state.delete_task(&id);
    let _ = app.emit("task_deleted", serde_json::json!({ "id": id }));
    schedule_next(&app, &state);
    Ok(())
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

    let tasks = state.get_tasks();
    for mut t in tasks {
        if matches!(
            t.status,
            TaskStatus::Downloading
                | TaskStatus::Extracting
                | TaskStatus::Processing
                | TaskStatus::Queued
        ) {
            t.status = TaskStatus::Paused;
            t.current_phase = "Paused".to_string();
            t.speed_str = "0 B/s".to_string();
            t.speed_bytes_per_sec = 0.0;
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
pub fn clear_completed(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.clear_completed_tasks();
    let remaining = state.get_tasks();
    let _ = app.emit("tasks_cleared", &remaining);
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

    // Deduplicate concurrent scans: wait briefly if another scan is already active
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
pub async fn check_engine_updates() -> Result<serde_json::Value, String> {
    let status = tokio::task::spawn_blocking(EngineManager::get_engine_status)
        .await
        .map_err(|e| format!("Update check failed: {}", e))?;

    Ok(serde_json::json!({
        "ytdlp": {
            "currentVersion": status.ytdlp.version,
            "latestVersion": status.ytdlp.version,
            "updateAvailable": !status.ytdlp.available
        },
        "spotdl": {
            "currentVersion": status.spotdl.version,
            "latestVersion": status.spotdl.version,
            "updateAvailable": !status.spotdl.available
        },
        "ffmpeg": {
            "currentVersion": status.ffmpeg.version,
            "latestVersion": status.ffmpeg.version,
            "updateAvailable": !status.ffmpeg.available
        },
        "ffprobe": {
            "currentVersion": status.ffprobe.version,
            "latestVersion": status.ffprobe.version,
            "updateAvailable": !status.ffprobe.available
        }
    }))
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
pub async fn inspect_url(
    state: State<'_, AppState>,
    url: String,
    request_id: Option<String>,
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

    tokio::task::spawn_blocking(move || {
        EngineManager::inspect_url_with_tracking(
            &req_id,
            &validated_url,
            &settings,
            Some(tracked.cancelled),
            Some(tracked.pid),
        )
    })
    .await
    .map_err(|e| format!("URL inspection worker panicked: {}", e))?
}

#[tauri::command]
pub fn cancel_inspection(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<bool, String> {
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
pub fn remove_cookies(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CookieStatus, String> {
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
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed opening Explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed opening Finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(path)
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

    let active_count = tasks
        .iter()
        .filter(|t| {
            matches!(
                t.status,
                TaskStatus::Downloading | TaskStatus::Extracting | TaskStatus::Processing
            )
        })
        .count();

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
            .then_with(|| a.created_at.cmp(&b.created_at))
    });

    for mut next_task in queued.into_iter().take(available_slots) {
        // Claim task synchronously as Extracting before spawning background worker
        // so repeated schedule_next calls never double-dispatch the same task.
        next_task.status = TaskStatus::Extracting;
        next_task.current_phase = "Starting engine...".to_string();
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
    let join_res = tokio::task::spawn_blocking(move || {
        run_download_task_blocking(&app, &task_id);
        app
    })
    .await;

    if let Ok(app) = join_res {
        let state = app.state::<AppState>();
        schedule_next(&app, &state);
    }
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
        logging::error("download", &format!("Task '{}' missing engine: {}", task_id, err_msg));
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(err_msg);
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let out_dir = PathBuf::from(&task.output_path);
    if let Err(e) = fs::create_dir_all(&out_dir) {
        let msg = format!("Failed creating output directory '{}': {}", out_dir.display(), e);
        logging::error("download", &msg);
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(msg);
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let (exec_path, args) = if is_spotdl {
        let spotdl_path = match EngineManager::find_executable("spotdl") {
            Some(p) => p,
            None => {
                task.status = TaskStatus::Failed;
                task.current_phase = "Failed".to_string();
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
                task.current_phase = "Failed".to_string();
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

        let is_collection = matches!(
            task.content_type.as_deref(),
            Some("album") | Some("playlist")
        );
        let output_template = if is_collection {
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
                task.current_phase = "Failed".to_string();
                task.error_message = Some("yt-dlp executable not found.".to_string());
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
        };

        let template = out_dir.join(&settings.filename_template);
        let template_str = template.to_string_lossy().to_string();

        let mut args = vec![
            "--newline".to_string(),
            "--no-colors".to_string(),
            "--progress-template".to_string(),
            "%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s".to_string(),
            "-o".to_string(),
            template_str,
            "--retries".to_string(),
            "10".to_string(),
            "--fragment-retries".to_string(),
            "10".to_string(),
            "--file-access-retries".to_string(),
            "5".to_string(),
            "--socket-timeout".to_string(),
            "30".to_string(),
        ];

        match EngineManager::build_ytdlp_request_args(&task.url, &settings) {
            Ok(req_args) => args.extend(req_args),
            Err(cookie_err) => {
                logging::error("download", &format!("Task '{}' cookie config error: {}", task_id, cookie_err));
                task.status = TaskStatus::Failed;
                task.current_phase = "Failed".to_string();
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
        } else if task.format_id != "best" {
            args.push("-f".to_string());
            args.push(task.format_id.clone());
        } else {
            args.push("-f".to_string());
            args.push("bestvideo+bestaudio/best".to_string());
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
                logging::error("download", &format!("Task '{}' invalid URL: {}", task_id, url_err));
                task.status = TaskStatus::Failed;
                task.current_phase = "Failed".to_string();
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

    task.status = TaskStatus::Extracting;
    task.current_phase = "Initializing engine...".to_string();
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
            let msg = format!("Failed to spawn engine '{}': {}", exec_path.display(), e);
            logging::error("download", &msg);
            task.status = TaskStatus::Failed;
            task.current_phase = "Failed".to_string();
            task.error_message = Some(msg);
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

        let current_opt = state.get_task_by_id(task_id);
        let mut current = match current_opt {
            Some(t) => t,
            None => {
                // Task was deleted while running
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
            if trimmed.contains("Searching for") {
                current.status = TaskStatus::Extracting;
                current.current_phase = "Matching audio source...".to_string();
                current.progress_percentage = 25.0;
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
            } else if trimmed.contains("Downloading") {
                current.status = TaskStatus::Downloading;
                current.current_phase = "Downloading audio stream...".to_string();
                current.progress_percentage = 60.0;
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
            } else if trimmed.contains("Converting") || trimmed.contains("Embedding") {
                current.status = TaskStatus::Processing;
                current.current_phase = "Embedding metadata & artwork...".to_string();
                current.progress_percentage = 85.0;
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
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
        }

        if trimmed.contains('|') {
            let parts: Vec<&str> = trimmed.split('|').collect();
            if parts.len() >= 6 {
                let percent_clean = parts[0].trim_end_matches('%').trim();
                let percent: f64 = percent_clean.parse().unwrap_or(current.progress_percentage);
                let speed = parts[3].trim();
                let eta = parts[4].trim();
                let phase_raw = parts[5].trim();

                current.status = if phase_raw.eq_ignore_ascii_case("processing")
                    || phase_raw.eq_ignore_ascii_case("postprocessing")
                {
                    TaskStatus::Processing
                } else {
                    TaskStatus::Downloading
                };
                current.progress_percentage = percent.clamp(0.0, 100.0);
                if !speed.is_empty() && !speed.eq_ignore_ascii_case("na") {
                    current.speed_str = speed.to_string();
                }
                if !eta.is_empty() && !eta.eq_ignore_ascii_case("na") {
                    current.eta_str = eta.to_string();
                }
                if !phase_raw.is_empty() && !phase_raw.eq_ignore_ascii_case("na") {
                    current.current_phase = phase_raw.to_string();
                } else {
                    current.current_phase = "Downloading".to_string();
                }

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
            t.status = TaskStatus::Completed;
            t.progress_percentage = 100.0;
            t.speed_str = "0 B/s".to_string();
            t.speed_bytes_per_sec = 0.0;
            t.eta_str = "Finished".to_string();
            t.current_phase = "Completed".to_string();
            t.completed_at = Some(chrono::Utc::now().to_rfc3339());
            if let Some(out_file) = detected_output_path {
                t.output_path = out_file;
            }

            if t.is_audio_only {
                let verify_target = PathBuf::from(&t.output_path);
                if let Some(verified) = EngineManager::verify_audio_file(&verify_target) {
                    t.verified_audio_info = Some(verified);
                }
            }

            state.upsert_task(&t);
            let _ = app.emit("task_updated", &t);

            logging::info("download", &format!("Task '{}' completed.", t.id));

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
            logging::error(
                "download",
                &format!(
                    "Task '{}' exited with status {:?}: {}",
                    t.id,
                    status.code(),
                    clean_err.lines().next().unwrap_or("unknown error")
                ),
            );

            let is_410 = clean_err.contains("HTTP Error 410")
                || clean_err.contains("410 Gone")
                || clean_err.contains("URL expired");
            let can_retry = t.retries < t.max_retries;

            if is_410 && can_retry {
                t.retries += 1;
                t.status = TaskStatus::Queued;
                t.current_phase = format!(
                    "HTTP 410 detected. Refreshing tokens (attempt {}/{})...",
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
            logging::error("download", &format!("Task '{}' wait failed: {}", t.id, clean_err));
            t.status = TaskStatus::Failed;
            t.current_phase = "Failed".to_string();
            t.error_message = Some(clean_err);
            t.speed_str = "0 B/s".to_string();
            state.upsert_task(&t);
            let _ = app.emit("task_updated", &t);
        }
    }
}
