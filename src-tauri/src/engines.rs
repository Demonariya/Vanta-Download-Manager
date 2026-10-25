use crate::{
    models::{DiagnosticResult, DownloadTask, EngineInfo, EngineType, EngineUpdateResult, EngineStatusMap, FormatOption, MediaMetadata, TaskStatus},
    state::{AppState, ControlAction},
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::watch,
    time::sleep,
};

fn executable_names(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string()];
    #[cfg(target_os = "windows")]
    if !name.to_ascii_lowercase().ends_with(".exe") {
        names.insert(0, format!("{name}.exe"));
    }
    names
}

pub fn find_executable(app: &AppHandle, state: &AppState, name: &str) -> Option<PathBuf> {
    let names = executable_names(name);
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("bin"));
        dirs.push(resource_dir.clone());
        dirs.push(resource_dir.join("resources").join("bin"));
        dirs.push(resource_dir.join("resources"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("bin"));
            dirs.push(parent.join("resources").join("bin"));
            dirs.push(parent.join("resources"));
        }
    }
    dirs.push(state.data_dir.join("engines").join("bin"));
    dirs.push(state.data_dir.join("engines").join("spotdl").join(".venv").join("Scripts"));
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }

    for dir in dirs {
        for filename in &names {
            let candidate = dir.join(filename);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

async fn run_output(path: &Path, args: &[String]) -> Result<std::process::Output, String> {
    Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("Could not execute {}: {e}", path.display()))
}

async fn engine_info(app: &AppHandle, state: &AppState, name: &str, version_args: &[&str]) -> EngineInfo {
    let now = chrono::Utc::now().to_rfc3339();
    let Some(path) = find_executable(app, state, name) else {
        return EngineInfo {
            available: false, version: String::new(), path: String::new(),
            status: "missing".into(), last_checked: now,
            error: Some(format!("{name} was not found in bundled resources or PATH.")),
            latest_version: None, update_available: None, is_updating: Some(false),
        };
    };
    let args: Vec<String> = version_args.iter().map(|s| s.to_string()).collect();
    match run_output(&path, &args).await {
        Ok(output) if output.status.success() => {
            let text = if output.stdout.is_empty() { String::from_utf8_lossy(&output.stderr).to_string() } else { String::from_utf8_lossy(&output.stdout).to_string() };
            let version = text.lines().next().unwrap_or("").trim().to_string();
            EngineInfo {
                available: true, version, path: path.to_string_lossy().into_owned(),
                status: "ready".into(), last_checked: now, error: None,
                latest_version: None, update_available: None, is_updating: Some(false),
            }
        }
        Ok(output) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            EngineInfo {
                available: false, version: String::new(), path: path.to_string_lossy().into_owned(),
                status: "error".into(), last_checked: now,
                error: Some(if detail.is_empty() { format!("{name} exited with {}", output.status) } else { detail.chars().take(500).collect() }),
                latest_version: None, update_available: None, is_updating: Some(false),
            }
        }
        Err(error) => EngineInfo {
            available: false, version: String::new(), path: path.to_string_lossy().into_owned(),
            status: "error".into(), last_checked: now, error: Some(error),
            latest_version: None, update_available: None, is_updating: Some(false),
        },
    }
}

pub async fn get_engine_status(app: &AppHandle, state: &AppState) -> EngineStatusMap {
    let (ytdlp, spotdl, ffmpeg, ffprobe, python3) = tokio::join!(
        engine_info(app, state, "yt-dlp", &["--version"]),
        engine_info(app, state, "spotdl", &["--version"]),
        engine_info(app, state, "ffmpeg", &["-version"]),
        engine_info(app, state, "ffprobe", &["-version"]),
        engine_info(app, state, "python", &["--version"]),
    );
    EngineStatusMap { ytdlp, spotdl, ffmpeg, ffprobe, python3 }
}

pub async fn run_diagnostics(app: &AppHandle, state: &AppState) -> Vec<DiagnosticResult> {
    let checks = [
        ("yt-dlp", vec!["--version"]),
        ("spotdl", vec!["--version"]),
        ("ffmpeg", vec!["-version"]),
        ("ffprobe", vec!["-version"]),
        ("python", vec!["--version"]),
    ];
    let mut results = Vec::with_capacity(checks.len());
    for (name, args) in checks {
        let start = Instant::now();
        match find_executable(app, state, name) {
            None => results.push(DiagnosticResult {
                engine: name.into(), passed: false, version: None,
                command: format!("{name} {}", args.join(" ")),
                output: "Executable not found in application resources or PATH.".into(),
                duration_ms: start.elapsed().as_millis() as u64,
            }),
            Some(path) => {
                match run_output(&path, &args.iter().map(|x| x.to_string()).collect::<Vec<_>>()).await {
                    Ok(out) => {
                        let text = if out.stdout.is_empty() { String::from_utf8_lossy(&out.stderr).to_string() } else { String::from_utf8_lossy(&out.stdout).to_string() };
                        let first = text.lines().next().unwrap_or("").trim().to_string();
                        results.push(DiagnosticResult {
                            engine: name.into(), passed: out.status.success(),
                            version: if out.status.success() { Some(first) } else { None },
                            command: format!("{} {}", path.display(), args.join(" ")),
                            output: text.chars().take(1000).collect(),
                            duration_ms: start.elapsed().as_millis() as u64,
                        });
                    }
                    Err(error) => results.push(DiagnosticResult {
                        engine: name.into(), passed: false, version: None,
                        command: format!("{} {}", path.display(), args.join(" ")),
                        output: error.chars().take(1000).collect(),
                        duration_ms: start.elapsed().as_millis() as u64,
                    }),
                }
            }
        }
    }
    results
}

fn string_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(ToString::to_string).filter(|s| !s.is_empty())
}
fn u64_field(v: &Value, key: &str) -> Option<u64> { v.get(key).and_then(Value::as_u64) }
fn u32_field(v: &Value, key: &str) -> Option<u32> { v.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()) }
fn f64_field(v: &Value, key: &str) -> Option<f64> { v.get(key).and_then(Value::as_f64) }

fn parse_formats(raw: &Value) -> Vec<FormatOption> {
    raw.get("formats").and_then(Value::as_array).into_iter().flatten().filter_map(|format| {
        let format_id = string_field(format, "format_id")?;
        let ext = string_field(format, "ext").unwrap_or_else(|| "unknown".into());
        let vcodec = string_field(format, "vcodec");
        let acodec = string_field(format, "acodec");
        let is_audio_only = vcodec.as_deref() == Some("none") && acodec.as_deref().is_some_and(|s| s != "none");
        let is_video_only = acodec.as_deref() == Some("none") && vcodec.as_deref().is_some_and(|s| s != "none");
        let resolution = string_field(format, "resolution").or_else(|| u32_field(format, "height").map(|h| format!("{h}p")));
        Some(FormatOption {
            format_id, ext, resolution, width: u32_field(format, "width"),
            height: u32_field(format, "height"), fps: f64_field(format, "fps"),
            vcodec, acodec, filesize: u64_field(format, "filesize"),
            filesize_approx: u64_field(format, "filesize_approx"),
            tbr: f64_field(format, "tbr"), abr: f64_field(format, "abr"),
            format_note: string_field(format, "format_note"), is_audio_only, is_video_only,
        })
    }).collect()
}

fn format_duration(seconds: Option<u64>) -> Option<String> {
    seconds.map(|s| format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60))
}

pub async fn inspect_url(app: &AppHandle, state: &AppState, url: &str, proxy: &str) -> Result<MediaMetadata, String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Enter a valid HTTP or HTTPS media URL.".into());
    }
    if url.contains("open.spotify.com/") {
        return inspect_spotdl_url(app, state, url).await;
    }
    let executable = find_executable(app, state, "yt-dlp").ok_or_else(|| "yt-dlp is not installed. Open Engine Manager to configure it.".to_string())?;
    let mut args = vec![
        "--dump-single-json".into(), "--no-warnings".into(), "--skip-download".into(),
        "--no-simulate".into(), "--ignore-errors".into(),
    ];
    if !proxy.trim().is_empty() { args.extend(["--proxy".into(), proxy.into()]); }
    args.push(url.into());
    let output = run_output(&executable, &args).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp metadata extraction failed ({}): {}", output.status, stderr.chars().take(900).collect::<String>()));
    }
    let raw: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("yt-dlp returned invalid metadata JSON: {e}"))?;
    let entries = raw.get("entries").and_then(Value::as_array);
    let is_playlist = raw.get("_type").and_then(Value::as_str) == Some("playlist") || entries.is_some();
    let formats = parse_formats(&raw);
    Ok(MediaMetadata {
        url: url.into(),
        id: string_field(&raw, "id").unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        title: string_field(&raw, "title").unwrap_or_else(|| "Untitled media".into()),
        uploader: string_field(&raw, "uploader").or_else(|| string_field(&raw, "channel")).or_else(|| string_field(&raw, "artist")),
        duration: u64_field(&raw, "duration"),
        duration_string: format_duration(u64_field(&raw, "duration")),
        thumbnail: string_field(&raw, "thumbnail").or_else(|| raw.get("thumbnails").and_then(Value::as_array).and_then(|a| a.last()).and_then(|t| string_field(t, "url"))),
        description: string_field(&raw, "description").map(|s| s.chars().take(1000).collect()),
        formats,
        is_playlist,
        playlist_count: entries.map(|e| e.len()).or_else(|| u64_field(&raw, "playlist_count").and_then(|n| usize::try_from(n).ok())),
        extractor: string_field(&raw, "extractor_key").or_else(|| string_field(&raw, "extractor")).unwrap_or_else(|| "generic".into()),
    })
}

async fn inspect_spotdl_url(app: &AppHandle, state: &AppState, url: &str) -> Result<MediaMetadata, String> {
    let executable = find_executable(app, state, "spotdl").ok_or_else(|| "spotDL is not installed. Install it in the managed engine environment before inspecting Spotify links.".to_string())?;
    let temp_file = state.data_dir.join(format!("spotdl-metadata-{}.json", uuid::Uuid::new_v4()));
    let args = vec!["save".to_string(), url.to_string(), "--save-file".into(), temp_file.to_string_lossy().into_owned()];
    let output = run_output(&executable, &args).await?;
    let raw_text = if temp_file.is_file() {
        let content = tokio::fs::read_to_string(&temp_file).await.unwrap_or_default();
        let _ = tokio::fs::remove_file(&temp_file).await;
        content
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };
    if !output.status.success() {
        return Err(format!("spotDL metadata lookup failed: {}", String::from_utf8_lossy(&output.stderr).chars().take(900).collect::<String>()));
    }
    let parsed: Value = serde_json::from_str(&raw_text).map_err(|e| format!("spotDL did not return parseable metadata: {e}"))?;
    let item = parsed.as_array().and_then(|items| items.first()).unwrap_or(&parsed);
    let artists = item.get("artists").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "));
    let uploader = artists.filter(|s| !s.is_empty()).or_else(|| string_field(item, "artist"));
    let duration = u64_field(item, "duration");
    Ok(MediaMetadata {
        url: url.into(),
        id: string_field(item, "song_id").or_else(|| string_field(item, "id")).unwrap_or_else(|| url.rsplit('/').next().unwrap_or("spotify-item").split('?').next().unwrap_or("spotify-item").to_string()),
        title: string_field(item, "name").or_else(|| string_field(item, "title")).ok_or_else(|| "spotDL returned metadata without a title.".to_string())?,
        uploader,
        duration,
        duration_string: format_duration(duration),
        thumbnail: string_field(item, "cover_url").or_else(|| string_field(item, "thumbnail")),
        description: None,
        formats: Vec::new(),
        is_playlist: url.contains("/playlist/") || url.contains("/album/"),
        playlist_count: None,
        extractor: "spotdl".into(),
    })
}

pub fn emit_task(app: &AppHandle, state: &AppState, task: DownloadTask) {
    let _ = state.save_task(task.clone());
    let _ = app.emit("task_updated", &task);
}

fn parse_human_bytes(input: &str) -> Option<u64> {
    let token = input.trim().replace(',', "").trim_end_matches("/s").trim();
    let split_at = token.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '+'))?;
    let amount: f64 = token[..split_at].parse().ok()?;
    let unit = token[split_at..].trim().to_ascii_uppercase();
    let multiplier = match unit.as_str() {
        "" | "B" => 1.0,
        "KB" => 1_000.0, "MB" => 1_000_000.0, "GB" => 1_000_000_000.0,
        "KIB" => 1024.0, "MIB" => 1_048_576.0, "GIB" => 1_073_741_824.0,
        _ => return None,
    };
    Some((amount * multiplier).max(0.0) as u64)
}

fn parse_progress(task: &mut DownloadTask, line: &str) -> bool {
    let Some(payload) = line.strip_prefix("download:") else { return false; };
    let parts: Vec<&str> = payload.split('|').collect();
    if parts.len() < 5 { return false; }
    let percent = parts[0].trim().trim_end_matches('%').trim();
    if let Ok(value) = percent.parse::<f64>() {
        if value.is_finite() { task.progress_percentage = value.clamp(0.0, 100.0); }
    }
    if let Some(bytes) = parse_human_bytes(parts[1]) { task.downloaded_bytes = bytes; }
    if let Some(bytes) = parse_human_bytes(parts[2]) { task.total_bytes = bytes; }
    if let Some(speed) = parse_human_bytes(parts[3]) {
        task.speed_bytes_per_sec = speed as f64;
        task.speed_str = parts[3].trim().to_string();
    }
    task.eta_str = if parts[4].trim().is_empty() { "--:--".into() } else { parts[4].trim().to_string() };
    task.current_phase = "Downloading".into();
    true
}

fn update_state(app: &AppHandle, state: &AppState, id: &str, update: impl FnOnce(&mut DownloadTask)) -> Result<DownloadTask, String> {
    let mut task = state.task_by_id(id)?.ok_or_else(|| "Download task no longer exists.".to_string())?;
    update(&mut task);
    emit_task(app, state, task.clone());
    Ok(task)
}

fn output_template(task: &DownloadTask, settings: &crate::models::AppSettings) -> Result<(PathBuf, String), String> {
    let supplied = PathBuf::from(if task.output_path.trim().is_empty() { &settings.download_dir } else { &task.output_path });
    // Completed tasks store their final file in output_path. A retry must use the
    // containing directory, not accidentally create a directory named after the file.
    let file_like = supplied.is_file()
        || supplied.extension().and_then(|e| e.to_str()).is_some_and(|e| {
            matches!(e.to_ascii_lowercase().as_str(), "mp4" | "mkv" | "webm" | "mp3" | "m4a" | "aac" | "flac" | "wav" | "opus" | "ogg")
        });
    let dir = if file_like {
        supplied.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from(&settings.download_dir))
    } else {
        supplied
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create output directory {}: {e}", dir.display()))?;
    let template = if settings.filename_template.trim().is_empty() { "%(title)s [%(id)s].%(ext)s" } else { &settings.filename_template };
    let template_path = Path::new(template);
    if template_path.is_absolute() || template_path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err("Filename template must be a filename template, not an absolute path or a path traversal.".into());
    }
    Ok((dir.clone(), dir.join(template_path).to_string_lossy().into_owned()))
}

async fn terminate_process_tree(pid: Option<u32>, child: &mut tokio::process::Child) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        let _ = Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub async fn run_download_task(app: AppHandle, state: AppState, mut task: DownloadTask, mut control_rx: watch::Receiver<ControlAction>) {
    let settings = match state.settings_snapshot() {
        Ok(settings) => settings,
        Err(error) => {
            let _ = update_state(&app, &state, &task.id, |t| { t.status = TaskStatus::Failed; t.error_message = Some(error); });
            return;
        }
    };
    let started_at = SystemTime::now();
    let (out_dir, out_template) = match output_template(&task, &settings) {
        Ok(result) => result,
        Err(error) => {
            let _ = update_state(&app, &state, &task.id, |t| { t.status = TaskStatus::Failed; t.error_message = Some(error.clone()); t.current_phase = "Failed".into(); });
            state.add_notification("error", "Download failed", &error, Some(task.id.clone()));
            return;
        }
    };

    let (path, args) = if task.engine == EngineType::Spotdl {
        let Some(path) = find_executable(&app, &state, "spotdl") else {
            let msg = "spotDL executable was not found. Configure it in Engine Manager.".to_string();
            let _ = update_state(&app, &state, &task.id, |t| { t.status = TaskStatus::Failed; t.error_message = Some(msg.clone()); t.current_phase = "Failed".into(); });
            state.add_notification("error", "spotDL unavailable", &msg, Some(task.id.clone()));
            return;
        };
        let spot_template = out_dir.join("{artists} - {title}.{output-ext}").to_string_lossy().into_owned();
        (path, vec!["download".into(), task.url.clone(), "--output".into(), spot_template, "--format".into(), task.audio_format.clone().unwrap_or_else(|| settings.default_audio_format.clone())])
    } else {
        let Some(path) = find_executable(&app, &state, "yt-dlp") else {
            let msg = "yt-dlp executable was not found. Configure it in Engine Manager.".to_string();
            let _ = update_state(&app, &state, &task.id, |t| { t.status = TaskStatus::Failed; t.error_message = Some(msg.clone()); t.current_phase = "Failed".into(); });
            state.add_notification("error", "yt-dlp unavailable", &msg, Some(task.id.clone()));
            return;
        };
        let mut args = vec![
            "--newline".into(), "--no-colors".into(),
            "--progress-template".into(),
            "download:%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s".into(),
            "--print".into(), "after_move:VANTA_OUTPUT=%(filepath)s".into(),
            "--retries".into(), settings.max_retries.to_string(),
            "--fragment-retries".into(), settings.max_retries.to_string(),
            "--socket-timeout".into(), "30".into(),
            "--continue".into(), "-o".into(), out_template,
        ];
        if settings.fragment_concurrency > 1 {
            args.extend(["--concurrent-fragments".into(), settings.fragment_concurrency.to_string()]);
        }
        if settings.global_bandwidth_limit_kbps > 0 {
            args.extend(["--limit-rate".into(), format!("{}K", settings.global_bandwidth_limit_kbps)]);
        } else if settings.per_task_bandwidth_limit_kbps > 0 {
            args.extend(["--limit-rate".into(), format!("{}K", settings.per_task_bandwidth_limit_kbps)]);
        }
        if !settings.proxy_url.trim().is_empty() {
            args.extend(["--proxy".into(), settings.proxy_url.clone()]);
        }
        if settings.embed_metadata { args.push("--embed-metadata".into()); }
        if settings.embed_thumbnail { args.push("--embed-thumbnail".into()); }
        if task.is_audio_only {
            args.extend(["-x".into(), "--audio-format".into(), task.audio_format.clone().unwrap_or_else(|| settings.default_audio_format.clone())]);
            let audio = task.audio_format.as_deref().unwrap_or(&settings.default_audio_format);
            if !matches!(audio, "flac" | "wav") {
                args.extend(["--audio-quality".into(), task.audio_bitrate.clone().unwrap_or_else(|| settings.default_audio_bitrate.clone())]);
            }
            if task.format_id != "best" && task.format_id != "bestaudio" && task.format_id != "spotdl-best" {
                args.extend(["-f".into(), task.format_id.clone()]);
            } else {
                args.extend(["-f".into(), "bestaudio/best".into()]);
            }
        } else {
            if !task.format_id.trim().is_empty() { args.extend(["-f".into(), task.format_id.clone()]); }
            if matches!(task.ext.as_str(), "mp4" | "mkv" | "webm") {
                args.extend(["--merge-output-format".into(), task.ext.clone()]);
            }
        }
        args.push(task.url.clone());
        (path, args)
    };

    let begin_task = task.clone();
    let _ = update_state(&app, &state, &task.id, |t| {
        t.status = TaskStatus::Downloading;
        t.current_phase = "Downloading".into();
        t.error_message = None;
    });

    let mut child = match Command::new(&path)
        .args(&args)
        .current_dir(&out_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to start download engine {}: {error}", path.display());
            let _ = update_state(&app, &state, &begin_task.id, |t| { t.status = TaskStatus::Failed; t.error_message = Some(message.clone()); t.current_phase = "Failed".into(); });
            state.add_notification("error", "Could not start download", &message, Some(begin_task.id));
            return;
        }
    };

    let pid = child.id();
    let Some(stdout) = child.stdout.take() else {
        let message = "Download engine did not provide stdout.".to_string();
        terminate_process_tree(pid, &mut child).await;
        let _ = update_state(&app, &state, &task.id, |t| { t.status = TaskStatus::Failed; t.error_message = Some(message.clone()); });
        return;
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_process_tree(pid, &mut child).await;
        let _ = update_state(&app, &state, &task.id, |t| { t.status = TaskStatus::Failed; t.error_message = Some("Download engine did not provide stderr.".into()); });
        return;
    };

    let stderr_buffer = Arc::new(tokio::sync::Mutex::new(String::new()));
    let stderr_capture = Arc::clone(&stderr_buffer);
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut buf = stderr_capture.lock().await;
            if buf.len() < 64 * 1024 {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut output_path: Option<PathBuf> = None;
    let mut control: Option<ControlAction> = None;

    loop {
        tokio::select! {
            result = lines.next_line() => {
                match result {
                    Ok(Some(line)) => {
                        if let Some(path) = line.strip_prefix("VANTA_OUTPUT=") {
                            let candidate = PathBuf::from(path.trim());
                            output_path = Some(if candidate.is_absolute() { candidate } else { out_dir.join(candidate) });
                            continue;
                        }
                        if let Ok(mut current) = state.task_by_id(&task.id) {
                            if let Some(mut current_task) = current.take() {
                                if parse_progress(&mut current_task, &line) {
                                    task = current_task.clone();
                                    emit_task(&app, &state, current_task);
                                }
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let mut b = stderr_buffer.lock().await;
                        b.push_str(&format!("\nProgress pipe read failed: {error}"));
                        break;
                    }
                }
            }
            changed = control_rx.changed() => {
                if changed.is_ok() && *control_rx.borrow() != ControlAction::None {
                    control = Some(*control_rx.borrow());
                    terminate_process_tree(pid, &mut child).await;
                    break;
                }
            }
        }
    }

    if let Some(action) = control {
        let status = if action == ControlAction::Pause { TaskStatus::Paused } else { TaskStatus::Cancelled };
        let phase = if action == ControlAction::Pause { "Paused" } else { "Cancelled" };
        let _ = update_state(&app, &state, &task.id, |t| {
            t.status = status;
            t.current_phase = phase.into();
            t.speed_bytes_per_sec = 0.0;
            t.speed_str = "0 B/s".into();
            t.eta_str = "--:--".into();
        });
        return;
    }

    let status = child.wait().await;
    let _ = stderr_task.await;
    let stderr_text = stderr_buffer.lock().await.clone();
    let succeeded = matches!(&status, Ok(s) if s.success());

    if succeeded {
        if output_path.is_none() {
            output_path = find_newest_output(&out_dir, started_at);
        }
        if let Some(path) = output_path.filter(|p| p.is_file() && fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)) {
            let verified = verify_output(&app, &state, &path).await;
            let path_text = path.to_string_lossy().into_owned();
            let _ = update_state(&app, &state, &task.id, |t| {
                t.status = TaskStatus::Completed;
                t.progress_percentage = 100.0;
                t.current_phase = "Completed".into();
                t.output_path = path_text.clone();
                t.completed_at = Some(chrono::Utc::now().to_rfc3339());
                t.speed_bytes_per_sec = 0.0;
                t.speed_str = "0 B/s".into();
                t.eta_str = "00:00".into();
                t.error_message = None;
                if let Some(info) = verified.clone() { t.verified_audio_info = Some(info); }
            });
            state.add_notification("success", "Download completed", &format!("Saved: {}", path.display()), Some(task.id.clone()));
            if let Ok(items) = state.notifications_snapshot() {
                if let Some(item) = items.first() { let _ = app.emit("notification", item); }
            }
        } else {
            let message = "The engine exited successfully, but no valid, non-empty output file could be located. The task was not marked complete.".to_string();
            handle_failure(&app, &state, &task, message, &settings).await;
        }
    } else {
        let code = status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string());
        let trimmed = stderr_text.trim();
        let message = if trimmed.is_empty() {
            format!("Download engine exited unsuccessfully ({code}).")
        } else {
            trimmed.chars().rev().take(1600).collect::<String>().chars().rev().collect::<String>()
        };
        handle_failure(&app, &state, &task, message, &settings).await;
    }
}

fn find_newest_output(dir: &Path, since: SystemTime) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    entries.filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        if !path.is_file() || path.extension().is_some_and(|e| matches!(e.to_string_lossy().as_ref(), "part" | "ytdl" | "tmp")) { return None; }
        let meta = fs::metadata(&path).ok()?;
        let modified = meta.modified().ok()?;
        if modified < since || meta.len() == 0 { return None; }
        Some((modified, path))
    }).max_by_key(|(modified, _)| *modified).map(|(_, path)| path)
}

async fn verify_output(app: &AppHandle, state: &AppState, path: &Path) -> Option<String> {
    let probe = find_executable(app, state, "ffprobe")?;
    let output = run_output(&probe, &[
        "-v".into(), "error".into(),
        "-show_entries".into(), "format=format_name,duration:stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample".into(),
        "-of".into(), "json".into(),
        path.to_string_lossy().into_owned(),
    ]).await.ok()?;
    if !output.status.success() { return None; }
    let raw: Value = serde_json::from_slice(&output.stdout).ok()?;
    let format = raw.get("format").cloned().unwrap_or(Value::Null);
    let streams = raw.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
    let codec = streams.first().and_then(|s| string_field(s, "codec_name")).unwrap_or_else(|| "unknown codec".into());
    let rate = streams.first().and_then(|s| string_field(s, "sample_rate")).unwrap_or_else(|| "unknown".into());
    let channels = streams.first().and_then(|s| u32_field(s, "channels")).map(|n| n.to_string()).unwrap_or_else(|| "unknown".into());
    let bits = streams.first().and_then(|s| u32_field(s, "bits_per_raw_sample").or_else(|| u32_field(s, "bits_per_sample"))).map(|n| format!("{n}-bit")).unwrap_or_else(|| "bit depth unknown".into());
    Some(format!("codec={codec}; sample_rate={rate} Hz; channels={channels}; {bits}; container={}", string_field(&format, "format_name").unwrap_or_else(|| "unknown".into())))
}

async fn handle_failure(app: &AppHandle, state: &AppState, task: &DownloadTask, message: String, settings: &crate::models::AppSettings) {
    let should_retry = settings.auto_retry_failed && task.retries < task.max_retries && !message.to_ascii_lowercase().contains("unsupported url");
    if should_retry {
        let _ = update_state(app, state, &task.id, |t| {
            t.status = TaskStatus::Retrying;
            t.current_phase = "Retrying".into();
            t.retries += 1;
            t.error_message = Some(message.clone());
            t.speed_bytes_per_sec = 0.0;
            t.speed_str = "0 B/s".into();
        });
        state.add_notification("warning", "Download retry scheduled", &format!("Attempt {} of {} failed; retrying after a delay.", task.retries + 1, task.max_retries + 1), Some(task.id.clone()));
        sleep(Duration::from_secs(settings.retry_delay_seconds.min(300) as u64)).await;
        let _ = update_state(app, state, &task.id, |t| {
            t.status = TaskStatus::Queued;
            t.current_phase = "Queued for retry".into();
        });
    } else {
        let _ = update_state(app, state, &task.id, |t| {
            t.status = TaskStatus::Failed;
            t.current_phase = "Failed".into();
            t.error_message = Some(message.clone());
            t.speed_bytes_per_sec = 0.0;
            t.speed_str = "0 B/s".into();
            t.eta_str = "--:--".into();
        });
        state.add_notification("error", "Download failed", &message.chars().take(800).collect::<String>(), Some(task.id.clone()));
    }
}

pub async fn check_engine_updates(app: &AppHandle, state: &AppState) -> Result<serde_json::Value, String> {
    let status = get_engine_status(app, state).await;
    let entries = [
        ("ytdlp", "yt-dlp/yt-dlp", &status.ytdlp),
        ("spotdl", "spotDL/spotify-downloader", &status.spotdl),
        ("ffmpeg", "BtbN/FFmpeg-Builds", &status.ffmpeg),
    ];
    let mut map = serde_json::Map::new();
    for (key, repo, info) in entries {
        let latest = latest_github_tag(repo).await.ok();
        let mut latest_known = latest.clone();
        if key == "ffmpeg" && latest_known.as_deref() == Some("latest") { latest_known = None; }
        let update_available = match (&latest_known, &info.version) {
            (Some(latest), current) if !current.is_empty() => {
                let cur = current.trim().trim_start_matches('v');
                latest.trim_start_matches('v') != cur
            }
            _ => false,
        };
        map.insert(key.into(), serde_json::json!({
            "currentVersion": if info.version.is_empty() { "Not installed" } else { &info.version },
            "latestVersion": latest_known.unwrap_or_else(|| "Unknown".into()),
            "updateAvailable": update_available
        }));
    }
    map.insert("ffprobe".into(), serde_json::json!({
        "currentVersion": if status.ffprobe.version.is_empty() { "Not installed" } else { &status.ffprobe.version },
        "latestVersion": "Use the FFmpeg distribution version",
        "updateAvailable": false
    }));
    map.insert("python3".into(), serde_json::json!({
        "currentVersion": if status.python3.version.is_empty() { "Not installed" } else { &status.python3.version },
        "latestVersion": "Manage through Python distribution",
        "updateAvailable": false
    }));
    Ok(serde_json::Value::Object(map))
}

async fn latest_github_tag(repo: &str) -> Result<String, String> {
    let curl = if cfg!(target_os = "windows") { "curl.exe" } else { "curl" };
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let output = Command::new(curl)
        .args(["-fsSL", "--max-time", "15", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: VANTA-Download-Manager", &url])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true)
        .output().await.map_err(|e| format!("Unable to check upstream release: {e}"))?;
    if !output.status.success() { return Err(format!("Upstream version check failed: {}", String::from_utf8_lossy(&output.stderr))); }
    let json: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("Invalid release response: {e}"))?;
    string_field(&json, "tag_name").ok_or_else(|| format!("No stable release tag found for {repo}"))
}

pub async fn update_engine(app: &AppHandle, state: &AppState, engine_name: &str) -> Result<EngineUpdateResult, String> {
    let status = get_engine_status(app, state).await;
    let (key, info) = match engine_name.to_ascii_lowercase().as_str() {
        "ytdlp" | "yt-dlp" => ("yt-dlp", &status.ytdlp),
        "spotdl" | "spotdl.exe" => ("spotdl", &status.spotdl),
        "ffmpeg" => ("ffmpeg", &status.ffmpeg),
        "ffprobe" => ("ffprobe", &status.ffprobe),
        "python" | "python3" => ("python3", &status.python3),
        _ => return Err(format!("Unsupported engine identifier: {engine_name}")),
    };
    if !info.available { return Err(format!("{key} is not installed; configure or install it first.")); }
    if state.active_count.load(std::sync::atomic::Ordering::SeqCst) > 0 {
        return Err("Wait for active downloads to finish before updating engines.".into());
    }
    let path = PathBuf::from(&info.path);
    if key == "yt-dlp" {
        let output = run_output(&path, &["-U".into()]).await?;
        if !output.status.success() {
            return Err(format!("yt-dlp self-update failed: {}", String::from_utf8_lossy(&output.stderr).chars().take(800).collect::<String>()));
        }
    } else if key == "spotdl" {
        let managed = state.data_dir.join("engines").join("spotdl").join(".venv");
        if !path.starts_with(&managed) {
            return Err("spotDL is currently installed outside VANTA's managed environment. To avoid modifying system-wide Python packages, configure a managed spotDL environment before updating.".into());
        }
        let python = managed.join(if cfg!(target_os = "windows") { "Scripts/python.exe" } else { "bin/python" });
        let output = run_output(&python, &["-m".into(), "pip".into(), "install".into(), "--upgrade".into(), "spotdl".into()]).await?;
        if !output.status.success() { return Err(format!("spotDL update failed: {}", String::from_utf8_lossy(&output.stderr).chars().take(800).collect::<String>())); }
    } else {
        return Err(format!("{key} updates must be installed through a verified managed distribution; automatic replacement is not enabled for this system installation."));
    }
    let updated = get_engine_status(app, state).await;
    let current = match key {
        "yt-dlp" => &updated.ytdlp.version,
        "spotdl" => &updated.spotdl.version,
        "ffmpeg" => &updated.ffmpeg.version,
        "ffprobe" => &updated.ffprobe.version,
        _ => &updated.python3.version,
    };
    let result = EngineUpdateResult {
        engine: key.into(), success: !current.is_empty() && current != &info.version,
        previous_version: info.version.clone(), current_version: current.clone(),
        message: if current != &info.version { "Update command completed and the reported version changed.".into() } else { "Update command completed, but the version did not change; verify the upstream update result.".into() },
        rolled_back: Some(false),
    };
    if !result.success { return Err(result.message); }
    Ok(result)
}
