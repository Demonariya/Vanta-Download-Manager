use crate::models::{
    AppSettings, DiagnosticResult, EngineInfo, EngineInstallProgress, EngineStatusMap,
    EngineUpdateResult, FormatOption, ManagedEngineInfo, MediaMetadata,
};
use crate::state::AppState;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

const YTDLP_WIN_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YTDLP_UNIX_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
const YTDLP_SHA256_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

// Compact verified GPL-shared Windows FFmpeg build (~83 MiB compressed vs ~196 MiB static)
const FFMPEG_WIN_ZIP_NAME: &str = "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip";
const FFMPEG_WIN_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip";
const FFMPEG_CHECKSUMS_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256";

// Pinned spotDL release with verified SHA-256 digest
const SPOTDL_PINNED_VERSION: &str = "v4.6.0";
const SPOTDL_WIN_URL: &str =
    "https://github.com/spotDL/spotify-downloader/releases/download/v4.6.0/spotdl-4.6.0-win32.exe";
const SPOTDL_WIN_SHA256: &str =
    "e674030c3337cd74120a3a086887ce1a5195765cfc17e1971a2807e0a398b505";

static ENGINE_INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn install_lock() -> &'static tokio::sync::Mutex<()> {
    ENGINE_INSTALL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EngineManifestRecord {
    pub version: String,
    pub sha256: String,
    pub source_url: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ManagedEngineManifest {
    pub engines: HashMap<String, EngineManifestRecord>,
}

pub struct EngineManager;

impl EngineManager {
    pub fn managed_engines_root() -> PathBuf {
        AppState::app_data_dir().join("engines")
    }

    pub fn managed_bin_dir() -> PathBuf {
        Self::managed_engines_root().join("bin")
    }

    pub fn managed_staging_dir() -> PathBuf {
        Self::managed_engines_root().join("staging")
    }

    pub fn manifest_path() -> PathBuf {
        Self::managed_engines_root().join("manifest.json")
    }

    pub fn load_manifest() -> ManagedEngineManifest {
        let path = Self::manifest_path();
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(manifest) = serde_json::from_str::<ManagedEngineManifest>(&content) {
                return manifest;
            }
        }
        ManagedEngineManifest::default()
    }

    pub fn save_manifest(manifest: &ManagedEngineManifest) -> Result<(), String> {
        let root = Self::managed_engines_root();
        fs::create_dir_all(&root).map_err(|e| format!("Failed to create engines dir: {}", e))?;
        let path = Self::manifest_path();
        let tmp_path = root.join("manifest.json.tmp");
        let serialized = serde_json::to_string_pretty(manifest)
            .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
        fs::write(&tmp_path, serialized)
            .map_err(|e| format!("Failed to write temp manifest: {}", e))?;
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        fs::rename(&tmp_path, &path)
            .map_err(|e| format!("Failed to finalize manifest: {}", e))?;
        Ok(())
    }

    pub fn exe_filename(name: &str) -> String {
        if cfg!(windows) && !name.ends_with(".exe") {
            format!("{}.exe", name)
        } else {
            name.to_string()
        }
    }

    pub fn find_executable(name: &str) -> Option<PathBuf> {
        let exe_name = Self::exe_filename(name);

        // 1. Managed per-user application-data runtime directory (primary for slim installers)
        let managed_candidate = Self::managed_bin_dir().join(&exe_name);
        if managed_candidate.is_file() {
            return Some(managed_candidate);
        }

        // 2. Current executable directory / bundled side-by-side bin/
        if let Ok(current_exe) = env::current_exe() {
            if let Some(parent) = current_exe.parent() {
                let candidate = parent.join(&exe_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
                let bin_candidate = parent.join("bin").join(&exe_name);
                if bin_candidate.is_file() {
                    return Some(bin_candidate);
                }
            }
        }

        // 3. Project local bin directories (development)
        let local_bin = PathBuf::from("bin").join(&exe_name);
        if local_bin.is_file() {
            return Some(fs::canonicalize(&local_bin).unwrap_or(local_bin));
        }

        let src_tauri_bin = PathBuf::from("src-tauri").join("bin").join(&exe_name);
        if src_tauri_bin.is_file() {
            return Some(fs::canonicalize(&src_tauri_bin).unwrap_or(src_tauri_bin));
        }

        // 4. User local bin directory (~/.local/bin)
        if let Ok(home) = env::var("HOME") {
            let user_local = PathBuf::from(home).join(".local").join("bin").join(&exe_name);
            if user_local.is_file() {
                return Some(user_local);
            }
        }

        // 5. System PATH lookup
        if let Some(path_var) = env::var_os("PATH") {
            for dir in env::split_paths(&path_var) {
                let candidate = dir.join(&exe_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        // 6. Standard POSIX directories
        #[cfg(not(windows))]
        {
            for sys_dir in ["/usr/local/bin", "/usr/bin", "/bin"] {
                let candidate = PathBuf::from(sys_dir).join(&exe_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        None
    }

    pub fn build_command_path_env() -> Option<std::ffi::OsString> {
        let managed = Self::managed_bin_dir();
        let mut paths = Vec::new();
        if managed.exists() {
            paths.push(managed);
        }
        if let Some(existing) = env::var_os("PATH") {
            paths.extend(env::split_paths(&existing));
        }
        env::join_paths(paths).ok()
    }

    pub fn apply_engine_env(cmd: &mut Command) {
        if let Some(path_env) = Self::build_command_path_env() {
            cmd.env("PATH", path_env);
        }
    }

    pub fn check_single_engine(name: &str, ver_flag: &str) -> EngineInfo {
        let path_opt = Self::find_executable(name);
        let now = chrono::Utc::now().to_rfc3339();

        match path_opt {
            Some(path) => {
                let mut cmd = Command::new(&path);
                cmd.arg(ver_flag);
                Self::apply_engine_env(&mut cmd);

                match cmd.output() {
                    Ok(output) if output.status.success() => {
                        let text = String::from_utf8_lossy(&output.stdout);
                        let first_line = text.lines().next().unwrap_or("").trim().to_string();
                        let clean_version = first_line
                            .trim_start_matches("ffmpeg version")
                            .trim_start_matches("ffprobe version")
                            .trim_start_matches("Python")
                            .trim()
                            .to_string();

                        EngineInfo {
                            available: true,
                            version: if clean_version.is_empty() {
                                first_line
                            } else {
                                clean_version
                            },
                            path: path.to_string_lossy().to_string(),
                            status: "ready".to_string(),
                            last_checked: now,
                            error: None,
                            latest_version: None,
                            update_available: Some(false),
                            is_updating: Some(false),
                        }
                    }
                    Ok(output) => {
                        let err_msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
                        EngineInfo {
                            available: false,
                            version: String::new(),
                            path: path.to_string_lossy().to_string(),
                            status: "error".to_string(),
                            last_checked: now,
                            error: Some(if err_msg.is_empty() {
                                "Process returned error exit code".to_string()
                            } else {
                                err_msg
                            }),
                            latest_version: None,
                            update_available: Some(false),
                            is_updating: Some(false),
                        }
                    }
                    Err(e) => EngineInfo {
                        available: false,
                        version: String::new(),
                        path: path.to_string_lossy().to_string(),
                        status: "error".to_string(),
                        last_checked: now,
                        error: Some(e.to_string()),
                        latest_version: None,
                        update_available: Some(false),
                        is_updating: Some(false),
                    },
                }
            }
            None => EngineInfo {
                available: false,
                version: String::new(),
                path: String::new(),
                status: "missing".to_string(),
                last_checked: now,
                error: Some(format!(
                    "Executable '{}' not found in managed runtime or PATH",
                    name
                )),
                latest_version: None,
                update_available: Some(false),
                is_updating: Some(false),
            },
        }
    }

    pub fn get_engine_status() -> EngineStatusMap {
        EngineStatusMap {
            ytdlp: Self::check_single_engine("yt-dlp", "--version"),
            spotdl: Self::check_single_engine("spotdl", "--version"),
            ffmpeg: Self::check_single_engine("ffmpeg", "-version"),
            ffprobe: Self::check_single_engine("ffprobe", "-version"),
            python3: Self::check_single_engine("python3", "--version"),
        }
    }

    pub fn get_managed_engine_info() -> ManagedEngineInfo {
        let engines = Self::get_engine_status();
        let mut missing_required = Vec::new();
        if !engines.ytdlp.available {
            missing_required.push("yt-dlp".to_string());
        }
        if !engines.ffmpeg.available {
            missing_required.push("ffmpeg".to_string());
        }
        if !engines.ffprobe.available {
            missing_required.push("ffprobe".to_string());
        }

        ManagedEngineInfo {
            install_dir: Self::managed_bin_dir().to_string_lossy().to_string(),
            manifest_path: Self::manifest_path().to_string_lossy().to_string(),
            required_ready: missing_required.is_empty(),
            missing_required,
            engines,
        }
    }

    pub fn ensure_required_engines(require_ffmpeg: bool, require_spotdl: bool) -> Result<(), String> {
        let status = Self::get_engine_status();
        if require_spotdl && !status.spotdl.available {
            return Err("spotDL engine is not installed. Use Install Engines in Dashboard or Diagnostics to download verified engines.".to_string());
        }
        if !require_spotdl && !status.ytdlp.available {
            return Err("yt-dlp engine is not installed. Use Install Engines in Dashboard or Diagnostics to download verified engines.".to_string());
        }
        if require_ffmpeg && (!status.ffmpeg.available || !status.ffprobe.available) {
            return Err("FFmpeg / FFprobe engines are not installed. Use Install Engines in Dashboard or Diagnostics to download verified engines.".to_string());
        }
        Ok(())
    }

    pub fn compute_sha256_file(path: &Path) -> Result<String, String> {
        let mut file =
            fs::File::open(path).map_err(|e| format!("Failed to open file for SHA-256: {}", e))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];
        loop {
            let n = file
                .read(&mut buffer)
                .map_err(|e| format!("Failed reading file for SHA-256: {}", e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    }

    pub fn parse_sha256_for_filename(checksums_text: &str, filename: &str) -> Option<String> {
        for raw_line in checksums_text.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let entry = parts.next()?;
            let normalized_entry = entry.trim_start_matches('*');
            let matches_name = normalized_entry == filename
                || normalized_entry.ends_with(&format!("/{}", filename))
                || normalized_entry.ends_with(&format!("\\{}", filename));

            if matches_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(hash.to_ascii_lowercase());
            }
        }
        None
    }

    pub fn atomic_replace_file(staged_file: &Path, target_file: &Path) -> Result<(), String> {
        if let Some(parent) = target_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create target bin dir: {}", e))?;
        }

        let backup_file = target_file.with_extension("bak");
        let had_existing = target_file.exists();

        if had_existing {
            if backup_file.exists() {
                let _ = fs::remove_file(&backup_file);
            }
            fs::rename(target_file, &backup_file)
                .map_err(|e| format!("Failed to back up existing binary: {}", e))?;
        }

        match fs::rename(staged_file, target_file) {
            Ok(()) => {
                if had_existing && backup_file.exists() {
                    let _ = fs::remove_file(&backup_file);
                }
                Ok(())
            }
            Err(rename_err) => {
                // Fallback copy across filesystems/volumes if needed
                match fs::copy(staged_file, target_file) {
                    Ok(_) => {
                        let _ = fs::remove_file(staged_file);
                        if had_existing && backup_file.exists() {
                            let _ = fs::remove_file(&backup_file);
                        }
                        Ok(())
                    }
                    Err(copy_err) => {
                        if had_existing && backup_file.exists() {
                            let _ = fs::rename(&backup_file, target_file);
                        }
                        Err(format!(
                            "Failed atomic install ({} / {})",
                            rename_err, copy_err
                        ))
                    }
                }
            }
        }
    }

    fn emit_install_progress(
        app: Option<&AppHandle>,
        engine: &str,
        status: &str,
        phase: &str,
        progress_percentage: f64,
        downloaded_bytes: u64,
        total_bytes: u64,
        message: impl Into<String>,
        error: Option<String>,
    ) {
        if let Some(handle) = app {
            let payload = EngineInstallProgress {
                engine: engine.to_string(),
                status: status.to_string(),
                phase: phase.to_string(),
                progress_percentage,
                downloaded_bytes,
                total_bytes,
                message: message.into(),
                error,
            };
            let _ = handle.emit("engine_install_progress", payload);
        }
    }

    async fn download_to_staging(
        client: &reqwest::Client,
        app: Option<&AppHandle>,
        engine: &str,
        url: &str,
        dest_part_path: &Path,
    ) -> Result<(), String> {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Network request failed: {}", e))?
            .error_for_status()
            .map_err(|e| format!("Download server returned error: {}", e))?;

        let total_bytes = response.content_length().unwrap_or(0);
        let mut out_file = fs::File::create(dest_part_path)
            .map_err(|e| format!("Failed to create staging file: {}", e))?;

        let mut downloaded_bytes: u64 = 0;
        let mut last_emit_bytes: u64 = 0;

        Self::emit_install_progress(
            app,
            engine,
            "downloading",
            "Downloading package...",
            0.0,
            0,
            total_bytes,
            format!("Downloading {}...", engine),
            None,
        );

        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Stream interrupted: {}", e))?
        {
            out_file
                .write_all(&chunk)
                .map_err(|e| format!("Disk write error: {}", e))?;
            downloaded_bytes += chunk.len() as u64;

            if downloaded_bytes - last_emit_bytes >= 262_144 || (total_bytes > 0 && downloaded_bytes >= total_bytes) {
                last_emit_bytes = downloaded_bytes;
                let pct = if total_bytes > 0 {
                    ((downloaded_bytes as f64 / total_bytes as f64) * 85.0).min(85.0)
                } else {
                    40.0
                };
                Self::emit_install_progress(
                    app,
                    engine,
                    "downloading",
                    "Downloading package...",
                    pct,
                    downloaded_bytes,
                    total_bytes,
                    format!("Downloaded {:.1} MiB", downloaded_bytes as f64 / 1_048_576.0),
                    None,
                );
            }
        }

        out_file
            .flush()
            .map_err(|e| format!("Failed flushing staging file: {}", e))?;

        Ok(())
    }

    fn verify_binary_runs(path: &Path, flag: &str) -> Result<String, String> {
        let mut cmd = Command::new(path);
        cmd.arg(flag);
        if let Some(parent) = path.parent() {
            let mut paths = vec![parent.to_path_buf()];
            if let Some(existing) = env::var_os("PATH") {
                paths.extend(env::split_paths(&existing));
            }
            if let Ok(joined) = env::join_paths(paths) {
                cmd.env("PATH", joined);
            }
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute verification command: {}", e))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!(
                "Verification command exited with non-zero status: {}",
                err
            ));
        }

        let version = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();

        if version.is_empty() {
            return Err("Binary verification returned empty version string".to_string());
        }

        Ok(version)
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    fn extract_ffmpeg_archive(archive_path: &Path, extract_dir: &Path) -> Result<Vec<PathBuf>, String> {
        fs::create_dir_all(extract_dir)
            .map_err(|e| format!("Failed to create extraction directory: {}", e))?;

        let file = fs::File::open(archive_path)
            .map_err(|e| format!("Failed to open FFmpeg archive: {}", e))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("Invalid FFmpeg ZIP archive: {}", e))?;

        let mut extracted_files = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Corrupt ZIP entry: {}", e))?;
            if entry.is_dir() {
                continue;
            }
            let entry_name = entry.name().replace('\\', "/");
            if entry_name.contains("..") {
                continue;
            }

            let is_bin_asset = entry_name.contains("/bin/")
                && (entry_name.ends_with("/ffmpeg.exe")
                    || entry_name.ends_with("/ffprobe.exe")
                    || entry_name.ends_with(".dll"));

            if !is_bin_asset {
                continue;
            }

            let file_name = match Path::new(&entry_name).file_name() {
                Some(name) => name.to_os_string(),
                None => continue,
            };

            let out_path = extract_dir.join(file_name);
            let mut out_file = fs::File::create(&out_path)
                .map_err(|e| format!("Failed creating extracted file: {}", e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Failed writing extracted file: {}", e))?;
            out_file
                .flush()
                .map_err(|e| format!("Failed flushing extracted file: {}", e))?;
            extracted_files.push(out_path);
        }

        if !extract_dir.join("ffmpeg.exe").exists() || !extract_dir.join("ffprobe.exe").exists() {
            return Err("Archive did not contain required ffmpeg.exe and ffprobe.exe binaries".to_string());
        }

        Ok(extracted_files)
    }

    pub async fn install_engine_async(
        app: Option<&AppHandle>,
        name: &str,
        force: bool,
    ) -> EngineUpdateResult {
        let _guard = install_lock().lock().await;
        let normalized = match name.to_ascii_lowercase().as_str() {
            "ytdlp" | "yt-dlp" => "yt-dlp",
            "ffmpeg" | "ffprobe" => "ffmpeg",
            "spotdl" => "spotdl",
            other => {
                return EngineUpdateResult {
                    engine: other.to_string(),
                    success: false,
                    previous_version: String::new(),
                    current_version: String::new(),
                    message: format!("Engine '{}' does not support managed installation", other),
                    rolled_back: Some(false),
                };
            }
        };

        let status = Self::get_engine_status();
        let prev_version = match normalized {
            "yt-dlp" => status.ytdlp.version.clone(),
            "ffmpeg" => status.ffmpeg.version.clone(),
            "spotdl" => status.spotdl.version.clone(),
            _ => String::new(),
        };

        // Avoid repeated downloads if already installed cleanly unless force reinstall requested
        if !force {
            let already_ready = match normalized {
                "yt-dlp" => status.ytdlp.available,
                "ffmpeg" => status.ffmpeg.available && status.ffprobe.available,
                "spotdl" => status.spotdl.available,
                _ => false,
            };
            if already_ready {
                Self::emit_install_progress(
                    app,
                    normalized,
                    "ready",
                    "Already installed",
                    100.0,
                    0,
                    0,
                    format!("{} is already installed and verified", normalized),
                    None,
                );
                return EngineUpdateResult {
                    engine: normalized.to_string(),
                    success: true,
                    previous_version: prev_version.clone(),
                    current_version: prev_version,
                    message: format!("{} is already installed and verified", normalized),
                    rolled_back: Some(false),
                };
            }
        }

        let staging_dir = Self::managed_staging_dir().join(uuid::Uuid::new_v4().to_string());
        if let Err(e) = fs::create_dir_all(&staging_dir) {
            return EngineUpdateResult {
                engine: normalized.to_string(),
                success: false,
                previous_version: prev_version.clone(),
                current_version: prev_version,
                message: format!("Failed creating staging directory: {}", e),
                rolled_back: Some(false),
            };
        }

        let client = match reqwest::Client::builder()
            .user_agent("VANTA-Download-Manager/1.0")
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging_dir);
                return EngineUpdateResult {
                    engine: normalized.to_string(),
                    success: false,
                    previous_version: prev_version.clone(),
                    current_version: prev_version,
                    message: format!("Failed creating HTTP client: {}", e),
                    rolled_back: Some(false),
                };
            }
        };

        let result: Result<(String, String, String), String> = match normalized {
            "yt-dlp" => async {
                let asset_name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
                let url = if cfg!(windows) { YTDLP_WIN_URL } else { YTDLP_UNIX_URL };
                let checksum_txt = client
                    .get(YTDLP_SHA256_URL)
                    .send()
                    .await
                    .map_err(|e| format!("Failed fetching yt-dlp SHA-256 manifest: {}", e))?
                    .error_for_status()
                    .map_err(|e| format!("Failed fetching yt-dlp SHA-256 manifest: {}", e))?
                    .text()
                    .await
                    .map_err(|e| format!("Failed reading yt-dlp SHA-256 manifest: {}", e))?;

                let expected_sha = Self::parse_sha256_for_filename(&checksum_txt, asset_name)
                    .ok_or_else(|| format!("SHA-256 checksum entry for '{}' missing in upstream release", asset_name))?;

                let part_path = staging_dir.join(format!("{}.part", asset_name));
                Self::download_to_staging(&client, app, "yt-dlp", url, &part_path).await?;

                Self::emit_install_progress(
                    app,
                    "yt-dlp",
                    "verifying",
                    "Verifying SHA-256 checksum...",
                    90.0,
                    0,
                    0,
                    "Verifying cryptographic integrity...",
                    None,
                );

                let actual_sha = Self::compute_sha256_file(&part_path)?;
                if actual_sha != expected_sha {
                    return Err(format!(
                        "SHA-256 verification failed for yt-dlp (expected {}, got {})",
                        expected_sha, actual_sha
                    ));
                }

                let staged_bin = staging_dir.join(asset_name);
                fs::rename(&part_path, &staged_bin)
                    .map_err(|e| format!("Failed staging yt-dlp binary: {}", e))?;
                Self::make_executable(&staged_bin);

                let version = Self::verify_binary_runs(&staged_bin, "--version")?;
                let target_bin = Self::managed_bin_dir().join(asset_name);
                Self::atomic_replace_file(&staged_bin, &target_bin)?;

                Ok((version, actual_sha, url.to_string()))
            }
            .await,
            "ffmpeg" => async {
                if !cfg!(windows) {
                    return Err("Managed automatic FFmpeg bundle is configured for Windows x64; install ffmpeg & ffprobe via system package manager on Unix.".to_string());
                }

                let checksum_txt = client
                    .get(FFMPEG_CHECKSUMS_URL)
                    .send()
                    .await
                    .map_err(|e| format!("Failed fetching FFmpeg SHA-256 manifest: {}", e))?
                    .error_for_status()
                    .map_err(|e| format!("Failed fetching FFmpeg SHA-256 manifest: {}", e))?
                    .text()
                    .await
                    .map_err(|e| format!("Failed reading FFmpeg SHA-256 manifest: {}", e))?;

                let expected_sha = Self::parse_sha256_for_filename(&checksum_txt, FFMPEG_WIN_ZIP_NAME)
                    .ok_or_else(|| format!("SHA-256 checksum entry for '{}' missing", FFMPEG_WIN_ZIP_NAME))?;

                let archive_part = staging_dir.join("ffmpeg.zip.part");
                Self::download_to_staging(&client, app, "ffmpeg", FFMPEG_WIN_URL, &archive_part).await?;

                Self::emit_install_progress(
                    app,
                    "ffmpeg",
                    "verifying",
                    "Verifying SHA-256 checksum...",
                    88.0,
                    0,
                    0,
                    "Verifying FFmpeg archive checksum...",
                    None,
                );

                let actual_sha = Self::compute_sha256_file(&archive_part)?;
                if actual_sha != expected_sha {
                    return Err(format!(
                        "SHA-256 verification failed for FFmpeg archive (expected {}, got {})",
                        expected_sha, actual_sha
                    ));
                }

                Self::emit_install_progress(
                    app,
                    "ffmpeg",
                    "extracting",
                    "Extracting FFmpeg & FFprobe...",
                    93.0,
                    0,
                    0,
                    "Extracting ffmpeg.exe, ffprobe.exe, and shared codecs...",
                    None,
                );

                let extract_dir = staging_dir.join("extract");
                let extracted = tokio::task::spawn_blocking({
                    let archive_clone = archive_part.clone();
                    let extract_clone = extract_dir.clone();
                    move || Self::extract_ffmpeg_archive(&archive_clone, &extract_clone)
                })
                .await
                .map_err(|e| format!("Extraction task panicked: {}", e))??;

                let staged_ffmpeg = extract_dir.join("ffmpeg.exe");
                let staged_ffprobe = extract_dir.join("ffprobe.exe");
                let ffmpeg_ver = Self::verify_binary_runs(&staged_ffmpeg, "-version")?;
                let _ffprobe_ver = Self::verify_binary_runs(&staged_ffprobe, "-version")?;

                Self::emit_install_progress(
                    app,
                    "ffmpeg",
                    "installing",
                    "Finalizing atomic installation...",
                    97.0,
                    0,
                    0,
                    "Installing verified FFmpeg binaries...",
                    None,
                );

                let bin_dir = Self::managed_bin_dir();
                for file_path in extracted {
                    if let Some(fname) = file_path.file_name() {
                        let target = bin_dir.join(fname);
                        Self::atomic_replace_file(&file_path, &target)?;
                    }
                }

                let clean_ver = ffmpeg_ver
                    .trim_start_matches("ffmpeg version")
                    .trim()
                    .to_string();
                Ok((clean_ver, actual_sha, FFMPEG_WIN_URL.to_string()))
            }
            .await,
            "spotdl" => async {
                if !cfg!(windows) {
                    return Err("On Unix systems, install or update spotDL via python3 -m pip install --upgrade --user spotdl.".to_string());
                }

                let part_path = staging_dir.join("spotdl.exe.part");
                Self::download_to_staging(&client, app, "spotdl", SPOTDL_WIN_URL, &part_path).await?;

                Self::emit_install_progress(
                    app,
                    "spotdl",
                    "verifying",
                    "Verifying SHA-256 checksum...",
                    90.0,
                    0,
                    0,
                    format!("Verifying spotDL {} digest...", SPOTDL_PINNED_VERSION),
                    None,
                );

                let actual_sha = Self::compute_sha256_file(&part_path)?;
                if actual_sha != SPOTDL_WIN_SHA256 {
                    return Err(format!(
                        "SHA-256 verification failed for spotDL (expected {}, got {})",
                        SPOTDL_WIN_SHA256, actual_sha
                    ));
                }

                let staged_bin = staging_dir.join("spotdl.exe");
                fs::rename(&part_path, &staged_bin)
                    .map_err(|e| format!("Failed staging spotdl.exe: {}", e))?;
                let version = Self::verify_binary_runs(&staged_bin, "--version")?;
                let target_bin = Self::managed_bin_dir().join("spotdl.exe");
                Self::atomic_replace_file(&staged_bin, &target_bin)?;

                Ok((version, actual_sha, SPOTDL_WIN_URL.to_string()))
            }
            .await,
            _ => unreachable!(),
        };

        let _ = fs::remove_dir_all(&staging_dir);

        match result {
            Ok((new_ver, sha256, source_url)) => {
                let mut manifest = Self::load_manifest();
                manifest.engines.insert(
                    normalized.to_string(),
                    EngineManifestRecord {
                        version: new_ver.clone(),
                        sha256,
                        source_url,
                        installed_at: chrono::Utc::now().to_rfc3339(),
                    },
                );
                let _ = Self::save_manifest(&manifest);

                Self::emit_install_progress(
                    app,
                    normalized,
                    "ready",
                    "Installed & Verified",
                    100.0,
                    0,
                    0,
                    format!("{} {} installed cleanly", normalized, new_ver),
                    None,
                );

                EngineUpdateResult {
                    engine: normalized.to_string(),
                    success: true,
                    previous_version: prev_version,
                    current_version: new_ver.clone(),
                    message: format!("Successfully installed verified {} ({})", normalized, new_ver),
                    rolled_back: Some(false),
                }
            }
            Err(err_msg) => {
                Self::emit_install_progress(
                    app,
                    normalized,
                    "error",
                    "Installation failed",
                    0.0,
                    0,
                    0,
                    err_msg.clone(),
                    Some(err_msg.clone()),
                );

                EngineUpdateResult {
                    engine: normalized.to_string(),
                    success: false,
                    previous_version: prev_version.clone(),
                    current_version: prev_version,
                    message: err_msg,
                    rolled_back: Some(true),
                }
            }
        }
    }

    pub async fn install_all_required_async(
        app: Option<&AppHandle>,
        include_spotdl: bool,
        force: bool,
    ) -> Vec<EngineUpdateResult> {
        let mut results = Vec::new();
        results.push(Self::install_engine_async(app, "yt-dlp", force).await);
        results.push(Self::install_engine_async(app, "ffmpeg", force).await);
        if include_spotdl {
            results.push(Self::install_engine_async(app, "spotdl", force).await);
        }
        results
    }

    pub fn run_diagnostics() -> Vec<DiagnosticResult> {
        let engines = [
            ("yt-dlp", "--version"),
            ("spotdl", "--version"),
            ("ffmpeg", "-version"),
            ("ffprobe", "-version"),
        ];

        let mut results = Vec::new();

        for (name, flag) in engines {
            let start = Instant::now();
            let path_opt = Self::find_executable(name);

            match path_opt {
                Some(path) => {
                    let mut cmd = Command::new(&path);
                    cmd.arg(flag);
                    Self::apply_engine_env(&mut cmd);
                    let cmd_res = cmd.output();
                    let duration_ms = start.elapsed().as_millis() as u64;

                    match cmd_res {
                        Ok(output) => {
                            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                            let combined = if stdout.is_empty() { stderr } else { stdout };
                            let first_line = combined.lines().next().unwrap_or("").to_string();

                            results.push(DiagnosticResult {
                                engine: name.to_string(),
                                passed: output.status.success(),
                                version: Some(first_line),
                                command: format!("{} {}", path.display(), flag),
                                output: combined.chars().take(400).collect(),
                                duration_ms,
                            });
                        }
                        Err(e) => {
                            results.push(DiagnosticResult {
                                engine: name.to_string(),
                                passed: false,
                                version: None,
                                command: format!("{} {}", path.display(), flag),
                                output: e.to_string(),
                                duration_ms,
                            });
                        }
                    }
                }
                None => {
                    results.push(DiagnosticResult {
                        engine: name.to_string(),
                        passed: false,
                        version: None,
                        command: format!("{} {}", name, flag),
                        output: "Binary not detected in managed runtime or PATH".to_string(),
                        duration_ms: start.elapsed().as_millis() as u64,
                    });
                }
            }
        }

        results
    }

    pub fn sanitize_log(text: &str) -> String {
        let re_bearer = Regex::new(r"(?i)bearer\s+[a-z0-9_\-\.~]+").unwrap();
        let re_auth = Regex::new(r"(?i)authorization:\s*[^\r\n]+").unwrap();
        let re_cookie = Regex::new(r#"(?i)["']?cookie["']?\s*:\s*["']?[^"'\r\n]+"#).unwrap();
        let re_sig = Regex::new(r"(?i)([?&](?:sig|signature|token|session_token|auth|key|secret)=)[^&\s]+").unwrap();

        let s1 = re_bearer.replace_all(text, "Bearer [REDACTED_TOKEN]");
        let s2 = re_auth.replace_all(&s1, "Authorization: [REDACTED_HEADER]");
        let s3 = re_cookie.replace_all(&s2, "Cookie: [REDACTED_COOKIE]");
        let s4 = re_sig.replace_all(&s3, "$1[REDACTED]");
        s4.to_string()
    }

    pub fn build_ytdlp_cookie_and_adult_args(url: &str, settings: &AppSettings) -> Vec<String> {
        let mut args = Vec::new();

        if settings.enable_adult_sites != Some(false) {
            args.push("--age-limit".to_string());
            args.push("99".to_string());
            args.push("--no-check-certificates".to_string());
        }

        if settings.bypass_age_gate != Some(false) {
            args.push("--geo-bypass".to_string());
        }

        let ua = settings
            .user_agent
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
        args.push("--user-agent".to_string());
        args.push(ua.to_string());
        args.push("--add-header".to_string());
        args.push("Accept-Language:en-US,en;q=0.9".to_string());
        args.push("--add-header".to_string());
        args.push("Sec-Fetch-Mode:navigate".to_string());

        if let Some(scheme_idx) = url.find("://") {
            let after_scheme = &url[scheme_idx + 3..];
            let host = after_scheme.split('/').next().unwrap_or("");
            if !host.is_empty() {
                args.push("--referer".to_string());
                args.push(format!("{}://{}/", &url[..scheme_idx], host));
            }
        }

        if let Some(ffmpeg_path) = Self::find_executable("ffmpeg") {
            if let Some(parent) = ffmpeg_path.parent() {
                args.push("--ffmpeg-location".to_string());
                args.push(parent.to_string_lossy().to_string());
            }
        }

        let default_cookie_file = AppState::app_data_dir().join("cookies.txt");
        let custom_cookie_path = settings
            .cookies_file
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_cookie_file);

        if custom_cookie_path.exists() {
            if let Ok(content) = fs::read_to_string(&custom_cookie_path) {
                if !content.trim().is_empty() {
                    args.push("--cookies".to_string());
                    args.push(custom_cookie_path.to_string_lossy().to_string());
                    return args;
                }
            }
        }

        let browser = settings.cookies_browser.as_deref().unwrap_or("auto");
        if browser != "none" && !browser.is_empty() {
            let target = if browser == "auto" { "chrome" } else { browser };
            args.push("--cookies-from-browser".to_string());
            args.push(target.to_string());
        }

        args
    }

    pub fn inspect_url(url: &str, settings: &AppSettings) -> Result<MediaMetadata, String> {
        Self::ensure_required_engines(false, false)?;
        let ytdlp_path = Self::find_executable("yt-dlp")
            .ok_or_else(|| "yt-dlp executable not found".to_string())?;

        let extra_args = Self::build_ytdlp_cookie_and_adult_args(url, settings);

        let run_once = |extra: &[String]| -> Result<MediaMetadata, String> {
            let mut cmd = Command::new(&ytdlp_path);
            cmd.args([
                "--dump-single-json",
                "--no-playlist",
                "--no-warnings",
                "--no-call-home",
                "--no-cache-dir",
            ]);
            cmd.args(extra);
            if !settings.proxy_url.trim().is_empty() {
                cmd.args(["--proxy", settings.proxy_url.trim()]);
            }
            cmd.arg(url);
            Self::apply_engine_env(&mut cmd);

            let output = cmd
                .output()
                .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(Self::sanitize_log(&stderr));
            }

            let json_str = String::from_utf8_lossy(&output.stdout);
            let val: serde_json::Value = serde_json::from_str(&json_str)
                .map_err(|e| format!("Failed to parse JSON metadata: {}", e))?;

            let mut formats = Vec::new();
            if let Some(formats_arr) = val.get("formats").and_then(|f| f.as_array()) {
                for f in formats_arr {
                    let format_id = f
                        .get("format_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if format_id.is_empty() {
                        continue;
                    }
                    let ext = f
                        .get("ext")
                        .and_then(|v| v.as_str())
                        .unwrap_or("mp4")
                        .to_string();
                    let resolution = f
                        .get("resolution")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let width = f.get("width").and_then(|v| v.as_u64()).map(|v| v as u32);
                    let height = f.get("height").and_then(|v| v.as_u64()).map(|v| v as u32);
                    let fps = f.get("fps").and_then(|v| v.as_f64());
                    let vcodec = f
                        .get("vcodec")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let acodec = f
                        .get("acodec")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let filesize = f.get("filesize").and_then(|v| v.as_u64());
                    let filesize_approx = f.get("filesize_approx").and_then(|v| v.as_u64());
                    let format_note = f
                        .get("format_note")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let is_audio_only =
                        vcodec.as_deref() == Some("none") && acodec.as_deref() != Some("none");
                    let is_video_only =
                        acodec.as_deref() == Some("none") && vcodec.as_deref() != Some("none");

                    formats.push(FormatOption {
                        format_id,
                        ext,
                        resolution,
                        width,
                        height,
                        fps,
                        vcodec,
                        acodec,
                        filesize,
                        filesize_approx,
                        format_note,
                        is_audio_only,
                        is_video_only,
                    });
                }
            }

            Ok(MediaMetadata {
                url: url.to_string(),
                id: val
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: val
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Media")
                    .to_string(),
                uploader: val
                    .get("uploader")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                duration: val.get("duration").and_then(|v| v.as_u64()),
                duration_string: val
                    .get("duration_string")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                thumbnail: val
                    .get("thumbnail")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                description: val
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                formats,
                is_playlist: false,
                playlist_count: None,
                extractor: val
                    .get("extractor")
                    .and_then(|v| v.as_str())
                    .unwrap_or("yt-dlp")
                    .to_string(),
            })
        };

        match run_once(&extra_args) {
            Ok(meta) => Ok(meta),
            Err(first_err)
                if first_err.contains("Could not find")
                    && (first_err.contains("cookie") || first_err.contains("database")) =>
            {
                let mut stripped = Vec::new();
                let mut skip_next = false;
                for arg in extra_args {
                    if skip_next {
                        skip_next = false;
                        continue;
                    }
                    if arg == "--cookies-from-browser" {
                        skip_next = true;
                        continue;
                    }
                    stripped.push(arg);
                }
                run_once(&stripped)
            }
            Err(err) => Err(err),
        }
    }

    pub fn verify_audio_file(file_path: &Path) -> Option<String> {
        let ffprobe = Self::find_executable("ffprobe")?;
        if !file_path.exists() {
            return None;
        }

        let target_file = if file_path.is_dir() {
            let entries = fs::read_dir(file_path).ok()?;
            let mut found = None;
            for entry in entries.flatten() {
                let p = entry.path();
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if ["flac", "wav", "mp3", "m4a", "aac", "opus", "ogg"]
                        .contains(&ext_lower.as_str())
                    {
                        found = Some(p);
                        break;
                    }
                }
            }
            found?
        } else {
            file_path.to_path_buf()
        };

        let mut cmd = Command::new(&ffprobe);
        cmd.args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            target_file.to_str()?,
        ]);
        Self::apply_engine_env(&mut cmd);

        let output = cmd.output().ok()?;
        if !output.status.success() {
            return None;
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let val: serde_json::Value = serde_json::from_str(&json_str).ok()?;
        let stream = val
            .get("streams")
            .and_then(|s| s.as_array())?
            .iter()
            .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"))?;

        let codec = stream
            .get("codec_name")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN")
            .to_uppercase();
        let sample_rate = stream
            .get("sample_rate")
            .and_then(|v| v.as_str())
            .unwrap_or("44100");
        let channels = stream.get("channels").and_then(|v| v.as_u64()).unwrap_or(2);

        let mut bit_depth = stream
            .get("bits_per_sample")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if bit_depth == 0 {
            bit_depth = stream
                .get("bits_per_raw_sample")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        }
        if bit_depth == 0 {
            let fmt = stream
                .get("sample_fmt")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            bit_depth = if fmt.contains("s32") || fmt.contains("flt") || fmt.contains("s24") {
                24
            } else {
                16
            };
        }

        let channel_label = match channels {
            1 => "Mono".to_string(),
            2 => "Stereo".to_string(),
            n => format!("{}ch", n),
        };

        Some(format!(
            "{} · {}-bit · {} Hz · {}",
            codec, bit_depth, sample_rate, channel_label
        ))
    }

    pub async fn update_engine_async(app: Option<&AppHandle>, name: &str) -> EngineUpdateResult {
        Self::install_engine_async(app, name, true).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sha256_for_filename() {
        let sample = "\
e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3  yt-dlp
f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d  yt-dlp.exe
ac1364304fa755c892a968a4c5bc5473d3ea94fb4978d4351a392191804657b5 *ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip
";
        assert_eq!(
            EngineManager::parse_sha256_for_filename(sample, "yt-dlp.exe"),
            Some("f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d".to_string())
        );
        assert_eq!(
            EngineManager::parse_sha256_for_filename(sample, "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip"),
            Some("ac1364304fa755c892a968a4c5bc5473d3ea94fb4978d4351a392191804657b5".to_string())
        );
        assert_eq!(
            EngineManager::parse_sha256_for_filename(sample, "nonexistent.exe"),
            None
        );
    }

    #[test]
    fn test_compute_sha256_and_atomic_replace() {
        let base = env::temp_dir().join(format!("vanta_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();

        let staged = base.join("staged.bin");
        let target = base.join("bin").join("tool.bin");

        fs::write(&staged, b"vanta-engine-payload").unwrap();
        let digest = EngineManager::compute_sha256_file(&staged).unwrap();
        assert_eq!(digest.len(), 64);

        EngineManager::atomic_replace_file(&staged, &target).unwrap();
        assert!(!staged.exists());
        assert!(target.exists());
        assert_eq!(fs::read(&target).unwrap(), b"vanta-engine-payload");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn test_sanitize_log_redacts_secrets() {
        let raw = "Authorization: Bearer secret123 Cookie: session=abc https://example.com/?token=xyz&a=1";
        let clean = EngineManager::sanitize_log(raw);
        assert!(!clean.contains("secret123"));
        assert!(!clean.contains("session=abc"));
        assert!(!clean.contains("token=xyz"));
    }
}
