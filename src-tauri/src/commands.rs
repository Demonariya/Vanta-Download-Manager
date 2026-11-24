use crate::cookies;
use crate::engines::EngineManager;
use crate::logging;
use crate::models::{
    AppSettings, CookieStatus, CookieTestResult, CookieValidationResult, CreateTaskPayload,
    DetectedBrowserInfo, DiagnosticLogInfo, DiagnosticResult, DownloadQueue, DownloadTask, EngineStatusMap,
    EngineUpdateInfo, EngineUpdateResult, ManagedEngineInfo, MediaMetadata, NotificationItem,
    PythonValidationResult, TaskLogEntry, TaskPriority, TaskStatus,
};
use crate::process;
use crate::state::AppState;
use id3::{
    frame::{Lyrics as Id3Lyrics, SynchronisedLyrics, SynchronisedLyricsType, TimestampFormat},
    Error as Id3Error, ErrorKind as Id3ErrorKind, Tag as Id3Tag, TagLike, Version as Id3Version,
};
use std::collections::{HashMap, HashSet};
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

fn parse_lrc_timestamp(value: &str) -> Option<u32> {
    let (minutes_text, seconds_text) = value.split_once(':')?;
    let minutes = minutes_text.parse::<u64>().ok()?;
    let separator = seconds_text.find('.').or_else(|| seconds_text.find(','));
    let (whole_seconds_text, fraction_text) = match separator {
        Some(index) => (&seconds_text[..index], &seconds_text[index + 1..]),
        None => (seconds_text, ""),
    };
    let seconds = whole_seconds_text.parse::<u64>().ok()?;
    if seconds >= 60 { return None; }
    let fraction_digits = fraction_text.chars().take(3).collect::<String>();
    if !fraction_digits.chars().all(|ch| ch.is_ascii_digit()) { return None; }
    let fraction_value = if fraction_digits.is_empty() {
        0
    } else {
        let parsed = fraction_digits.parse::<u32>().ok()?;
        match fraction_digits.len() { 1 => parsed * 100, 2 => parsed * 10, _ => parsed }
    };
    let total = minutes.checked_mul(60_000)?
        .checked_add(seconds.checked_mul(1_000)?)?
        .checked_add(fraction_value as u64)?;
    u32::try_from(total).ok()
}

fn parse_lrc_entries(content: &str) -> Vec<(u32, String)> {
    let offset_ms = content.lines().find_map(|line| {
        let value = line.trim().strip_prefix("[offset:")?.strip_suffix(']')?;
        value.trim().parse::<i64>().ok()
    }).unwrap_or(0);
    let mut entries = Vec::new();

    for line in content.lines() {
        let mut remaining = line.trim();
        let mut timestamps = Vec::new();
        while let Some(after_open) = remaining.strip_prefix('[') {
            let Some(end) = after_open.find(']') else { break; };
            let Some(timestamp) = parse_lrc_timestamp(&after_open[..end]) else { break; };
            timestamps.push(timestamp);
            remaining = &after_open[end + 1..];
        }
        let lyric_text = remaining.trim();
        if lyric_text.is_empty() { continue; }
        for timestamp in timestamps {
            let adjusted = (timestamp as i64 + offset_ms).clamp(0, u32::MAX as i64) as u32;
            entries.push((adjusted, lyric_text.to_string()));
        }
    }
    entries.sort_by_key(|(timestamp, _)| *timestamp);
    entries
}

fn validate_lrc_content(content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("The selected LRC file is empty.".to_string());
    }
    if content.len() > 512 * 1024 {
        return Err("The LRC file exceeds the 512 KiB size limit.".to_string());
    }
    if parse_lrc_entries(content).is_empty() {
        return Err("The selected file does not contain valid timestamped LRC lyrics.".to_string());
    }
    Ok(())
}

fn write_lrc_sidecar(audio_path: &Path, content: &str) -> Result<PathBuf, String> {
    validate_lrc_content(content)?;
    let sidecar = audio_path.with_extension("lrc");
    fs::write(&sidecar, content)
        .map_err(|e| format!("Could not write LRC sidecar '{}': {}", sidecar.display(), e))?;
    Ok(sidecar)
}

fn embed_lrc_lyrics(audio_path: &Path, content: &str) -> Result<bool, String> {
    if !audio_path.extension().and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("mp3")).unwrap_or(false) {
        return Ok(false);
    }
    let entries = parse_lrc_entries(content);
    if entries.is_empty() {
        return Err("No valid timestamped lyric lines were found to embed.".to_string());
    }
    let mut tag = match Id3Tag::read_from_path(audio_path) {
        Ok(tag) => tag,
        Err(Id3Error { kind: Id3ErrorKind::NoTag, .. }) => Id3Tag::new(),
        Err(error) => return Err(format!("Could not read existing MP3 ID3 tags: {}", error)),
    };
    let plain_text = entries.iter().map(|(_, line)| line.as_str()).collect::<Vec<_>>().join("\n");
    tag.remove_all_synchronised_lyrics();
    tag.remove_all_lyrics();
    tag.add_frame(SynchronisedLyrics {
        lang: "und".to_string(),
        timestamp_format: TimestampFormat::Ms,
        content_type: SynchronisedLyricsType::Lyrics,
        content: entries,
        description: "VANTA synchronized lyrics".to_string(),
    });
    tag.add_frame(Id3Lyrics {
        lang: "und".to_string(),
        description: "VANTA lyrics".to_string(),
        text: plain_text,
    });
    tag.write_to_path(audio_path, Id3Version::Id3v24)
        .map_err(|error| format!("Could not embed synchronized lyrics into MP3: {}", error))?;
    Ok(true)
}

fn write_lrc_assets(audio_path: &Path, content: &str) -> Result<(), String> {
    if let Err(error) = embed_lrc_lyrics(audio_path, content) {
        logging::warn("lyrics", &format!(
            "Could not embed synchronized lyrics into '{}'; preserving the LRC sidecar: {}",
            audio_path.display(), error
        ));
    }
    write_lrc_sidecar(audio_path, content)?;
    Ok(())
}

fn build_subtitle_args(languages: &[String], include_auto: bool) -> Vec<String> {
    if languages.is_empty() { return Vec::new(); }
    let mut args = vec!["--write-subs".to_string()];
    if include_auto { args.push("--write-auto-subs".to_string()); }
    args.extend([
        "--sub-langs".to_string(), languages.join(","),
        "--sub-format".to_string(), "best".to_string(),
        "--convert-subs".to_string(), "srt".to_string(),
        "--remux-video".to_string(), "mp4".to_string(),
        "--embed-subs".to_string(),
        "--ppa".to_string(),
        "EmbedSubtitle+ffmpeg_o:-disposition:s:0 default".to_string(),
    ]);
    args
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
    let trimmed_url = EngineManager::validate_inspection_url(&payload.url)?;
    let is_spotify = crate::spotify::is_spotify_url(&trimmed_url);
    let is_audio = payload.is_audio_only.unwrap_or(is_spotify);
    if let Some(ref lrc) = payload.lyrics_lrc_content {
        validate_lrc_content(lrc)?;
        if !is_audio {
            return Err("Synchronized LRC lyrics can only be attached to audio downloads.".to_string());
        }
    }

    let requires_ffmpeg = is_audio
        || is_spotify
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
        .filter(|s| crate::is_valid_thumbnail_url(s));
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

    let needs_metadata_enrichment =
        crate::is_placeholder_task_title(&resolved_title) || resolved_thumbnail.is_none();

    if is_spotify && needs_metadata_enrichment {
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

    let selected_items: Option<Vec<String>> = payload.selected_items.map(|items| {
        items
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    }).filter(|v| !v.is_empty());

    let tracks_requested = selected_items
        .as_ref()
        .map(|v| v.len() as u32)
        .filter(|&n| n > 0);
    let tracks_completed = tracks_requested.map(|_| 0u32);
    let tracks_failed = tracks_requested.map(|_| 0u32);

    let queue_id = payload.queue_id.clone().unwrap_or_else(|| "main".to_string());
    if !state.get_queues().iter().any(|queue| queue.id == queue_id) {
        return Err("Selected download queue does not exist.".to_string());
    }
    let max_order = state
        .get_tasks()
        .iter()
        .filter(|task| task.queue_id == queue_id)
        .map(|task| task.queue_order)
        .max()
        .unwrap_or(0);
    let known_total = payload.total_bytes.unwrap_or(0);
    // Capture this before moving playlist_mode into DownloadTask.
    let bg_playlist = payload.playlist_mode.as_deref() == Some("playlist");

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
        subtitle_languages: payload.subtitle_languages.unwrap_or_default(),
        write_auto_subtitles: payload.write_auto_subtitles.unwrap_or(false),
        lyrics_lrc_content: payload.lyrics_lrc_content,
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
        output_path: payload
            .output_path
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| settings.download_dir.clone()),
        custom_filename: payload.custom_filename,
        playlist_mode: payload.playlist_mode,
        selected_items,
        tracks_requested,
        tracks_completed,
        tracks_failed,
        error_message: None,
        logs: vec![TaskLogEntry {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: "info".to_string(),
            message: format!("Task queued via {}", engine),
        }],
        priority: payload.priority.unwrap_or(TaskPriority::Normal),
        queue_order: max_order + 1,
        queue_id,
        created_at: chrono::Utc::now().to_rfc3339(),
        started_at: None,
        completed_at: None,
        retries: 0,
        max_retries: settings.max_retries,
    };

    state.upsert_task(&task);
    let _ = app.emit("task_added", &task);

    if !is_spotify && needs_metadata_enrichment {
        let app_bg = app.clone();
        let bg_id = task.id.clone();
        // Keep a separate ID for the async lookup; task itself must remain usable below.
        let bg_lookup_id = task.id.clone();
        let bg_url = task.url.clone();
        let bg_settings = settings.clone();
        tokio::spawn(async move {
            let inspect_res = tokio::task::spawn_blocking(move || {
                EngineManager::inspect_url_with_tracking_opts(
                    &format!("bg_{}", bg_id),
                    &bg_url,
                    &bg_settings,
                    None,
                    None,
                    Some(bg_playlist),
                )
            })
            .await;

            if let Ok(Ok(meta)) = inspect_res {
                let st = app_bg.state::<AppState>();
                if let Some(mut cur) = st.get_task_by_id(&bg_lookup_id) {
                    let mut changed = false;
                    if let Some(ref thumb) = meta.thumbnail {
                        let cur_valid = cur
                            .thumbnail
                            .as_deref()
                            .map(crate::is_valid_thumbnail_url)
                            .unwrap_or(false);
                        if !cur_valid && crate::is_valid_thumbnail_url(thumb) {
                            cur.thumbnail = Some(thumb.clone());
                            changed = true;
                        }
                    }
                    if crate::is_placeholder_task_title(&cur.title)
                        && !crate::is_placeholder_task_title(&meta.title)
                    {
                        cur.title = meta.title;
                        changed = true;
                    }
                    if cur.uploader.is_none() && meta.uploader.is_some() {
                        cur.uploader = meta.uploader;
                        changed = true;
                    }
                    if cur.duration.is_none() && meta.duration.is_some() {
                        cur.duration = meta.duration;
                        cur.duration_string = meta.duration_string;
                        changed = true;
                    }
                    if changed {
                        st.upsert_task(&cur);
                        let _ = app_bg.emit("task_updated", &cur);
                    }
                }
            }
        });
    }

    logging::info("queue", &format!("Created task '{}' ({})", task.id, task.engine));
    schedule_next(&app, &state);

    Ok(task)
}

#[tauri::command]
pub fn pause_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Persist the paused state before terminating the child. The worker checks this
    // state before finalization, preventing a pause/exit race from marking the task complete.
    if let Some(mut task) = state.get_task_by_id(&id) {
        if matches!(task.status, TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled) {
            return Ok(());
        }
        task.status = TaskStatus::Paused;
        task.current_phase = "Paused by user".to_string();
        task.speed_str = "0 B/s".to_string();
        task.speed_bytes_per_sec = 0.0;
        task.eta_seconds = None;
        task.eta_str = "--".to_string();
        task.active_connections = 0;
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
    }

    let removed_pid = {
        let mut procs = state.active_processes.lock().unwrap_or_else(|e| e.into_inner());
        procs.remove(&id)
    };
    if let Some(pid) = removed_pid {
        process::kill_process_tree(pid);
    }

    schedule_next(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn resume_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(mut task) = state.get_task_by_id(&id) {
        if task.status != TaskStatus::Paused {
            return Ok(());
        }
        task.status = TaskStatus::Queued;
        task.current_phase = "Queued to resume".to_string();
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        schedule_next(&app, &state);
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
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
    // Mark queued and running work first, so a worker starting concurrently will
    // observe the paused state when it registers its process id.
    let tasks = state.get_tasks();
    for mut task in tasks {
        if task.status.is_active() || task.status == TaskStatus::Queued {
            task.status = TaskStatus::Paused;
            task.current_phase = "Paused".to_string();
            task.speed_str = "0 B/s".to_string();
            task.speed_bytes_per_sec = 0.0;
            task.eta_seconds = None;
            task.eta_str = "--".to_string();
            task.active_connections = 0;
            state.upsert_task(&task);
            let _ = app.emit("task_updated", &task);
        }
    }

    let pids: Vec<u32> = {
        let mut procs = state.active_processes.lock().unwrap_or_else(|e| e.into_inner());
        procs.drain().map(|(_id, pid)| pid).collect()
    };
    for pid in pids {
        process::kill_process_tree(pid);
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
pub fn get_queues(state: State<'_, AppState>) -> Result<Vec<DownloadQueue>, String> {
    Ok(state.get_queues())
}

#[tauri::command]
pub fn create_queue(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Vec<DownloadQueue>, String> {
    let queues = state.create_queue(&name)?;
    let _ = app.emit("queues_updated", &queues);
    Ok(queues)
}

#[tauri::command]
pub fn rename_queue(app: AppHandle, state: State<'_, AppState>, id: String, name: String) -> Result<Vec<DownloadQueue>, String> {
    let queues = state.rename_queue(&id, &name)?;
    let _ = app.emit("queues_updated", &queues);
    Ok(queues)
}

#[tauri::command]
pub fn delete_queue(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Vec<DownloadQueue>, String> {
    let queues = state.delete_queue(&id)?;
    let _ = app.emit("queues_updated", &queues);
    let tasks = state.get_tasks();
    let _ = app.emit("tasks_cleared", &tasks);
    Ok(queues)
}

#[tauri::command]
pub fn stop_queue(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Vec<DownloadQueue>, String> {
    state.set_queue_paused(&id, true)?;
    let task_ids: Vec<String> = state.get_tasks().into_iter()
        .filter(|task| task.queue_id == id && (task.status.is_active() || task.status == TaskStatus::Queued))
        .map(|task| task.id)
        .collect();
    for task_id in task_ids {
        pause_task(app.clone(), state.clone(), task_id)?;
    }
    let queues = state.get_queues();
    let _ = app.emit("queues_updated", &queues);
    Ok(queues)
}

#[tauri::command]
pub fn start_queue(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Vec<DownloadQueue>, String> {
    state.set_queue_paused(&id, false)?;
    for mut task in state.get_tasks().into_iter().filter(|task| task.queue_id == id && task.status == TaskStatus::Paused) {
        task.status = TaskStatus::Queued;
        task.current_phase = "Queued in active queue".to_string();
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
    }
    schedule_next(&app, &state);
    let queues = state.get_queues();
    let _ = app.emit("queues_updated", &queues);
    Ok(queues)
}

#[tauri::command]
pub fn move_tasks_to_queue(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>, queue_id: String) -> Result<Vec<DownloadTask>, String> {
    let tasks = state.move_tasks_to_queue(&ids, &queue_id)?;
    let _ = app.emit("tasks_cleared", &tasks);
    schedule_next(&app, &state);
    Ok(tasks)
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
    custom_filename: Option<String>,
) -> Result<DownloadTask, String> {
    let mut task = state
        .get_task_by_id(&id)
        .ok_or_else(|| "Task not found".to_string())?;
    if let Some(p) = priority {
        task.priority = p;
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
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.get_settings())
}

fn sync_windows_startup_registration(settings: &AppSettings) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        const VALUE_NAME: &str = "VANTA Download Manager";
        if settings.launch_on_startup {
            let executable = std::env::current_exe()
                .map_err(|error| format!("Could not locate VANTA executable: {}", error))?;
            let mut launch_command = format!("\"{}\"", executable.display());
            if settings.start_minimized {
                launch_command.push_str(" --background");
            }
            let output = Command::new("reg.exe")
                .args(["ADD", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", &launch_command, "/f"])
                .output()
                .map_err(|error| format!("Could not update Windows startup registration: {}", error))?;
            if !output.status.success() {
                return Err(format!("Windows rejected the startup entry: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        } else {
            // Removing a missing entry is intentionally idempotent.
            let _ = Command::new("reg.exe")
                .args(["DELETE", RUN_KEY, "/v", VALUE_NAME, "/f"])
                .output();
        }
    }
    #[cfg(not(target_os = "windows"))]
    if settings.launch_on_startup {
        return Err("Launch at Windows sign-in is only available on Windows.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<AppSettings, String> {
    // Frontend settings controls send small patches. Merge with persisted values
    // so toggling startup/tray does not reset unrelated IDM-style preferences.
    let mut merged = serde_json::to_value(state.get_settings())
        .map_err(|error| format!("Could not read current settings: {}", error))?;
    let patch = settings.as_object()
        .ok_or_else(|| "Settings payload must be a JSON object.".to_string())?;
    let target = merged.as_object_mut()
        .ok_or_else(|| "Stored settings are invalid.".to_string())?;
    for (key, value) in patch {
        target.insert(key.clone(), value.clone());
    }
    let normalized: AppSettings = serde_json::from_value(merged)
        .map_err(|error| format!("Invalid settings payload: {}", error))?;
    sync_windows_startup_registration(&normalized)?;
    let saved = state.save_settings(&normalized)?;
    let _ = app.emit("settings_updated", &saved);
    Ok(saved)
}

#[tauri::command]
pub fn reset_settings(app: AppHandle, state: State<'_, AppState>) -> Result<AppSettings, String> {
    sync_windows_startup_registration(&AppSettings::default())?;
    let saved = state.reset_settings()?;
    let _ = app.emit("settings_updated", &saved);
    Ok(saved)
}

#[tauri::command]
pub async fn validate_python_executable(
    python_path: String,
) -> Result<PythonValidationResult, String> {
    tokio::task::spawn_blocking(move || EngineManager::validate_python_executable(&python_path))
        .await
        .map_err(|e| format!("Python validation failed: {}", e))
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

fn invalidate_engine_status_cache(state: &AppState) {
    let mut cache = state
        .cached_engine_status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *cache = None;
}

#[tauri::command]
pub async fn check_engine_updates() -> Result<HashMap<String, EngineUpdateInfo>, String> {
    EngineManager::check_engine_updates().await
}

#[tauri::command]
pub async fn install_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    force: Option<bool>,
) -> Result<EngineUpdateResult, String> {
    let result = EngineManager::install_engine_async(Some(&app), &name, force.unwrap_or(false)).await;
    invalidate_engine_status_cache(&state);
    Ok(result)
}

#[tauri::command]
pub async fn install_all_engines(
    app: AppHandle,
    state: State<'_, AppState>,
    include_spotdl: Option<bool>,
    force: Option<bool>,
) -> Result<Vec<EngineUpdateResult>, String> {
    let results = EngineManager::install_all_required_async(
        Some(&app),
        include_spotdl.unwrap_or(true),
        force.unwrap_or(false),
    )
    .await;
    invalidate_engine_status_cache(&state);
    Ok(results)
}

#[tauri::command]
pub async fn update_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<EngineUpdateResult, String> {
    let result = EngineManager::update_engine_async(Some(&app), &name).await;
    invalidate_engine_status_cache(&state);
    Ok(result)
}

#[tauri::command]
pub async fn update_all_engines(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<EngineUpdateResult>, String> {
    let results = EngineManager::install_all_required_async(Some(&app), true, true).await;
    invalidate_engine_status_cache(&state);
    Ok(results)
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

#[cfg(target_os = "windows")]
fn win32_wide_null(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn win32_from_wide_buf(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}

#[tauri::command]
pub async fn select_directory() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| -> Result<Option<String>, String> {
        #[cfg(target_os = "windows")]
        {
            #[repr(C)]
            struct BrowseInfoW {
                hwnd_owner: *mut core::ffi::c_void,
                pidl_root: *mut core::ffi::c_void,
                psz_display_name: *mut u16,
                lpsz_title: *const u16,
                ul_flags: u32,
                lpfn: *const core::ffi::c_void,
                l_param: isize,
                i_image: i32,
            }
            #[link(name = "shell32")]
            extern "system" {
                fn SHBrowseForFolderW(lpbi: *mut BrowseInfoW) -> *mut core::ffi::c_void;
                fn SHGetPathFromIDListW(pidl: *const core::ffi::c_void, pszPath: *mut u16) -> i32;
            }
            #[link(name = "ole32")]
            extern "system" {
                fn CoInitializeEx(pvReserved: *mut core::ffi::c_void, dwCoInit: u32) -> i32;
                fn CoTaskMemFree(pv: *mut core::ffi::c_void);
            }

            unsafe {
                let _ = CoInitializeEx(std::ptr::null_mut(), 0x2); // COINIT_APARTMENTTHREADED
                let mut display_buf = vec![0u16; 260];
                let title_w = win32_wide_null("Select Download Folder");
                let mut bi = BrowseInfoW {
                    hwnd_owner: std::ptr::null_mut(),
                    pidl_root: std::ptr::null_mut(),
                    psz_display_name: display_buf.as_mut_ptr(),
                    lpsz_title: title_w.as_ptr(),
                    ul_flags: 0x0000_0040 | 0x0000_0001, // BIF_NEWDIALOGSTYLE | BIF_RETURNONLYFSDIRS
                    lpfn: std::ptr::null(),
                    l_param: 0,
                    i_image: 0,
                };
                let pidl = SHBrowseForFolderW(&mut bi);
                if pidl.is_null() {
                    return Ok(None);
                }
                let mut path_buf = vec![0u16; 32768];
                let ok = SHGetPathFromIDListW(pidl, path_buf.as_mut_ptr());
                CoTaskMemFree(pidl);
                if ok == 0 {
                    return Ok(None);
                }
                let selected = win32_from_wide_buf(&path_buf);
                if selected.is_empty() {
                    return Ok(None);
                }
                return Ok(Some(selected));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|e| format!("Directory picker failed: {}", e))?
}

#[tauri::command]
pub async fn browse_python_executable() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| -> Result<Option<String>, String> {
        #[cfg(target_os = "windows")]
        {
            #[repr(C)]
            struct OpenFileNameW {
                l_struct_size: u32,
                hwnd_owner: *mut core::ffi::c_void,
                h_instance: *mut core::ffi::c_void,
                lpstr_filter: *const u16,
                lpstr_custom_filter: *mut u16,
                n_max_cust_filter: u32,
                n_filter_index: u32,
                lpstr_file: *mut u16,
                n_max_file: u32,
                lpstr_file_title: *mut u16,
                n_max_file_title: u32,
                lpstr_initial_dir: *const u16,
                lpstr_title: *const u16,
                flags: u32,
                n_file_offset: u16,
                n_file_extension: u16,
                lpstr_def_ext: *const u16,
                l_cust_data: isize,
                lpfn_hook: *const core::ffi::c_void,
                lp_template_name: *const u16,
                pv_reserved: *mut core::ffi::c_void,
                dw_reserved: u32,
                flags_ex: u32,
            }
            #[link(name = "comdlg32")]
            extern "system" {
                fn GetOpenFileNameW(lpofn: *mut OpenFileNameW) -> i32;
            }

            let filter_raw: Vec<u16> = "Python Executable (python.exe)\0python.exe;*.exe\0All Files (*.*)\0*.*\0\0"
                .encode_utf16()
                .collect();
            let title_w = win32_wide_null("Select Python Executable");
            let mut file_buf = vec![0u16; 32768];
            let mut ofn = OpenFileNameW {
                l_struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
                hwnd_owner: std::ptr::null_mut(),
                h_instance: std::ptr::null_mut(),
                lpstr_filter: filter_raw.as_ptr(),
                lpstr_custom_filter: std::ptr::null_mut(),
                n_max_cust_filter: 0,
                n_filter_index: 1,
                lpstr_file: file_buf.as_mut_ptr(),
                n_max_file: file_buf.len() as u32,
                lpstr_file_title: std::ptr::null_mut(),
                n_max_file_title: 0,
                lpstr_initial_dir: std::ptr::null(),
                lpstr_title: title_w.as_ptr(),
                flags: 0x0008_0000 | 0x0000_1000 | 0x0000_0800 | 0x0000_0008, // OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR
                n_file_offset: 0,
                n_file_extension: 0,
                lpstr_def_ext: std::ptr::null(),
                l_cust_data: 0,
                lpfn_hook: std::ptr::null(),
                lp_template_name: std::ptr::null(),
                pv_reserved: std::ptr::null_mut(),
                dw_reserved: 0,
                flags_ex: 0,
            };

            let ok = unsafe { GetOpenFileNameW(&mut ofn) };
            if ok == 0 {
                return Ok(None);
            }
            let selected = win32_from_wide_buf(&file_buf);
            if selected.is_empty() {
                return Ok(None);
            }
            return Ok(Some(selected));
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|e| format!("Python file picker failed: {}", e))?
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

#[tauri::command]
pub fn exit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.safe_shutdown();
    app.exit(0);
    Ok(())
}

pub fn schedule_next(app: &AppHandle, state: &AppState) {
    if state.is_shutting_down.load(Ordering::SeqCst) {
        return;
    }

    let settings = state.get_settings();
    let tasks = state.get_tasks();
    let paused_queues: HashSet<String> = state.get_queues().into_iter()
        .filter(|queue| queue.is_paused)
        .map(|queue| queue.id)
        .collect();

    let active_count = tasks.iter().filter(|t| t.status.is_active()).count();
    let max_concurrent = settings.max_concurrent_downloads.max(1) as usize;
    let available_slots = max_concurrent.saturating_sub(active_count);
    if available_slots == 0 {
        return;
    }

    let mut queued: Vec<DownloadTask> = tasks
        .into_iter()
        .filter(|t| t.status == TaskStatus::Queued && !paused_queues.contains(&t.queue_id))
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
        // schedule_next() is also called by synchronous Tauri commands, where
        // no Tokio reactor is entered on the calling thread. Use Tauri's
        // managed async runtime instead of tokio::spawn() directly.
        tauri::async_runtime::spawn(async move {
            run_download_task(app_clone, task_id).await;
        });
    }
}

async fn run_download_task(app: AppHandle, task_id: String) {
    let app_for_blocking = app.clone();
    let tid_for_blocking = task_id.clone();
    let worker_result = tokio::task::spawn_blocking(move || {
        run_download_task_blocking(&app_for_blocking, &tid_for_blocking);
    })
    .await;

    if let Err(join_error) = worker_result {
        let state = app.state::<AppState>();
        let reason = if join_error.is_panic() {
            format!("Download worker panicked: {}", join_error)
        } else {
            format!("Download worker could not complete: {}", join_error)
        };
        logging::error("queue", &format!("Task '{}' failed in background worker: {}", task_id, reason));

        if let Some(mut task) = state.get_task_by_id(&task_id) {
            if !matches!(task.status, TaskStatus::Paused | TaskStatus::Cancelled) {
                task.status = TaskStatus::Failed;
                task.current_phase = "Engine crashed".to_string();
                task.speed_str = "0 B/s".to_string();
                task.speed_bytes_per_sec = 0.0;
                task.eta_seconds = None;
                task.eta_str = "--".to_string();
                task.active_connections = 0;
                task.error_message = Some(reason);
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
            }
        }
    }

    let state = app.state::<AppState>();
    schedule_next(&app, &state);
}

fn collect_files_recursive(dir: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file() {
            output.push(path);
        } else if kind.is_dir() {
            collect_files_recursive(&path, depth + 1, output);
        }
    }
}

fn find_recent_output_file(dir: &Path, started_at_unix: i64, is_audio: bool) -> Option<PathBuf> {
    let mut files = Vec::new();
    collect_files_recursive(dir, 0, &mut files);
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let audio_exts = [
        "mp3", "flac", "wav", "m4a", "aac", "opus", "ogg", "oga", "aiff", "aif", "alac",
        "wma", "m4b",
    ];
    let media_exts = [
        "mp4", "mkv", "webm", "mov", "avi", "m4v", "flv", "mp3", "flac", "m4a", "opus",
        "ogg", "oga", "aiff", "aif", "alac", "wma", "m4b",
    ];
    for p in files {
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

fn snapshot_dir_file_sizes(dir: &Path) -> HashMap<PathBuf, u64> {
    let mut map = HashMap::new();
    let mut files = Vec::new();
    collect_files_recursive(dir, 0, &mut files);
    for path in files {
        if let Ok(meta) = fs::metadata(&path) {
            map.insert(path, meta.len());
        }
    }
    map
}

fn is_audio_output_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp3" | "flac" | "wav" | "m4a" | "aac" | "opus" | "ogg" | "oga" | "aiff" | "aif" | "alac" | "wma" | "m4b"
    )
}

fn measure_dir_growth_bytes(dir: &Path, baseline: &HashMap<PathBuf, u64>) -> u64 {
    let mut files = Vec::new();
    collect_files_recursive(dir, 0, &mut files);
    let mut total = 0u64;
    for path in files {
        if !is_audio_output_path(&path) {
            continue;
        }
        if let Ok(meta) = fs::metadata(&path) {
            let len = meta.len();
            let prev = baseline.get(&path).copied().unwrap_or(0);
            if len > prev {
                total = total.saturating_add(len - prev);
            }
        }
    }
    total
}

fn find_new_output_file(
    dir: &Path,
    baseline: &HashMap<PathBuf, u64>,
    is_audio: bool,
) -> Option<PathBuf> {
    let mut files = Vec::new();
    collect_files_recursive(dir, 0, &mut files);
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let audio_exts = ["mp3", "flac", "wav", "m4a", "aac", "opus", "ogg"];
    let media_exts = [
        "mp4", "mkv", "webm", "mov", "avi", "m4v", "flv", "mp3", "flac", "m4a", "opus",
    ];
    for p in files {
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
            if baseline.get(&p).map(|previous_size| *previous_size == meta.len()).unwrap_or(false) {
                continue;
            }
            if let Ok(mtime) = meta.modified() {
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
    best.map(|(_, p)| p)
}

fn promote_staged_output_tree(
    staging_root: &Path,
    destination_root: &Path,
    overwrite: bool,
) -> Result<HashMap<PathBuf, PathBuf>, String> {
    let mut files = Vec::new();
    collect_files_recursive(staging_root, 0, &mut files);
    let mut moved = HashMap::new();

    for source in files {
        let relative = source
            .strip_prefix(staging_root)
            .map_err(|e| format!("Invalid staged output path '{}': {}", source.display(), e))?;
        let mut destination = destination_root.join(relative);
        let parent = destination
            .parent()
            .ok_or_else(|| format!("Invalid destination path '{}'.", destination.display()))?;
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create output directory '{}': {}", parent.display(), e))?;

        if destination.exists() && !overwrite {
            let stem = destination.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
            let extension = destination.extension().and_then(|s| s.to_str());
            let mut index = 1u32;
            loop {
                let file_name = match extension {
                    Some(ext) => format!("{} ({}).{}", stem, index, ext),
                    None => format!("{} ({})", stem, index),
                };
                let candidate = parent.join(file_name);
                if !candidate.exists() {
                    destination = candidate;
                    break;
                }
                index = index.saturating_add(1);
            }
        } else if destination.exists() && overwrite {
            fs::remove_file(&destination).map_err(|e| {
                format!("Could not replace existing output '{}': {}", destination.display(), e)
            })?;
        }

        match fs::rename(&source, &destination) {
            Ok(()) => {}
            Err(rename_error) => {
                fs::copy(&source, &destination).map_err(|copy_error| {
                    format!(
                        "Could not move '{}' to '{}' (rename: {}; copy: {}).",
                        source.display(),
                        destination.display(),
                        rename_error,
                        copy_error
                    )
                })?;
                fs::remove_file(&source).map_err(|e| {
                    format!("Copied '{}' but could not remove staging copy: {}", source.display(), e)
                })?;
            }
        }
        moved.insert(source, destination);
    }

    if staging_root.exists() {
        fs::remove_dir_all(staging_root)
            .map_err(|e| format!("Outputs were moved, but staging cleanup failed: {}", e))?;
    }
    Ok(moved)
}

fn find_track_audio_output(dir: &Path, track_number: usize) -> Option<PathBuf> {
    let prefix = format!("{:02} - ", track_number);
    let mut files = Vec::new();
    collect_files_recursive(dir, 0, &mut files);
    files.into_iter()
        .filter(|path| {
            is_audio_output_path(path)
                && path.file_stem().and_then(|s| s.to_str())
                    .map(|stem| stem.starts_with(&prefix)).unwrap_or(false)
                && fs::metadata(path).map(|meta| meta.is_file() && meta.len() > 0).unwrap_or(false)
        })
        .max_by_key(|path| {
            fs::metadata(path).and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
        })
}

fn find_latest_audio_output_file(dir: &Path) -> Option<PathBuf> {
    let mut files = Vec::new();
    collect_files_recursive(dir, 0, &mut files);
    files.into_iter()
        .filter(|path| is_audio_output_path(path)
            && fs::metadata(path).map(|meta| meta.is_file() && meta.len() > 0).unwrap_or(false))
        .max_by_key(|path| {
            fs::metadata(path).and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
        })
}

fn parse_eta_str_seconds(eta_raw: &str) -> Option<u64> {
    let cleaned = eta_raw.trim();
    if cleaned.is_empty()
        || cleaned.eq_ignore_ascii_case("unknown")
        || cleaned.eq_ignore_ascii_case("na")
        || cleaned.eq_ignore_ascii_case("n/a")
        || cleaned == "--"
    {
        return None;
    }
    let parts: Vec<u64> = cleaned
        .split(':')
        .map(|p| p.trim().parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    match parts.len() {
        2 => Some(parts[0] * 60 + parts[1]),
        3 => Some(parts[0] * 3600 + parts[1] * 60 + parts[2]),
        _ => None,
    }
}

fn extract_bracket_ytdlp_metrics(line: &str) -> Option<(Option<f64>, u64, u64, f64, Option<String>)> {
    if !line.contains("[download]") || !line.contains('%') {
        return None;
    }
    let pct_pos = line.find('%')?;
    let before_pct = &line[..pct_pos];
    let pct_token = before_pct.split_whitespace().last()?;
    let pct_val = pct_token.parse::<f64>().ok().filter(|v| v.is_finite());

    let after_pct = &line[pct_pos + 1..];
    let total = if let Some(of_idx) = after_pct.find(" of ") {
        let rest = after_pct[of_idx + 4..].trim_start();
        let size_token = rest
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join("");
        // Handle "~ 12.3MiB" vs "12.3MiB"
        let first_tok = rest.split_whitespace().next().unwrap_or("");
        if first_tok == "~" {
            crate::parse_bytes(&size_token)
        } else {
            crate::parse_bytes(first_tok)
        }
    } else {
        0
    };

    let speed_bytes = if let Some(at_idx) = after_pct.find(" at ") {
        let rest = after_pct[at_idx + 4..].trim_start();
        let tok = rest.split_whitespace().next().unwrap_or("");
        crate::parse_bytes(tok.trim_end_matches("/s")) as f64
    } else {
        0.0
    };

    let eta_raw = after_pct.find(" ETA ").map(|eta_idx| {
        after_pct[eta_idx + 5..]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string()
    });

    let downloaded = if total > 0 {
        if let Some(p) = pct_val {
            ((p.clamp(0.0, 100.0) / 100.0) * (total as f64)).round() as u64
        } else {
            0
        }
    } else {
        0
    };

    Some((pct_val, downloaded, total, speed_bytes, eta_raw))
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

    logging::info("queue", &format!("Worker started for task '{}'; engine='{}'.", task_id, task.engine));
    let settings = state.get_settings();
    if task.engine == "direct" {
        task.status = TaskStatus::Failed;
        task.current_phase = "Unsupported engine".to_string();
        task.error_message = Some(
            "Generic direct file downloads have been removed. VANTA only downloads video and music URLs via yt-dlp or spotDL."
                .to_string(),
        );
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let is_spotdl = task.engine == "spotdl" || crate::spotify::is_spotify_url(&task.url);
    let requires_ffmpeg = task.is_audio_only
        || is_spotdl
        || settings.embed_thumbnail
        || settings.embed_metadata
        || task.format_id == "best";

    logging::info("queue", &format!("Task '{}': checking required engines (ffmpeg={}, spotdl={}).", task_id, requires_ffmpeg, is_spotdl));
    if let Err(err_msg) = EngineManager::ensure_required_engines(requires_ffmpeg, is_spotdl) {
        logging::error("queue", &format!("Task '{}': engine preflight failed: {}", task_id, err_msg));
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(err_msg);
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    let destination_dir = PathBuf::from(&task.output_path);
    if let Err(e) = fs::create_dir_all(&destination_dir) {
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(format!("Failed creating output directory: {}", e));
        state.upsert_task(&task);
        let _ = app.emit("task_updated", &task);
        return;
    }

    // Keep partial downloads and temporary media out of the user-visible destination.
    // The task-specific folder survives pause/retry, and is promoted only after verification.
    let out_dir = std::env::temp_dir()
        .join("VANTA")
        .join("staging")
        .join(&task.id);
    if let Err(e) = fs::create_dir_all(&out_dir) {
        task.status = TaskStatus::Failed;
        task.current_phase = "Failed".to_string();
        task.error_message = Some(format!("Failed creating staging directory: {}", e));
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

    if is_spotdl {
        let (exec_path, leading_args) = match EngineManager::resolve_spotdl_invocation(&settings) {
            Ok(pair) => pair,
            Err(e) => {
                task.status = TaskStatus::Failed;
                task.current_phase = "Failed".to_string();
                task.error_message = Some(e);
                state.upsert_task(&task);
                let _ = app.emit("task_updated", &task);
                return;
            }
        };

        let ordered_tracks: Vec<String> = task
            .selected_items
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if !ordered_tracks.is_empty() {
            let total_tracks = ordered_tracks.len() as u32;
            let format = task
                .audio_format
                .clone()
                .unwrap_or_else(|| settings.default_audio_format.clone());
            let bitrate = task
                .audio_bitrate
                .clone()
                .unwrap_or_else(|| settings.default_audio_bitrate.clone());

            let list_folder_name = crate::sanitize_filename(&task.title);
            let track_dir = if !list_folder_name.is_empty()
                && matches!(
                    task.content_type.as_deref(),
                    Some("album") | Some("playlist")
                ) {
                out_dir.join(list_folder_name)
            } else {
                out_dir.clone()
            };
            let _ = fs::create_dir_all(&track_dir);

            let ffmpeg_bin = EngineManager::find_executable("ffmpeg");
            let started_unix = chrono::Utc::now().timestamp();
            let started_instant = Instant::now();
            let mut completed_count = 0u32;
            let mut failed_count = 0u32;
            let mut last_error = String::new();
            let mut last_output_file: Option<PathBuf> = None;
            let mut accumulated_completed_bytes: u64 = 0;

            for (idx, track_url) in ordered_tracks.iter().enumerate() {
                if state.is_shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(cur) = state.get_task_by_id(task_id) {
                    if matches!(cur.status, TaskStatus::Paused | TaskStatus::Cancelled) {
                        return;
                    }
                }

                let track_started_unix = chrono::Utc::now().timestamp();
                let dir_baseline = snapshot_dir_file_sizes(&track_dir);
                if let Some(existing_output) = find_track_audio_output(&track_dir, idx + 1) {
                    completed_count += 1;
                    if let Ok(meta) = fs::metadata(&existing_output) {
                        accumulated_completed_bytes = accumulated_completed_bytes.saturating_add(meta.len());
                    }
                    last_output_file = Some(existing_output);
                    continue;
                }
                let mut prev_track_bytes: u64 = 0;
                let mut prev_sample_at = Instant::now();
                let mut last_emit_at = Instant::now();
                let mut ema_speed: f64 = 0.0;

                let mut cur = state.get_task_by_id(task_id).unwrap_or_else(|| task.clone());
                cur.status = TaskStatus::Downloading;
                cur.tracks_requested = Some(total_tracks);
                cur.tracks_completed = Some(completed_count);
                cur.tracks_failed = Some(failed_count);
                cur.percentage_known = true;
                cur.progress_percentage = ((idx as f64) / (total_tracks as f64)) * 100.0;
                cur.current_phase = format!("Downloading track {} of {}...", idx + 1, total_tracks);
                state.upsert_task(&cur);
                let _ = app.emit("task_updated", &cur);

                let output_template = track_dir.join(format!("{:02} - {{artists}} - {{title}}.{{output-ext}}", idx + 1));
                let mut args = leading_args.clone();
                args.extend([
                    "download".to_string(),
                    track_url.clone(),
                    "--output".to_string(),
                    output_template.to_string_lossy().to_string(),
                    "--format".to_string(),
                    format.clone(),
                    "--bitrate".to_string(),
                    bitrate.clone(),
                    "--log-level".to_string(),
                    "INFO".to_string(),
                ]);
                if let Some(ref ff) = ffmpeg_bin {
                    args.push("--ffmpeg".to_string());
                    args.push(ff.to_string_lossy().to_string());
                }

                let mut cmd = Command::new(&exec_path);
                cmd.args(&args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                EngineManager::apply_engine_env(&mut cmd);
                process::configure_background_command(&mut cmd);

                match cmd.spawn() {
                    Ok(child) => {
                        let pid = child.id();
                        {
                            let mut procs = state.active_processes.lock().unwrap_or_else(|e| e.into_inner());
                            procs.insert(task_id.to_string(), pid);
                        }
                        let stop_after_spawn = state
                            .get_task_by_id(task_id)
                            .map(|current| matches!(current.status, TaskStatus::Paused | TaskStatus::Cancelled))
                            .unwrap_or(true);
                        if stop_after_spawn {
                            let mut procs = state.active_processes.lock().unwrap_or_else(|e| e.into_inner());
                            procs.remove(task_id);
                            drop(procs);
                            process::kill_process_tree(pid);
                            return;
                        }
                        let stream_res = process::stream_child_lines_with_tick(
                            child,
                            Duration::from_millis(400),
                            |line| {
                                if state.is_shutting_down.load(Ordering::SeqCst) {
                                    return false;
                                }
                                let Some(mut c) = state.get_task_by_id(task_id) else {
                                    return false;
                                };
                                if matches!(c.status, TaskStatus::Paused | TaskStatus::Cancelled) {
                                    return false;
                                }
                                let tr = line.trim();
                                if tr.contains("Converting") || tr.contains("Embedding") {
                                    c.current_phase = format!(
                                        "Track {}/{}: Embedding metadata...",
                                        idx + 1,
                                        total_tracks
                                    );
                                    state.upsert_task(&c);
                                    let _ = app.emit("task_updated", &c);
                                }
                                true
                            },
                            || {
                                if state.is_shutting_down.load(Ordering::SeqCst) {
                                    return false;
                                }
                                let Some(mut c) = state.get_task_by_id(task_id) else {
                                    return false;
                                };
                                if matches!(c.status, TaskStatus::Paused | TaskStatus::Cancelled) {
                                    return false;
                                }

                                let active_bytes = measure_dir_growth_bytes(&track_dir, &dir_baseline);
                                let dt = prev_sample_at.elapsed().as_secs_f64();
                                if dt >= 0.35 && active_bytes >= prev_track_bytes {
                                    let delta = active_bytes - prev_track_bytes;
                                    let inst_speed = delta as f64 / dt;
                                    ema_speed = if ema_speed == 0.0 {
                                        inst_speed
                                    } else {
                                        0.35 * inst_speed + 0.65 * ema_speed
                                    };
                                    prev_track_bytes = active_bytes;
                                    prev_sample_at = Instant::now();
                                }

                                if last_emit_at.elapsed() >= Duration::from_millis(350) {
                                    last_emit_at = Instant::now();
                                    c.status = TaskStatus::Downloading;
                                    c.downloaded_bytes = accumulated_completed_bytes.saturating_add(active_bytes);
                                    c.speed_bytes_per_sec = ema_speed;
                                    c.speed_str = format!("{}/s", format_bytes_rust(ema_speed));
                                    c.elapsed_seconds = started_instant.elapsed().as_secs();
                                    c.last_progress_at = Some(chrono::Utc::now().to_rfc3339());
                                    state.upsert_task(&c);
                                    let _ = app.emit("task_updated", &c);
                                }
                                true
                            },
                        );
                        {
                            let mut procs = state.active_processes.lock().unwrap_or_else(|e| e.into_inner());
                            procs.remove(task_id);
                        }
                        if let Some(c) = state.get_task_by_id(task_id) {
                            if matches!(c.status, TaskStatus::Paused | TaskStatus::Cancelled)
                                || state.is_shutting_down.load(Ordering::SeqCst)
                            {
                                return;
                            }
                        }
                        match &stream_res {
                            Ok((st, diagnostic)) => {
                                let clean = logging::redact_secrets(diagnostic);
                                let tail = clean.lines().rev().take(6).collect::<Vec<_>>()
                                    .into_iter().rev().collect::<Vec<_>>().join(" | ");
                                logging::info(
                                    "queue",
                                    &format!(
                                        "spotDL task '{}', track {}/{}: exit={:?}, success={}, diagnostics='{}'",
                                        task_id, idx + 1, total_tracks, st.code(), st.success(), tail
                                    ),
                                );
                            }
                            Err(error) => logging::error(
                                "queue",
                                &format!(
                                    "spotDL task '{}', track {}/{}: stream failed: {}",
                                    task_id, idx + 1, total_tracks, logging::redact_secrets(error)
                                ),
                            ),
                        }
                        match stream_res {
                            Ok((st, _)) if st.success() => {
                                let newly_created = find_new_output_file(&track_dir, &dir_baseline, true)
                                    .or_else(|| find_recent_output_file(&track_dir, track_started_unix, true)
                                        .filter(|p| !dir_baseline.contains_key(p)))
                                    .or_else(|| find_track_audio_output(&track_dir, idx + 1));
                                if let Some(found) = newly_created {
                                    completed_count += 1;
                                    if let Ok(m) = fs::metadata(&found) {
                                        accumulated_completed_bytes = accumulated_completed_bytes.saturating_add(m.len());
                                    }
                                    last_output_file = Some(found);
                                } else {
                                    failed_count += 1;
                                    last_error = format!("Track {} exited without an output file", idx + 1);
                                }
                            }
                            Ok((st, err_txt)) => {
                                failed_count += 1;
                                last_error = logging::redact_secrets(&err_txt);
                                if last_error.is_empty() {
                                    last_error = format!("Track {} exited with code {:?}", idx + 1, st.code());
                                }
                            }
                            Err(e) => {
                                failed_count += 1;
                                last_error = logging::redact_secrets(&e);
                            }
                        }
                    }
                    Err(e) => {
                        failed_count += 1;
                        last_error = format!("Failed to spawn spotDL for track {}: {}", idx + 1, e);
                    }
                }
            }

            let mut final_t = state.get_task_by_id(task_id).unwrap_or(task);
            final_t.tracks_requested = Some(total_tracks);
            final_t.tracks_completed = Some(completed_count);
            final_t.tracks_failed = Some(failed_count);
            final_t.active_connections = 0;
            final_t.speed_bytes_per_sec = 0.0;
            final_t.speed_str = "0 B/s".to_string();

            if failed_count > 0 || completed_count < total_tracks {
                final_t.status = TaskStatus::Failed;
                final_t.current_phase = format!(
                    "Partial completion ({}/{} tracks completed, {} failed)",
                    completed_count, total_tracks, failed_count
                );
                final_t.percentage_known = true;
                final_t.progress_percentage = ((completed_count as f64) / (total_tracks as f64)) * 100.0;
                final_t.error_message = Some(format!(
                    "{} of {} tracks succeeded; {} failed. {}",
                    completed_count, total_tracks, failed_count, last_error
                ));
                // Keep partial files in private staging for retry; the user-visible
                // output directory must never point into the temporary area.
                state.upsert_task(&final_t);
                let _ = app.emit("task_updated", &final_t);
            } else {
                let final_file = last_output_file
                    .as_ref()
                    .cloned()
                    .or_else(|| find_recent_output_file(&track_dir, started_unix, true));
                if let Some(ref fp) = final_file {
                    if let Some((audio_sum, acodec, _vcodec, _res)) = EngineManager::verify_media_file(fp) {
                        final_t.verified_audio_info = audio_sum;
                        final_t.audio_codec = acodec;
                    }
                }
                let relative_track_dir = track_dir.strip_prefix(&out_dir).unwrap_or(Path::new(""));
                let moved_files = match promote_staged_output_tree(
                    &out_dir,
                    &destination_dir,
                    settings.conflict_strategy == "overwrite",
                ) {
                    Ok(files) => files,
                    Err(error) => {
                        final_t.status = TaskStatus::Failed;
                        final_t.current_phase = "Could not move completed files".to_string();
                        final_t.error_message = Some(error);
                        state.upsert_task(&final_t);
                        let _ = app.emit("task_updated", &final_t);
                        return;
                    }
                };
                if let (Some(content), Some(source_audio)) =
                    (final_t.lyrics_lrc_content.as_deref(), last_output_file.as_ref())
                {
                    if let Some(promoted_audio) = moved_files.get(source_audio) {
                        if let Err(error) = write_lrc_assets(promoted_audio, content) {
                            final_t.status = TaskStatus::Failed;
                            final_t.current_phase = "Could not write LRC sidecar".to_string();
                            final_t.error_message = Some(error);
                            state.upsert_task(&final_t);
                            let _ = app.emit("task_updated", &final_t);
                            return;
                        }
                    }
                    final_t.lyrics_lrc_content = None;
                }
                final_t.output_path = destination_dir.join(relative_track_dir).to_string_lossy().to_string();
                final_t.status = TaskStatus::Completed;
                final_t.progress_percentage = 100.0;
                final_t.percentage_known = true;
                final_t.downloaded_bytes = accumulated_completed_bytes;
                final_t.total_bytes = accumulated_completed_bytes;
                final_t.remaining_bytes = 0;
                final_t.eta_seconds = Some(0);
                final_t.eta_str = "Finished".to_string();
                final_t.current_phase = format!("Completed ({}/{} tracks)", completed_count, total_tracks);
                final_t.completed_at = Some(chrono::Utc::now().to_rfc3339());
                state.upsert_task(&final_t);
                let _ = app.emit("task_updated", &final_t);
            }
            return;
        }
    }

    let (exec_path, args) = if is_spotdl {
        let (spotdl_prog, leading_args) = match EngineManager::resolve_spotdl_invocation(&settings) {
            Ok(pair) => pair,
            Err(e) => {
                task.status = TaskStatus::Failed;
                task.error_message = Some(e);
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

        let mut args = leading_args;
        args.extend([
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
        ]);
        if let Some(ff) = EngineManager::find_executable("ffmpeg") {
            args.push("--ffmpeg".to_string());
            args.push(ff.to_string_lossy().to_string());
        }
        (spotdl_prog, args)
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
            "--no-quiet".to_string(),
            "--progress".to_string(),
            "--newline".to_string(),
            "--no-colors".to_string(),
            "--progress-delta".to_string(),
            "0.2".to_string(),
            "--progress-template".to_string(),
            "download:%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s".to_string(),
            "--print".to_string(),
            "before_dl:VANTA_META:%(id)s\t%(title)s\t%(uploader)s\t%(duration)s\t%(thumbnail)s".to_string(),
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

        if task.playlist_mode.as_deref() == Some("playlist") {
            args.push("--yes-playlist".to_string());
            if let Some(ref items) = task.selected_items {
                let cleaned: Vec<String> = items
                    .iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !cleaned.is_empty() {
                    args.push("--playlist-items".to_string());
                    args.push(cleaned.join(","));
                }
            }
        } else {
            args.push("--no-playlist".to_string());
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
            // Avoid stale cached extractor responses on retry. YouTube player clients
            // are selected centrally by build_ytdlp_request_args for inspection and download.
            args.push("--no-cache-dir".to_string());
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

        if !is_spotdl && !task.is_audio_only {
            args.extend(build_subtitle_args(
                &task.subtitle_languages,
                task.write_auto_subtitles,
            ));
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

    struct StreamLoopTelemetry {
        ema_speed: f64,
        stream_known_total: u64,
        stream_max_downloaded: u64,
        completed_stream_total: u64,
        completed_stream_downloaded: u64,
        last_activity_at: Instant,
        last_emit_at: Instant,
        spotdl_prev_bytes: u64,
        spotdl_prev_sample: Instant,
        detected_output_path: Option<String>,
    }

    let started_unix = chrono::Utc::now().timestamp();
    let started_instant = Instant::now();
    let output_baseline = snapshot_dir_file_sizes(&out_dir);
    let spotdl_baseline = output_baseline.clone();

    let loop_telemetry = std::cell::RefCell::new(StreamLoopTelemetry {
        ema_speed: 0.0,
        stream_known_total: 0,
        stream_max_downloaded: 0,
        completed_stream_total: 0,
        completed_stream_downloaded: 0,
        last_activity_at: Instant::now(),
        last_emit_at: Instant::now(),
        spotdl_prev_bytes: 0,
        spotdl_prev_sample: Instant::now(),
        detected_output_path: None,
    });

    task.status = TaskStatus::Connecting;
    task.current_phase = "Connecting to media extractor...".to_string();
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

    let stop_after_spawn = state
        .get_task_by_id(task_id)
        .map(|current| matches!(current.status, TaskStatus::Paused | TaskStatus::Cancelled))
        .unwrap_or(true);
    if stop_after_spawn {
        let mut procs = state.active_processes.lock().unwrap_or_else(|e| e.into_inner());
        procs.remove(task_id);
        drop(procs);
        process::kill_process_tree(pid);
        return;
    }

    let stream_res = process::stream_child_lines_with_tick(
        child,
        Duration::from_millis(350),
        |line| {
            if state.is_shutting_down.load(Ordering::SeqCst) {
                return false;
            }

            let mut current = match state.get_task_by_id(task_id) {
                Some(t) => t,
                None => return false,
            };

            if matches!(current.status, TaskStatus::Paused | TaskStatus::Cancelled) {
                return false;
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                return true;
            }

            let mut tel = loop_telemetry.borrow_mut();

            if is_spotdl {
                current.percentage_known = false;
                if trimmed.contains("Searching for") || trimmed.contains("Found") {
                    tel.last_activity_at = Instant::now();
                    current.status = TaskStatus::Connecting;
                    current.current_phase = "Matching audio source...".to_string();
                    state.upsert_task(&current);
                    let _ = app.emit("task_updated", &current);
                    tel.last_emit_at = Instant::now();
                } else if trimmed.contains("Downloading") {
                    tel.last_activity_at = Instant::now();
                    current.status = TaskStatus::Downloading;
                    current.current_phase = "Downloading audio stream...".to_string();
                    state.upsert_task(&current);
                    let _ = app.emit("task_updated", &current);
                    tel.last_emit_at = Instant::now();
                } else if trimmed.contains("Converting") || trimmed.contains("Embedding") {
                    tel.last_activity_at = Instant::now();
                    current.status = TaskStatus::Processing;
                    current.current_phase = "Embedding metadata & artwork...".to_string();
                    current.speed_bytes_per_sec = 0.0;
                    current.speed_str = "0 B/s".to_string();
                    state.upsert_task(&current);
                    let _ = app.emit("task_updated", &current);
                    tel.last_emit_at = Instant::now();
                }
                return true;
            }

            if let Some(meta_raw) = trimmed.strip_prefix("VANTA_META:") {
                let fields: Vec<&str> = meta_raw.split('\t').collect();
                let mut changed = false;
                if let Some(title_raw) = fields.get(1).map(|s| s.trim()) {
                    if !title_raw.is_empty()
                        && title_raw != "NA"
                        && crate::is_placeholder_task_title(&current.title)
                    {
                        current.title = title_raw.to_string();
                        changed = true;
                    }
                }
                if let Some(up_raw) = fields.get(2).map(|s| s.trim()) {
                    if !up_raw.is_empty() && up_raw != "NA" && current.uploader.is_none() {
                        current.uploader = Some(up_raw.to_string());
                        changed = true;
                    }
                }
                if let Some(dur_raw) = fields.get(3).map(|s| s.trim()) {
                    if current.duration.is_none() {
                        if let Ok(d_f) = dur_raw.parse::<f64>() {
                            if d_f.is_finite() && d_f > 0.0 {
                                let d_u = d_f.round() as u64;
                                current.duration = Some(d_u);
                                current.duration_string = Some(format_duration_rust(d_u));
                                changed = true;
                            }
                        }
                    }
                }
                if let Some(thumb_raw) = fields.get(4).map(|s| s.trim()) {
                    let cur_valid = current
                        .thumbnail
                        .as_deref()
                        .map(crate::is_valid_thumbnail_url)
                        .unwrap_or(false);
                    if !cur_valid && crate::is_valid_thumbnail_url(thumb_raw) {
                        current.thumbnail = Some(thumb_raw.to_string());
                        changed = true;
                    }
                }
                if changed {
                    state.upsert_task(&current);
                    let _ = app.emit("task_updated", &current);
                    tel.last_emit_at = Instant::now();
                }
                return true;
            }

            if let Some(printed) = trimmed.strip_prefix("VANTA_OUTPUT_FILE:") {
                let p = printed.trim();
                if !p.is_empty() {
                    tel.detected_output_path = Some(p.to_string());
                }
                return true;
            }

            if let Some(idx) = trimmed.find("Destination:") {
                let dest = trimmed[idx + "Destination:".len()..]
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'');
                if !dest.is_empty() {
                    if tel.detected_output_path.as_deref().map(|previous| previous != dest).unwrap_or(false) {
                        tel.completed_stream_downloaded = tel
                            .completed_stream_downloaded
                            .saturating_add(tel.stream_max_downloaded);
                        tel.completed_stream_total = tel
                            .completed_stream_total
                            .saturating_add(tel.stream_known_total);
                        tel.stream_known_total = 0;
                        tel.stream_max_downloaded = 0;
                    }
                    tel.detected_output_path = Some(dest.to_string());
                }
                tel.last_activity_at = Instant::now();
                current.status = TaskStatus::Downloading;
                current.current_phase = "Receiving media stream...".to_string();
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
                tel.last_emit_at = Instant::now();
                return true;
            }

            if let Some(idx) = trimmed.find("Merging formats into") {
                let dest = trimmed[idx + "Merging formats into".len()..]
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'');
                if !dest.is_empty() {
                    tel.detected_output_path = Some(dest.to_string());
                }
                tel.last_activity_at = Instant::now();
                current.status = TaskStatus::Muxing;
                current.current_phase = "Muxing video & audio streams...".to_string();
                current.speed_bytes_per_sec = 0.0;
                current.speed_str = "0 B/s".to_string();
                current.eta_seconds = None;
                current.eta_str = "--".to_string();
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
                tel.last_emit_at = Instant::now();
                return true;
            }

            if trimmed.contains("[Fixup")
                || trimmed.contains("[ExtractAudio]")
                || trimmed.contains("[Metadata]")
                || trimmed.contains("[EmbedThumbnail]")
            {
                tel.last_activity_at = Instant::now();
                current.status = TaskStatus::Processing;
                current.current_phase = if trimmed.contains("[EmbedThumbnail]") {
                    "Embedding cover thumbnail...".to_string()
                } else {
                    "Processing & embedding metadata...".to_string()
                };
                current.speed_bytes_per_sec = 0.0;
                current.speed_str = "0 B/s".to_string();
                current.eta_seconds = None;
                current.eta_str = "--".to_string();
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
                tel.last_emit_at = Instant::now();
                return true;
            }

            if let Some(item_pos) = trimmed.find("Downloading item ") {
                tel.last_activity_at = Instant::now();
                let item_part = &trimmed[item_pos..];
                current.status = TaskStatus::Downloading;
                current.current_phase = item_part.to_string();
                state.upsert_task(&current);
                let _ = app.emit("task_updated", &current);
                tel.last_emit_at = Instant::now();
                return true;
            }

            if trimmed.contains("[youtube]") || trimmed.contains("[info]") || trimmed.contains("Extracting URL:") {
                tel.last_activity_at = Instant::now();
                if matches!(current.status, TaskStatus::Connecting) {
                    current.current_phase = "Resolving media streams...".to_string();
                    state.upsert_task(&current);
                    let _ = app.emit("task_updated", &current);
                    tel.last_emit_at = Instant::now();
                }
                return true;
            }

            // Parse 7-field or 6-field pipe progress template OR standard [download] progress line
            let parsed_progress = if trimmed.contains('|') {
                let parts: Vec<&str> = trimmed.split('|').collect();
                if parts.len() >= 7 {
                    let pct_raw = parts[0].trim().trim_end_matches('%').trim();
                    let pct_val = pct_raw.parse::<f64>().ok().filter(|v| v.is_finite());
                    let downloaded = crate::parse_bytes(parts[1]);
                    let exact_total = crate::parse_bytes(parts[2]);
                    let est_total = crate::parse_bytes(parts[3]);
                    let total = if exact_total > 0 { exact_total } else { est_total };
                    let speed_bytes = crate::parse_bytes(parts[4].trim_end_matches("/s")) as f64;
                    let eta_raw = Some(parts[5].trim().to_string());
                    let phase = parts[6].trim().to_string();
                    Some((pct_val, downloaded, total, speed_bytes, eta_raw, phase))
                } else if parts.len() >= 6 {
                    let pct_raw = parts[0].trim().trim_end_matches('%').trim();
                    let pct_val = pct_raw.parse::<f64>().ok().filter(|v| v.is_finite());
                    let downloaded = crate::parse_bytes(parts[1]);
                    let total = crate::parse_bytes(parts[2]);
                    let speed_bytes = crate::parse_bytes(parts[3].trim_end_matches("/s")) as f64;
                    let eta_raw = Some(parts[4].trim().to_string());
                    let phase = parts[5].trim().to_string();
                    Some((pct_val, downloaded, total, speed_bytes, eta_raw, phase))
                } else {
                    None
                }
            } else {
                extract_bracket_ytdlp_metrics(trimmed).map(|(pct_val, dl, tot, spd, eta)| {
                    (pct_val, dl, tot, spd, eta, "downloading".to_string())
                })
            };

            if let Some((pct_val, raw_downloaded, raw_total, speed_bytes, eta_raw, phase_raw)) =
                parsed_progress
            {
                tel.last_activity_at = Instant::now();
                if raw_total > 0 {
                    tel.stream_known_total = tel.stream_known_total.max(raw_total);
                }
                if raw_total > tel.stream_known_total {
                    tel.stream_known_total = raw_total;
                }
                if raw_downloaded > tel.stream_max_downloaded {
                    tel.stream_max_downloaded = raw_downloaded;
                }
                let active_total = tel.stream_known_total.max(raw_total);
                let total = tel.completed_stream_total.saturating_add(active_total);
                let downloaded = tel
                    .completed_stream_downloaded
                    .saturating_add(tel.stream_max_downloaded.max(raw_downloaded));

                if speed_bytes > 0.0 {
                    tel.ema_speed = if tel.ema_speed == 0.0 {
                        speed_bytes
                    } else {
                        0.3 * speed_bytes + 0.7 * tel.ema_speed
                    };
                }

                let elapsed = started_instant.elapsed().as_secs();
                let remaining = total.saturating_sub(downloaded);
                let parsed_eta = eta_raw.as_deref().and_then(parse_eta_str_seconds);
                let computed_eta = if total > 0 && tel.ema_speed >= 1.0 && remaining > 0 {
                    Some((remaining as f64 / tel.ema_speed).ceil() as u64)
                } else {
                    parsed_eta
                };

                let pct_known = total > 0 || pct_val.is_some();
                let pct = if total > 0 {
                    ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
                } else {
                    pct_val.unwrap_or(0.0).clamp(0.0, 100.0)
                };

                let next_status = if phase_raw.eq_ignore_ascii_case("processing")
                    || phase_raw.eq_ignore_ascii_case("postprocessing")
                {
                    TaskStatus::Processing
                } else {
                    TaskStatus::Downloading
                };
                let next_phase = if phase_raw.eq_ignore_ascii_case("finished")
                    || phase_raw.eq_ignore_ascii_case("processing")
                {
                    "Finalizing downloaded stream...".to_string()
                } else {
                    "Downloading media stream...".to_string()
                };

                let phase_or_status_changed = current.status != next_status || current.current_phase != next_phase;
                current.status = next_status;
                current.downloaded_bytes = downloaded;
                current.total_bytes = total;
                current.remaining_bytes = remaining;
                current.percentage_known = pct_known;
                current.progress_percentage = pct;
                current.speed_bytes_per_sec = tel.ema_speed;
                current.avg_speed_bytes_per_sec = if elapsed > 0 {
                    downloaded as f64 / elapsed as f64
                } else {
                    tel.ema_speed
                };
                current.speed_str = format!("{}/s", format_bytes_rust(tel.ema_speed));
                current.eta_seconds = if total > 0 || pct_known { computed_eta } else { None };
                current.eta_str = if !pct_known {
                    "Unknown".to_string()
                } else {
                    current
                        .eta_seconds
                        .map(format_duration_rust)
                        .unwrap_or_else(|| "--".to_string())
                };
                current.elapsed_seconds = elapsed;
                current.active_connections = settings.fragment_concurrency.max(1);
                current.last_progress_at = Some(chrono::Utc::now().to_rfc3339());
                current.current_phase = next_phase;

                if phase_or_status_changed || tel.last_emit_at.elapsed() >= Duration::from_millis(200) {
                    tel.last_emit_at = Instant::now();
                    state.upsert_task(&current);
                    let _ = app.emit("task_updated", &current);
                }
            }

            true
        },
        || {
            if state.is_shutting_down.load(Ordering::SeqCst) {
                return false;
            }
            let Some(mut cur) = state.get_task_by_id(task_id) else {
                return false;
            };
            if matches!(cur.status, TaskStatus::Paused | TaskStatus::Cancelled) {
                return false;
            }

            let mut tel = loop_telemetry.borrow_mut();

            if is_spotdl {
                let active_bytes = measure_dir_growth_bytes(&out_dir, &spotdl_baseline);
                let dt = tel.spotdl_prev_sample.elapsed().as_secs_f64();
                if dt >= 0.35 && active_bytes >= tel.spotdl_prev_bytes {
                    let delta = active_bytes - tel.spotdl_prev_bytes;
                    if delta > 0 {
                        tel.last_activity_at = Instant::now();
                    }
                    let inst_speed = delta as f64 / dt;
                    tel.ema_speed = if tel.ema_speed == 0.0 {
                        inst_speed
                    } else {
                        0.35 * inst_speed + 0.65 * tel.ema_speed
                    };
                    tel.spotdl_prev_bytes = active_bytes;
                    tel.spotdl_prev_sample = Instant::now();
                }

                if active_bytes > 0 && tel.last_emit_at.elapsed() >= Duration::from_millis(350) {
                    tel.last_emit_at = Instant::now();
                    cur.status = TaskStatus::Downloading;
                    cur.percentage_known = false;
                    cur.downloaded_bytes = active_bytes;
                    cur.speed_bytes_per_sec = tel.ema_speed;
                    cur.speed_str = format!("{}/s", format_bytes_rust(tel.ema_speed));
                    cur.elapsed_seconds = started_instant.elapsed().as_secs();
                    cur.last_progress_at = Some(chrono::Utc::now().to_rfc3339());
                    state.upsert_task(&cur);
                    let _ = app.emit("task_updated", &cur);
                }
            } else if tel.last_activity_at.elapsed() >= Duration::from_secs(15)
                && matches!(cur.status, TaskStatus::Connecting | TaskStatus::Downloading)
                && cur.current_phase != "Waiting for remote server response..."
            {
                cur.current_phase = "Waiting for remote server response...".to_string();
                cur.speed_bytes_per_sec = 0.0;
                cur.speed_str = "0 B/s".to_string();
                state.upsert_task(&cur);
                let _ = app.emit("task_updated", &cur);
                tel.last_emit_at = Instant::now();
            }

            true
        },
    );

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

    if matches!(t.status, TaskStatus::Cancelled | TaskStatus::Paused | TaskStatus::Queued)
        || (t.status == TaskStatus::Connecting && t.current_phase == "Starting engine...")
        || state.is_shutting_down.load(Ordering::SeqCst)
    {
        return;
    }

    let detected_output_path = loop_telemetry.into_inner().detected_output_path;

    if is_spotdl {
        match &stream_res {
            Ok((status, diagnostic)) => {
                let clean = logging::redact_secrets(diagnostic);
                let tail = clean.lines().rev().take(8).collect::<Vec<_>>()
                    .into_iter().rev().collect::<Vec<_>>().join(" | ");
                logging::info(
                    "queue",
                    &format!(
                        "spotDL task '{}': process exit={:?}, success={}, output scan starting; diagnostics='{}'",
                        task_id, status.code(), status.success(), tail
                    ),
                );
            }
            Err(error) => logging::error(
                "queue",
                &format!("spotDL task '{}': process wait/stream failed: {}", task_id, logging::redact_secrets(error)),
            ),
        }
    }

    match stream_res {
        Ok((status, _err_log)) if status.success() => {
            let candidate_path = detected_output_path
                .map(PathBuf::from)
                .filter(|p| p.is_file())
                .or_else(|| find_new_output_file(&out_dir, &output_baseline, t.is_audio_only))
                .or_else(|| find_recent_output_file(&out_dir, started_unix, t.is_audio_only)
                    .filter(|p| !output_baseline.contains_key(p)))
                .or_else(|| if is_spotdl { find_latest_audio_output_file(&out_dir) } else { None });

            let valid_file = candidate_path.and_then(|p| {
                fs::metadata(&p)
                    .ok()
                    .filter(|m| m.is_file() && m.len() > 0)
                    .map(|m| (p, m.len()))
            });

            let Some((final_path, file_size)) = valid_file else {
                t.status = TaskStatus::Failed;
                t.current_phase = "Verification failed".to_string();
                t.error_message = Some(format!(
                    "Engine exited successfully, but no new non-empty media file was detected in staging '{}'. Existing files were excluded; check the engine log for the actual output path.",
                    out_dir.display()
                ));
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

            let moved_files = match promote_staged_output_tree(
                &out_dir,
                &destination_dir,
                settings.conflict_strategy == "overwrite",
            ) {
                Ok(files) => files,
                Err(error) => {
                    t.status = TaskStatus::Failed;
                    t.current_phase = "Could not move completed file".to_string();
                    t.error_message = Some(error);
                    state.upsert_task(&t);
                    let _ = app.emit("task_updated", &t);
                    return;
                }
            };
            let Some(final_path) = moved_files.get(&final_path).cloned() else {
                t.status = TaskStatus::Failed;
                t.current_phase = "Output promotion verification failed".to_string();
                t.error_message = Some("The verified file was not present in the staging promotion map.".to_string());
                state.upsert_task(&t);
                let _ = app.emit("task_updated", &t);
                return;
            };
            let file_size = fs::metadata(&final_path).map(|meta| meta.len()).unwrap_or(file_size);
            if let Some(content) = t.lyrics_lrc_content.take() {
                if let Err(error) = write_lrc_assets(&final_path, &content) {
                    t.status = TaskStatus::Failed;
                    t.current_phase = "Could not write LRC sidecar".to_string();
                    t.error_message = Some(error);
                    state.upsert_task(&t);
                    let _ = app.emit("task_updated", &t);
                    return;
                }
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

#[cfg(test)]
mod subtitle_and_lyrics_tests {
    use super::*;

    #[test]
    fn parses_multiple_lrc_timestamps_and_offsets() {
        let content = "[offset:100]\n[00:01.2][00:02.34]Hello\n[00:03,005]World\n[ar:Artist]";
        assert_eq!(parse_lrc_entries(content), vec![
            (1300, "Hello".to_string()),
            (2440, "Hello".to_string()),
            (3105, "World".to_string()),
        ]);
    }

    #[test]
    fn builds_embedded_subtitle_arguments_with_default_track() {
        let args = build_subtitle_args(&["en".to_string(), "fa".to_string()], true);
        assert!(args.contains(&"--write-subs".to_string()));
        assert!(args.contains(&"--write-auto-subs".to_string()));
        assert!(args.contains(&"--embed-subs".to_string()));
        assert!(args.contains(&"--remux-video".to_string()));
        assert!(args.windows(2).any(|pair| pair[0] == "--ppa"
            && pair[1] == "EmbedSubtitle+ffmpeg_o:-disposition:s:0 default"));
        assert_eq!(build_subtitle_args(&[], false), Vec::<String>::new());
    }
}
