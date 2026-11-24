use crate::cookies::{self, ResolvedCookieSource};
use crate::logging;
use crate::models::{
    AppSettings, DiagnosticResult, EngineInfo, EngineInstallProgress, EngineStatusMap,
    EngineUpdateResult, FormatOption, ManagedEngineInfo, MediaMetadata, PlaylistEntry,
    PythonValidationResult, SubtitleLanguage,
};
use crate::process::{
    self, ProcessError, ProcessOptions, DIAGNOSTICS_TIMEOUT, ENGINE_VERSION_TIMEOUT,
    FFPROBE_TIMEOUT, INSPECT_MAX_STDOUT_BYTES, INSPECT_URL_TIMEOUT,
};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const YTDLP_RELEASE_REPO: &str = "yt-dlp/yt-dlp";
const SPOTDL_RELEASE_REPO: &str = "spotDL/spotify-downloader";
const FFMPEG_RELEASE_REPO: &str = "FFmpeg-Builds/FFmpeg-Builds";

// BtbN publishes this rolling master build asset on its "latest" release.
// The asset name is stable while the archive contents and SHA-256 change per build.
const FFMPEG_WIN_ZIP_NAME: &str = "ffmpeg-master-latest-win64-gpl-shared.zip";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminCopyFile {
    pub src: String,
    pub dst: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminInstallOp {
    pub action: String, // "install" | "install_spotdl_venv" | "remove"
    pub engine: String,
    pub target_root: String,
    pub files: Vec<AdminCopyFile>,
    pub python_path: Option<String>,
    pub venv_dir: Option<String>,
    pub manifest_record: Option<EngineManifestRecord>,
    pub remove_paths: Vec<String>,
    pub result_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminOpResult {
    pub success: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct LatestReleaseAsset {
    version: String,
    url: String,
    sha256: String,
    updated_at: String,
}

pub struct EngineManager;

impl EngineManager {
    /// Resolves the managed `<InstallDir>\Engine` root directory.
    /// In production Windows builds installed under `C:\Program Files\VANTA Download Manager`,
    /// this returns `C:\Program Files\VANTA Download Manager\Engine`.
    /// In unprivileged `cargo` dev builds (`target\...`), returns a safe user-local `DevEngine` directory.
    pub fn managed_engines_root() -> PathBuf {
        if let Ok(override_root) = env::var("VANTA_ENGINE_ROOT") {
            let trimmed = override_root.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }

        if let Ok(current_exe) = env::current_exe() {
            let exe_str = current_exe.to_string_lossy().to_ascii_lowercase();
            let is_cargo_dev =
                exe_str.contains("\\target\\") || exe_str.contains("/target/");
            if !is_cargo_dev {
                if let Some(parent) = current_exe.parent() {
                    return parent.join("Engine");
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Ok(local) = env::var("LOCALAPPDATA") {
                if !local.trim().is_empty() {
                    return PathBuf::from(local)
                        .join("VANTA Download Manager")
                        .join("DevEngine");
                }
            }
        }

        AppState::app_data_dir().join("Engine")
    }

    pub fn install_root_dir() -> PathBuf {
        let engine_root = Self::managed_engines_root();
        engine_root
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| engine_root.clone())
    }

    pub fn ytdlp_dir() -> PathBuf {
        Self::managed_engines_root().join("yt-dlp")
    }

    pub fn spotdl_dir() -> PathBuf {
        Self::managed_engines_root().join("spotdl")
    }

    pub fn spotdl_venv_dir() -> PathBuf {
        Self::spotdl_dir().join("venv")
    }

    pub fn spotdl_venv_python() -> PathBuf {
        let venv = Self::spotdl_venv_dir();
        if cfg!(windows) {
            venv.join("Scripts").join("python.exe")
        } else {
            venv.join("bin").join("python")
        }
    }

    pub fn spotdl_venv_exe() -> PathBuf {
        let venv = Self::spotdl_venv_dir();
        if cfg!(windows) {
            venv.join("Scripts").join("spotdl.exe")
        } else {
            venv.join("bin").join("spotdl")
        }
    }

    pub fn ffmpeg_dir() -> PathBuf {
        Self::managed_engines_root().join("ffmpeg").join("bin")
    }

    pub fn managed_staging_dir() -> PathBuf {
        AppState::app_data_dir().join("engine_staging")
    }

    pub fn manifest_path() -> PathBuf {
        Self::managed_engines_root().join("manifest.json")
    }

    pub fn is_dir_writable(dir: &Path) -> bool {
        let mut probe_base = dir.to_path_buf();
        while !probe_base.exists() {
            if let Some(p) = probe_base.parent() {
                probe_base = p.to_path_buf();
            } else {
                return false;
            }
        }
        let probe_file = probe_base.join(format!(".vanta_write_probe_{}", uuid::Uuid::new_v4()));
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe_file)
        {
            Ok(_) => {
                let _ = fs::remove_file(&probe_file);
                true
            }
            Err(_) => false,
        }
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
        fs::create_dir_all(&root).map_err(|e| format!("Failed to create Engine dir: {}", e))?;
        let path = Self::manifest_path();
        let tmp_path = root.join(format!("manifest.json.tmp.{}", uuid::Uuid::new_v4()));
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

    /// Resolves executables strictly within `<InstallDir>\Engine\...`, bundled dev `bin`,
    /// and standard system locations. NEVER searches Downloads, Desktop, or temp folders.
    pub fn find_executable(name: &str) -> Option<PathBuf> {
        let exe_name = Self::exe_filename(name);
        let lower = name.to_ascii_lowercase();

        // 1. Managed <InstallDir>\Engine subdirectories
        match lower.as_str() {
            "yt-dlp" | "ytdlp" => {
                let c = Self::ytdlp_dir().join(&exe_name);
                if c.is_file() {
                    return Some(c);
                }
            }
            "ffmpeg" | "ffprobe" => {
                let c = Self::ffmpeg_dir().join(&exe_name);
                if c.is_file() {
                    return Some(c);
                }
            }
            "spotdl" => {
                let venv_exe = Self::spotdl_venv_exe();
                if venv_exe.is_file() {
                    return Some(venv_exe);
                }
                let venv_py = Self::spotdl_venv_python();
                if venv_py.is_file() {
                    return Some(venv_py);
                }
                let standalone = Self::spotdl_dir().join(&exe_name);
                if standalone.is_file() {
                    return Some(standalone);
                }
            }
            _ => {}
        }

        // 2. Current executable side-by-side directory or legacy bin/
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

        // 4. User local bin directory (~/.local/bin on Unix)
        #[cfg(not(windows))]
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
        let mut paths = Vec::new();
        for dir in [
            Self::ytdlp_dir(),
            Self::ffmpeg_dir(),
            Self::spotdl_dir(),
            Self::spotdl_venv_dir().join(if cfg!(windows) { "Scripts" } else { "bin" }),
        ] {
            if dir.exists() {
                paths.push(dir);
            }
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

    /// Validates a Python executable path by running `[python_path, "--version"]` safely without shell.
    /// Captures both stdout and stderr and preserves spaces in paths.
    pub fn validate_python_executable(raw_path: &str) -> PythonValidationResult {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return PythonValidationResult {
                valid: false,
                executable_path: String::new(),
                version: None,
                stdout: None,
                stderr: None,
                error: Some("Python executable path is empty.".to_string()),
            };
        }

        let looks_like_file_path =
            trimmed.contains('\\') || trimmed.contains('/') || trimmed.to_ascii_lowercase().ends_with(".exe");
        if looks_like_file_path && !Path::new(trimmed).is_file() {
            return PythonValidationResult {
                valid: false,
                executable_path: trimmed.to_string(),
                version: None,
                stdout: None,
                stderr: None,
                error: Some(format!("Python executable does not exist at '{}'.", trimmed)),
            };
        }

        let mut cmd = Command::new(trimmed);
        cmd.arg("--version");
        let opts = ProcessOptions {
            timeout: ENGINE_VERSION_TIMEOUT,
            truncate_stdout_tail: true,
            ..ProcessOptions::default()
        };

        match process::run_command_with_options(&mut cmd, opts) {
            Ok(out) => {
                let stdout_clean = out.stdout.trim().to_string();
                let stderr_clean = out.stderr.trim().to_string();
                let combined = if !stdout_clean.is_empty() {
                    stdout_clean.clone()
                } else {
                    stderr_clean.clone()
                };

                if !out.status.success() {
                    return PythonValidationResult {
                        valid: false,
                        executable_path: trimmed.to_string(),
                        version: None,
                        stdout: Some(stdout_clean),
                        stderr: Some(stderr_clean.clone()),
                        error: Some(if combined.is_empty() {
                            format!(
                                "Python exited with status {:?}",
                                out.status.code()
                            )
                        } else {
                            combined
                        }),
                    };
                }

                let first_line = combined.lines().next().unwrap_or("").trim().to_string();
                if !first_line.to_ascii_lowercase().starts_with("python ") {
                    return PythonValidationResult {
                        valid: false,
                        executable_path: trimmed.to_string(),
                        version: None,
                        stdout: Some(stdout_clean),
                        stderr: Some(stderr_clean),
                        error: Some(format!(
                            "Executable did not report a Python version string (got: '{}').",
                            first_line
                        )),
                    };
                }

                let ver = first_line
                    .trim_start_matches("Python ")
                    .trim_start_matches("python ")
                    .trim()
                    .to_string();
                if !ver.starts_with("3.") {
                    return PythonValidationResult {
                        valid: false,
                        executable_path: trimmed.to_string(),
                        version: Some(ver.clone()),
                        stdout: Some(stdout_clean),
                        stderr: Some(stderr_clean),
                        error: Some(format!(
                            "Python 3.x is required for spotDL (found Python {}).",
                            ver
                        )),
                    };
                }

                PythonValidationResult {
                    valid: true,
                    executable_path: trimmed.to_string(),
                    version: Some(ver),
                    stdout: Some(stdout_clean),
                    stderr: Some(stderr_clean),
                    error: None,
                }
            }
            Err(e) => PythonValidationResult {
                valid: false,
                executable_path: trimmed.to_string(),
                version: None,
                stdout: None,
                stderr: None,
                error: Some(format!("Failed executing '{} --version': {}", trimmed, e)),
            },
        }
    }

    /// Strict Python resolver:
    /// When `settings.python_path` is set, NEVER falls back silently to PATH `python`/`python3`.
    /// When `settings.python_path` is unset/empty, searches standard PATH python names.
    pub fn resolve_python_for_spotdl(settings: &AppSettings) -> Result<PathBuf, String> {
        if let Some(ref custom) = settings.python_path {
            let trimmed = custom.trim();
            if !trimmed.is_empty() {
                let res = Self::validate_python_executable(trimmed);
                if !res.valid {
                    return Err(format!(
                        "Configured Python executable is invalid ('{}'): {}",
                        trimmed,
                        res.error.unwrap_or_else(|| "Validation failed".to_string())
                    ));
                }
                return Ok(PathBuf::from(res.executable_path));
            }
        }

        let candidates = if cfg!(windows) {
            vec!["python", "python3"]
        } else {
            vec!["python3", "python"]
        };
        for cand in candidates {
            if let Some(path) = Self::find_executable(cand) {
                let res = Self::validate_python_executable(&path.to_string_lossy());
                if res.valid {
                    return Ok(path);
                }
            }
        }

        Err("No valid Python 3 executable found. Configure Python Path in Settings -> Python Configuration to use or install spotDL.".to_string())
    }

    /// Resolves how to invoke spotDL (`(program, leading_args)`).
    /// Honors strict custom `python_path` validation and prefers isolated `Engine\spotdl\venv`.
    pub fn resolve_spotdl_invocation(
        settings: &AppSettings,
    ) -> Result<(PathBuf, Vec<String>), String> {
        // Enforce strict validation first if user configured a custom Python path
        let has_custom_python = settings
            .python_path
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if has_custom_python {
            let _ = Self::resolve_python_for_spotdl(settings)?;
        }

        // 1. Prefer isolated managed venv (`Engine\spotdl\venv`)
        let venv_python = Self::spotdl_venv_python();
        if venv_python.is_file() {
            return Ok((venv_python, vec!["-m".to_string(), "spotdl".to_string()]));
        }
        let venv_exe = Self::spotdl_venv_exe();
        if venv_exe.is_file() {
            return Ok((venv_exe, Vec::new()));
        }

        // 2. Managed standalone spotDL executable (`Engine\spotdl\spotdl.exe`)
        let standalone = Self::spotdl_dir().join(Self::exe_filename("spotdl"));
        if standalone.is_file() {
            return Ok((standalone, Vec::new()));
        }

        // 3. System / bundled fallback binary
        if let Some(found) = Self::find_executable("spotdl") {
            let is_py = found
                .file_name()
                .and_then(|s| s.to_str())
                .map(|n| n.to_ascii_lowercase().starts_with("python"))
                .unwrap_or(false);
            if is_py {
                return Ok((found, vec!["-m".to_string(), "spotdl".to_string()]));
            }
            return Ok((found, Vec::new()));
        }

        Err("spotDL runtime is not installed in Engine\\spotdl. Install spotDL from Diagnostics or configure Python 3 in Settings.".to_string())
    }

    pub fn check_single_engine(name: &str, ver_flag: &str) -> EngineInfo {
        let start = Instant::now();
        let now = chrono::Utc::now().to_rfc3339();

        // Handle Python special case using configured python_path if present in settings file
        if name == "python3" || name == "python" {
            let settings_path = AppState::settings_file_path_for(&AppState::app_data_dir());
            if let Ok(raw) = fs::read_to_string(&settings_path) {
                if let Ok(parsed) = serde_json::from_str::<AppSettings>(&raw) {
                    if let Some(ref custom_py) = parsed.python_path {
                        if !custom_py.trim().is_empty() {
                            let res = Self::validate_python_executable(custom_py);
                            return EngineInfo {
                                available: res.valid,
                                version: res.version.unwrap_or_default(),
                                path: res.executable_path,
                                status: if res.valid {
                                    "ready".to_string()
                                } else {
                                    "error".to_string()
                                },
                                last_checked: now,
                                error: res.error,
                                latest_version: None,
                                update_available: Some(false),
                                is_updating: Some(false),
                                duration_ms: Some(start.elapsed().as_millis() as u64),
                            };
                        }
                    }
                }
            }
        }

        let path_opt = Self::find_executable(name).or_else(|| {
            if name == "python3" {
                Self::find_executable("python")
            } else {
                None
            }
        });

        let info = match path_opt {
            Some(path) => {
                let mut cmd = Command::new(&path);
                let is_venv_py_for_spotdl = name == "spotdl"
                    && path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|n| n.to_ascii_lowercase().starts_with("python"))
                        .unwrap_or(false);
                if is_venv_py_for_spotdl {
                    cmd.args(["-m", "spotdl", ver_flag]);
                } else {
                    cmd.arg(ver_flag);
                }
                Self::apply_engine_env(&mut cmd);

                let opts = ProcessOptions {
                    timeout: ENGINE_VERSION_TIMEOUT,
                    truncate_stdout_tail: true,
                    ..ProcessOptions::default()
                };

                match process::run_command_with_options(&mut cmd, opts) {
                    Ok(output) if output.status.success() => {
                        let raw_ver = if !output.stdout.trim().is_empty() {
                            output.stdout.clone()
                        } else {
                            output.stderr.clone()
                        };
                        let first_line = raw_ver.lines().next().unwrap_or("").trim().to_string();
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
                            duration_ms: Some(output.duration_ms),
                        }
                    }
                    Ok(output) => {
                        let err_msg = logging::redact_secrets(output.stderr.trim());
                        EngineInfo {
                            available: false,
                            version: String::new(),
                            path: path.to_string_lossy().to_string(),
                            status: "error".to_string(),
                            last_checked: now,
                            error: Some(if err_msg.is_empty() {
                                format!(
                                    "Process returned non-zero exit status ({:?})",
                                    output.status.code()
                                )
                            } else {
                                err_msg
                            }),
                            latest_version: None,
                            update_available: Some(false),
                            is_updating: Some(false),
                            duration_ms: Some(output.duration_ms),
                        }
                    }
                    Err(ProcessError::TimedOut { duration_ms }) => EngineInfo {
                        available: false,
                        version: String::new(),
                        path: path.to_string_lossy().to_string(),
                        status: "timed_out".to_string(),
                        last_checked: now,
                        error: Some(format!(
                            "Version check timed out after {:.1}s",
                            duration_ms as f64 / 1000.0
                        )),
                        latest_version: None,
                        update_available: Some(false),
                        is_updating: Some(false),
                        duration_ms: Some(duration_ms),
                    },
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
                        duration_ms: Some(start.elapsed().as_millis() as u64),
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
                    "Executable '{}' not found in managed Engine runtime or PATH",
                    name
                )),
                latest_version: None,
                update_available: Some(false),
                is_updating: Some(false),
                duration_ms: Some(start.elapsed().as_millis() as u64),
            },
        };

        logging::info(
            "engines",
            &format!(
                "Checked engine '{}': status={}, duration={}ms",
                name,
                info.status,
                info.duration_ms.unwrap_or(0)
            ),
        );
        info
    }

    pub fn get_engine_status() -> EngineStatusMap {
        let total_start = Instant::now();
        let (ytdlp, spotdl, ffmpeg, ffprobe, python3) = std::thread::scope(|s| {
            let h_ytdlp = s.spawn(|| Self::check_single_engine("yt-dlp", "--version"));
            let h_spotdl = s.spawn(|| Self::check_single_engine("spotdl", "--version"));
            let h_ffmpeg = s.spawn(|| Self::check_single_engine("ffmpeg", "-version"));
            let h_ffprobe = s.spawn(|| Self::check_single_engine("ffprobe", "-version"));
            let h_python = s.spawn(|| Self::check_single_engine("python3", "--version"));

            let y = h_ytdlp
                .join()
                .unwrap_or_else(|_| Self::check_single_engine("yt-dlp", "--version"));
            let sp = h_spotdl
                .join()
                .unwrap_or_else(|_| Self::check_single_engine("spotdl", "--version"));
            let ff = h_ffmpeg
                .join()
                .unwrap_or_else(|_| Self::check_single_engine("ffmpeg", "-version"));
            let fp = h_ffprobe
                .join()
                .unwrap_or_else(|_| Self::check_single_engine("ffprobe", "-version"));
            let py = h_python
                .join()
                .unwrap_or_else(|_| Self::check_single_engine("python3", "--version"));
            (y, sp, ff, fp, py)
        });

        logging::info(
            "engines",
            &format!(
                "Completed parallel engine health scan in {}ms.",
                total_start.elapsed().as_millis()
            ),
        );

        EngineStatusMap {
            ytdlp,
            spotdl,
            ffmpeg,
            ffprobe,
            python3,
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

        let engine_root = Self::managed_engines_root();
        let writable = Self::is_dir_writable(&engine_root);

        ManagedEngineInfo {
            install_root: Self::install_root_dir().to_string_lossy().to_string(),
            install_dir: engine_root.to_string_lossy().to_string(),
            ytdlp_dir: Self::ytdlp_dir().to_string_lossy().to_string(),
            spotdl_dir: Self::spotdl_dir().to_string_lossy().to_string(),
            ffmpeg_dir: Self::ffmpeg_dir().to_string_lossy().to_string(),
            manifest_path: Self::manifest_path().to_string_lossy().to_string(),
            settings_file_path: AppState::settings_file_path_for(&AppState::app_data_dir())
                .to_string_lossy()
                .to_string(),
            is_writable: writable,
            requires_elevation: !writable && cfg!(windows),
            required_ready: missing_required.is_empty(),
            missing_required,
            engines,
        }
    }

    pub fn ensure_required_engines(require_ffmpeg: bool, require_spotdl: bool) -> Result<(), String> {
        let status = Self::get_engine_status();
        if require_spotdl && !status.spotdl.available {
            return Err("spotDL engine is not installed. Configure Python 3 in Settings and install spotDL in Diagnostics.".to_string());
        }
        if !require_spotdl && !status.ytdlp.available {
            return Err("yt-dlp engine is not installed. Use Install Engines in Dashboard or Diagnostics first.".to_string());
        }
        if require_ffmpeg && (!status.ffmpeg.available || !status.ffprobe.available) {
            return Err("FFmpeg / FFprobe engines are not installed. Use Install Engines in Dashboard or Diagnostics first.".to_string());
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
                .map_err(|e| format!("Failed to create target Engine directory: {}", e))?;
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
            Err(rename_err) => match fs::copy(staged_file, target_file) {
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
            },
        }
    }

    #[cfg(target_os = "windows")]
    fn to_wide_null(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[cfg(target_os = "windows")]
    fn execute_elevated_admin_op(op_json_path: &Path, result_path: &Path) -> Result<AdminOpResult, String> {
        #[repr(C)]
        struct ShellExecuteInfoW {
            cb_size: u32,
            f_mask: u32,
            hwnd: *mut core::ffi::c_void,
            lp_verb: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show: i32,
            h_inst_app: *mut core::ffi::c_void,
            lp_id_list: *mut core::ffi::c_void,
            lp_class: *const u16,
            hkey_class: *mut core::ffi::c_void,
            dw_hot_key: u32,
            h_icon_or_monitor: *mut core::ffi::c_void,
            h_process: *mut core::ffi::c_void,
        }

        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteExW(pExecInfo: *mut ShellExecuteInfoW) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn WaitForSingleObject(hHandle: *mut core::ffi::c_void, dwMilliseconds: u32) -> u32;
            fn GetExitCodeProcess(hProcess: *mut core::ffi::c_void, lpExitCode: *mut u32) -> i32;
            fn CloseHandle(hObject: *mut core::ffi::c_void) -> i32;
        }

        let current_exe = env::current_exe()
            .map_err(|e| format!("Failed locating current executable for elevation: {}", e))?;
        let verb_w = Self::to_wide_null("runas");
        let file_w = Self::to_wide_null(&current_exe.to_string_lossy());
        let params_str = format!("--engine-admin \"{}\"", op_json_path.to_string_lossy());
        let params_w = Self::to_wide_null(&params_str);

        let mut sei = ShellExecuteInfoW {
            cb_size: std::mem::size_of::<ShellExecuteInfoW>() as u32,
            f_mask: 0x0000_0040 | 0x0000_0100, // SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
            hwnd: std::ptr::null_mut(),
            lp_verb: verb_w.as_ptr(),
            lp_file: file_w.as_ptr(),
            lp_parameters: params_w.as_ptr(),
            lp_directory: std::ptr::null(),
            n_show: 0, // SW_HIDE
            h_inst_app: std::ptr::null_mut(),
            lp_id_list: std::ptr::null_mut(),
            lp_class: std::ptr::null(),
            hkey_class: std::ptr::null_mut(),
            dw_hot_key: 0,
            h_icon_or_monitor: std::ptr::null_mut(),
            h_process: std::ptr::null_mut(),
        };

        let ok = unsafe { ShellExecuteExW(&mut sei) };
        if ok == 0 {
            return Err("Administrator approval (UAC) was cancelled or denied.".to_string());
        }

        if !sei.h_process.is_null() {
            unsafe {
                WaitForSingleObject(sei.h_process, 300_000);
                let mut exit_code: u32 = 1;
                GetExitCodeProcess(sei.h_process, &mut exit_code);
                CloseHandle(sei.h_process);
            }
        }

        if let Ok(raw) = fs::read_to_string(result_path) {
            if let Ok(res) = serde_json::from_str::<AdminOpResult>(&raw) {
                return Ok(res);
            }
        }
        Err("Elevated Engine installation did not produce a status report.".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    fn execute_elevated_admin_op(_op_json_path: &Path, _result_path: &Path) -> Result<AdminOpResult, String> {
        Err("Target Engine directory is not writable and UAC elevation is Windows-only.".to_string())
    }

    fn execute_admin_op_in_process(op: &AdminInstallOp) -> AdminOpResult {
        match op.action.as_str() {
            "install" => {
                for pair in &op.files {
                    let src = Path::new(&pair.src);
                    let dst = Path::new(&pair.dst);
                    if let Err(e) = Self::atomic_replace_file(src, dst) {
                        return AdminOpResult {
                            success: false,
                            version: None,
                            error: Some(e),
                        };
                    }
                    Self::make_executable(dst);
                }

                if let Some(ref rec) = op.manifest_record {
                    let root = Path::new(&op.target_root);
                    let _ = fs::create_dir_all(root);
                    let mpath = root.join("manifest.json");
                    let mut manifest = fs::read_to_string(&mpath)
                        .ok()
                        .and_then(|s| serde_json::from_str::<ManagedEngineManifest>(&s).ok())
                        .unwrap_or_default();
                    manifest.engines.insert(op.engine.clone(), rec.clone());
                    if let Ok(serialized) = serde_json::to_string_pretty(&manifest) {
                        let _ = fs::write(&mpath, serialized);
                    }
                }

                AdminOpResult {
                    success: true,
                    version: op.manifest_record.as_ref().map(|r| r.version.clone()),
                    error: None,
                }
            }
            "install_spotdl_venv" => {
                let Some(ref py_path) = op.python_path else {
                    return AdminOpResult {
                        success: false,
                        version: None,
                        error: Some("Missing Python path for spotDL venv setup.".to_string()),
                    };
                };
                let Some(ref venv_str) = op.venv_dir else {
                    return AdminOpResult {
                        success: false,
                        version: None,
                        error: Some("Missing target venv path.".to_string()),
                    };
                };
                match Self::provision_spotdl_venv(Path::new(py_path), Path::new(venv_str)) {
                    Ok(ver) => {
                        let root = Path::new(&op.target_root);
                        let _ = fs::create_dir_all(root);
                        let mpath = root.join("manifest.json");
                        let mut manifest = fs::read_to_string(&mpath)
                            .ok()
                            .and_then(|s| serde_json::from_str::<ManagedEngineManifest>(&s).ok())
                            .unwrap_or_default();
                        manifest.engines.insert(
                            "spotdl".to_string(),
                            EngineManifestRecord {
                                version: ver.clone(),
                                sha256: "venv-managed".to_string(),
                                source_url: py_path.clone(),
                                installed_at: chrono::Utc::now().to_rfc3339(),
                            },
                        );
                        if let Ok(serialized) = serde_json::to_string_pretty(&manifest) {
                            let _ = fs::write(&mpath, serialized);
                        }
                        AdminOpResult {
                            success: true,
                            version: Some(ver),
                            error: None,
                        }
                    }
                    Err(e) => AdminOpResult {
                        success: false,
                        version: None,
                        error: Some(e),
                    },
                }
            }
            "remove" => {
                for p in &op.remove_paths {
                    let target = Path::new(p);
                    if target.is_dir() {
                        let _ = fs::remove_dir_all(target);
                    } else if target.is_file() {
                        let _ = fs::remove_file(target);
                    }
                }
                AdminOpResult {
                    success: true,
                    version: None,
                    error: None,
                }
            }
            other => AdminOpResult {
                success: false,
                version: None,
                error: Some(format!("Unsupported admin action '{}'", other)),
            },
        }
    }

    pub fn run_engine_admin_cli(op_json_path: &str) -> i32 {
        let raw = match fs::read_to_string(op_json_path) {
            Ok(s) => s,
            Err(_) => return 2,
        };
        let op: AdminInstallOp = match serde_json::from_str(&raw) {
            Ok(o) => o,
            Err(_) => return 3,
        };
        let res = Self::execute_admin_op_in_process(&op);
        if let Ok(serialized) = serde_json::to_string_pretty(&res) {
            let _ = fs::write(&op.result_path, serialized);
        }
        if res.success { 0 } else { 1 }
    }

    fn provision_spotdl_venv(python_path: &Path, venv_dir: &Path) -> Result<String, String> {
        if let Some(parent) = venv_dir.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed creating Engine\\spotdl directory: {}", e))?;
        }

        let venv_python = if cfg!(windows) {
            venv_dir.join("Scripts").join("python.exe")
        } else {
            venv_dir.join("bin").join("python")
        };

        if !venv_python.is_file() {
            let mut cmd = Command::new(python_path);
            cmd.args(["-m", "venv", &venv_dir.to_string_lossy()]);
            let out = process::run_command_with_options(
                &mut cmd,
                ProcessOptions {
                    timeout: Duration::from_secs(90),
                    ..ProcessOptions::default()
                },
            )
            .map_err(|e| format!("Failed creating isolated spotDL venv: {}", e))?;
            if !out.status.success() {
                let err = logging::redact_secrets(out.stderr.trim());
                return Err(format!("Failed creating isolated spotDL venv: {}", err));
            }
        }

        let mut pip_cmd = Command::new(&venv_python);
        pip_cmd.args([
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--no-cache-dir",
            "--disable-pip-version-check",
            "--no-warn-script-location",
            "spotdl",
        ]);
        let pip_out = process::run_command_with_options(
            &mut pip_cmd,
            ProcessOptions {
                timeout: Duration::from_secs(240),
                ..ProcessOptions::default()
            },
        )
        .map_err(|e| format!("Failed installing spotDL into isolated venv: {}", e))?;

        if !pip_out.status.success() {
            let err = logging::redact_secrets(if pip_out.stderr.trim().is_empty() {
                pip_out.stdout.trim()
            } else {
                pip_out.stderr.trim()
            });
            return Err(format!("pip install spotdl failed inside Engine\\spotdl\\venv: {}", err));
        }

        let mut ver_cmd = Command::new(&venv_python);
        ver_cmd.args(["-m", "spotdl", "--version"]);
        let ver_out = process::run_command_with_options(
            &mut ver_cmd,
            ProcessOptions {
                timeout: ENGINE_VERSION_TIMEOUT,
                ..ProcessOptions::default()
            },
        )
        .map_err(|e| format!("Failed verifying spotDL in venv: {}", e))?;
        if !ver_out.status.success() {
            return Err("spotDL verification failed inside isolated venv.".to_string());
        }
        let version = ver_out
            .stdout
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        Ok(if version.is_empty() {
            "4.x".to_string()
        } else {
            version
        })
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

        let opts = ProcessOptions {
            timeout: ENGINE_VERSION_TIMEOUT,
            truncate_stdout_tail: true,
            ..ProcessOptions::default()
        };
        let output = process::run_command_with_options(&mut cmd, opts)
            .map_err(|e| format!("Failed to execute verification command: {}", e))?;

        if !output.status.success() {
            let err = logging::redact_secrets(output.stderr.trim());
            return Err(format!(
                "Verification command exited with non-zero status: {}",
                err
            ));
        }

        let version = output
            .stdout
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

    fn commit_staged_files(
        staging_dir: &Path,
        engine: &str,
        files: Vec<AdminCopyFile>,
        record: EngineManifestRecord,
    ) -> Result<(), String> {
        let root = Self::managed_engines_root();
        let op = AdminInstallOp {
            action: "install".to_string(),
            engine: engine.to_string(),
            target_root: root.to_string_lossy().to_string(),
            files,
            python_path: None,
            venv_dir: None,
            manifest_record: Some(record),
            remove_paths: Vec::new(),
            result_path: staging_dir
                .join("admin_result.json")
                .to_string_lossy()
                .to_string(),
        };

        if Self::is_dir_writable(&root) {
            let res = Self::execute_admin_op_in_process(&op);
            if res.success {
                return Ok(());
            }
            return Err(res.error.unwrap_or_else(|| "Engine installation failed".to_string()));
        }

        let op_path = staging_dir.join("admin_op.json");
        let serialized = serde_json::to_string_pretty(&op)
            .map_err(|e| format!("Failed serializing admin install spec: {}", e))?;
        fs::write(&op_path, serialized)
            .map_err(|e| format!("Failed writing admin install spec: {}", e))?;

        let res = Self::execute_elevated_admin_op(&op_path, Path::new(&op.result_path))?;
        if res.success {
            Ok(())
        } else {
            Err(res.error.unwrap_or_else(|| "Elevated Engine installation failed.".to_string()))
        }
    }

    async fn fetch_latest_github_release(
        client: &reqwest::Client,
        repository: &str,
    ) -> Result<serde_json::Value, String> {
        let url = format!("https://api.github.com/repos/{}/releases/latest", repository);
        let response = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|error| format!("Could not query the latest {} release: {}", repository, error))?
            .error_for_status()
            .map_err(|error| format!("GitHub returned an error for the latest {} release: {}", repository, error))?;

        response
            .json::<serde_json::Value>()
            .await
            .map_err(|error| format!("Could not parse the latest {} release metadata: {}", repository, error))
    }

    fn release_asset(
        release: &serde_json::Value,
        matches_name: impl Fn(&str) -> bool,
    ) -> Result<LatestReleaseAsset, String> {
        let version = release
            .get("tag_name")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if version.is_empty() {
            return Err("The upstream release did not contain a version tag.".to_string());
        }

        let assets = release
            .get("assets")
            .and_then(|value| value.as_array())
            .ok_or_else(|| format!("Release {} did not provide an asset list.", version))?;
        let asset = assets
            .iter()
            .find(|asset| {
                asset
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|name| matches_name(name))
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("Required binary asset was not found in upstream release {}.", version))?;

        let asset_name = asset
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let url = asset
            .get("browser_download_url")
            .and_then(|value| value.as_str())
            .filter(|value| value.starts_with("https://"))
            .ok_or_else(|| format!("Upstream asset '{}' has no valid HTTPS download URL.", asset_name))?
            .to_string();
        let raw_digest = asset
            .get("digest")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let sha256 = raw_digest
            .strip_prefix("sha256:")
            .unwrap_or(raw_digest)
            .to_ascii_lowercase();
        if sha256.len() != 64 || !sha256.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err(format!(
                "Upstream asset '{}' did not publish a valid SHA-256 digest; refusing an unverifiable update.",
                asset_name
            ));
        }
        let updated_at = asset
            .get("updated_at")
            .and_then(|value| value.as_str())
            .or_else(|| release.get("published_at").and_then(|value| value.as_str()))
            .unwrap_or_default()
            .to_string();

        Ok(LatestReleaseAsset {
            version,
            url,
            sha256,
            updated_at,
        })
    }

    fn normalize_release_version(value: &str) -> String {
        // CLI output may be just "4.6.0" or include a product label such as
        // "spotdl, version 4.6.0". Compare the actual trailing version token.
        let token = value
            .split_whitespace()
            .last()
            .unwrap_or(value)
            .trim()
            .trim_matches(|character: char| {
                !character.is_ascii_alphanumeric() && character != '.' && character != '-' && character != '+'
            });
        token
            .strip_prefix('v')
            .or_else(|| token.strip_prefix('V'))
            .unwrap_or(token)
            .to_ascii_lowercase()
    }

    fn is_managed_binary(path: &str, managed_dir: &Path) -> bool {
        !path.trim().is_empty() && Path::new(path).starts_with(managed_dir)
    }

    pub async fn check_engine_updates(
    ) -> Result<HashMap<String, crate::models::EngineUpdateInfo>, String> {
        use crate::models::EngineUpdateInfo;

        let status = tokio::task::spawn_blocking(Self::get_engine_status)
            .await
            .map_err(|error| format!("Engine status scan failed: {}", error))?;
        let manifest = Self::load_manifest();
        let client = reqwest::Client::builder()
            .user_agent("VANTA-Download-Manager")
            .build()
            .map_err(|error| format!("Could not create update-check client: {}", error))?;

        let mut updates = HashMap::new();

        // yt-dlp: compare the installed manifest digest with the latest official release asset.
        match Self::fetch_latest_github_release(&client, YTDLP_RELEASE_REPO).await
            .and_then(|release| {
                Self::release_asset(&release, |name| {
                    name == if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" }
                })
            }) {
            Ok(latest) => {
                let current_record = manifest.engines.get("yt-dlp");
                let digest_changed = current_record
                    .map(|record| record.sha256 != latest.sha256)
                    .unwrap_or(true);
                let current_is_managed = Self::is_managed_binary(&status.ytdlp.path, &Self::ytdlp_dir());
                let version_changed = Self::normalize_release_version(&status.ytdlp.version)
                    != Self::normalize_release_version(&latest.version);
                let update_available = !status.ytdlp.available
                    || !current_is_managed
                    || digest_changed
                    || version_changed;
                updates.insert("ytdlp".to_string(), EngineUpdateInfo {
                    current_version: if status.ytdlp.version.is_empty() { "Not installed".to_string() } else { status.ytdlp.version.clone() },
                    latest_version: latest.version,
                    update_available,
                });
            }
            Err(error) => {
                logging::warn("engines", &format!("Could not check yt-dlp updates: {}", error));
                updates.insert("ytdlp".to_string(), EngineUpdateInfo {
                    current_version: status.ytdlp.version.clone(),
                    latest_version: "Unavailable".to_string(),
                    update_available: false,
                });
            }
        }

        // spotDL: the Python installer tracks the upstream release version; the
        // Windows standalone fallback uses the release asset digest.
        match Self::fetch_latest_github_release(&client, SPOTDL_RELEASE_REPO).await {
            Ok(release) => {
                let latest_version = release
                    .get("tag_name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                let latest_normalized = Self::normalize_release_version(&latest_version);
                let current_normalized = Self::normalize_release_version(&status.spotdl.version);
                let current_record = manifest.engines.get("spotdl");
                let current_is_managed = Self::is_managed_binary(&status.spotdl.path, &Self::spotdl_dir());
                let digest_matches = current_record
                    .filter(|record| record.sha256 != "venv-managed")
                    .map(|record| {
                        Self::release_asset(&release, |name| {
                            name.starts_with("spotdl-") && name.ends_with("-win32.exe")
                        })
                        .map(|asset| record.sha256 == asset.sha256)
                        .unwrap_or(false)
                    })
                    .unwrap_or(false);
                let installed_via_venv = current_record
                    .map(|record| record.sha256 == "venv-managed")
                    .unwrap_or(false);
                let update_available = !status.spotdl.available
                    || !current_is_managed
                    || if installed_via_venv {
                        current_normalized != latest_normalized
                    } else if current_record.is_some() {
                        !digest_matches
                    } else {
                        current_normalized != latest_normalized
                    };
                updates.insert("spotdl".to_string(), EngineUpdateInfo {
                    current_version: if status.spotdl.version.is_empty() { "Not installed".to_string() } else { status.spotdl.version.clone() },
                    latest_version: latest_normalized,
                    update_available,
                });
            }
            Err(error) => {
                logging::warn("engines", &format!("Could not check spotDL updates: {}", error));
                updates.insert("spotdl".to_string(), EngineUpdateInfo {
                    current_version: status.spotdl.version.clone(),
                    latest_version: "Unavailable".to_string(),
                    update_available: false,
                });
            }
        }

        // FFmpeg: BtbN's rolling master asset is updated in-place. Compare its
        // GitHub-published SHA-256 with the archive digest stored at installation.
        match Self::fetch_latest_github_release(&client, FFMPEG_RELEASE_REPO).await
            .and_then(|release| Self::release_asset(&release, |name| name == FFMPEG_WIN_ZIP_NAME)) {
            Ok(latest) => {
                let current_record = manifest.engines.get("ffmpeg");
                let current_is_managed = Self::is_managed_binary(&status.ffmpeg.path, &Self::ffmpeg_dir());
                let update_available = !status.ffmpeg.available
                    || !status.ffprobe.available
                    || !current_is_managed
                    || current_record.map(|record| record.sha256 != latest.sha256).unwrap_or(true);
                let build_date = latest.updated_at.split('T').next().unwrap_or("latest");
                let latest_label = format!("Master build ({})", build_date);
                updates.insert("ffmpeg".to_string(), EngineUpdateInfo {
                    current_version: status.ffmpeg.version.clone(),
                    latest_version: latest_label.clone(),
                    update_available,
                });
                updates.insert("ffprobe".to_string(), EngineUpdateInfo {
                    current_version: status.ffprobe.version.clone(),
                    latest_version: latest_label,
                    update_available,
                });
            }
            Err(error) => {
                logging::warn("engines", &format!("Could not check FFmpeg updates: {}", error));
                for (name, current) in [
                    ("ffmpeg", status.ffmpeg.version.clone()),
                    ("ffprobe", status.ffprobe.version.clone()),
                ] {
                    updates.insert(name.to_string(), EngineUpdateInfo {
                        current_version: current,
                        latest_version: "Unavailable".to_string(),
                        update_available: false,
                    });
                }
            }
        }

        Ok(updates)
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

        let result: Result<String, String> = match normalized {
            "yt-dlp" => async {
                let asset_name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
                let release = Self::fetch_latest_github_release(&client, YTDLP_RELEASE_REPO).await?;
                let latest_asset = Self::release_asset(&release, |name| name == asset_name)?;
                let url = latest_asset.url.clone();
                let expected_sha = latest_asset.sha256.clone();

                let part_path = staging_dir.join(format!("{}.part", asset_name));
                Self::download_to_staging(&client, app, "yt-dlp", &url, &part_path).await?;

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
                let target_bin = Self::ytdlp_dir().join(asset_name);
                Self::commit_staged_files(
                    &staging_dir,
                    "yt-dlp",
                    vec![AdminCopyFile {
                        src: staged_bin.to_string_lossy().to_string(),
                        dst: target_bin.to_string_lossy().to_string(),
                    }],
                    EngineManifestRecord {
                        version: version.clone(),
                        sha256: actual_sha,
                        source_url: url.clone(),
                        installed_at: chrono::Utc::now().to_rfc3339(),
                    },
                )?;

                Ok(version)
            }
            .await,
            "ffmpeg" => async {
                if !cfg!(windows) {
                    return Err("Managed automatic FFmpeg bundle is configured for Windows x64; install ffmpeg & ffprobe via system package manager on Unix.".to_string());
                }

                let release = Self::fetch_latest_github_release(&client, FFMPEG_RELEASE_REPO).await?;
                let latest_asset = Self::release_asset(&release, |name| name == FFMPEG_WIN_ZIP_NAME)?;
                let expected_sha = latest_asset.sha256.clone();
                let source_url = latest_asset.url.clone();

                let archive_part = staging_dir.join("ffmpeg.zip.part");
                Self::download_to_staging(&client, app, "ffmpeg", &source_url, &archive_part).await?;

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
                    "Installing into Engine\\ffmpeg\\bin...",
                    97.0,
                    0,
                    0,
                    "Installing verified FFmpeg binaries...",
                    None,
                );

                let bin_dir = Self::ffmpeg_dir();
                let copy_files = extracted
                    .into_iter()
                    .filter_map(|file_path| {
                        file_path.file_name().map(|fname| AdminCopyFile {
                            src: file_path.to_string_lossy().to_string(),
                            dst: bin_dir.join(fname).to_string_lossy().to_string(),
                        })
                    })
                    .collect();

                let clean_ver = ffmpeg_ver
                    .trim_start_matches("ffmpeg version")
                    .trim()
                    .to_string();

                Self::commit_staged_files(
                    &staging_dir,
                    "ffmpeg",
                    copy_files,
                    EngineManifestRecord {
                        version: clean_ver.clone(),
                        sha256: actual_sha,
                        source_url: source_url.clone(),
                        installed_at: chrono::Utc::now().to_rfc3339(),
                    },
                )?;

                Ok(clean_ver)
            }
            .await,
            "spotdl" => async {
                let settings_path = AppState::settings_file_path_for(&AppState::app_data_dir());
                let current_settings: AppSettings = fs::read_to_string(&settings_path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();

                let custom_py_configured = current_settings
                    .python_path
                    .as_deref()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);

                let python_res = Self::resolve_python_for_spotdl(&current_settings);
                if custom_py_configured && python_res.is_err() {
                    return Err(python_res.unwrap_err());
                }

                if let Ok(py_path) = python_res {
                    Self::emit_install_progress(
                        app,
                        "spotdl",
                        "installing",
                        "Provisioning isolated spotDL venv...",
                        65.0,
                        0,
                        0,
                        format!(
                            "Creating isolated venv in Engine\\spotdl\\venv using {}",
                            py_path.display()
                        ),
                        None,
                    );

                    let root = Self::managed_engines_root();
                    let venv_dir = Self::spotdl_venv_dir();
                    if Self::is_dir_writable(&root) {
                        let py_clone = py_path.clone();
                        let venv_clone = venv_dir.clone();
                        return tokio::task::spawn_blocking(move || {
                            Self::provision_spotdl_venv(&py_clone, &venv_clone)
                        })
                        .await
                        .map_err(|e| format!("spotDL venv task panicked: {}", e))?;
                    } else {
                        let op = AdminInstallOp {
                            action: "install_spotdl_venv".to_string(),
                            engine: "spotdl".to_string(),
                            target_root: root.to_string_lossy().to_string(),
                            files: Vec::new(),
                            python_path: Some(py_path.to_string_lossy().to_string()),
                            venv_dir: Some(venv_dir.to_string_lossy().to_string()),
                            manifest_record: None,
                            remove_paths: Vec::new(),
                            result_path: staging_dir
                                .join("admin_result.json")
                                .to_string_lossy()
                                .to_string(),
                        };
                        let op_path = staging_dir.join("admin_op.json");
                        let serialized = serde_json::to_string_pretty(&op)
                            .map_err(|e| format!("Failed serializing spotDL admin op: {}", e))?;
                        fs::write(&op_path, serialized)
                            .map_err(|e| format!("Failed writing spotDL admin op: {}", e))?;
                        let res = Self::execute_elevated_admin_op(&op_path, Path::new(&op.result_path))?;
                        if res.success {
                            return Ok(res.version.unwrap_or_else(|| "4.x".to_string()));
                        }
                        return Err(res.error.unwrap_or_else(|| "Elevated spotDL venv setup failed".to_string()));
                    }
                }

                if !cfg!(windows) {
                    return Err(python_res.unwrap_err());
                }

                // Fallback when no Python executable is configured or installed on Windows:
                // resolve the current official standalone asset and verify its published SHA-256.
                let release = Self::fetch_latest_github_release(&client, SPOTDL_RELEASE_REPO).await?;
                let latest_asset = Self::release_asset(&release, |name| {
                    name.starts_with("spotdl-") && name.ends_with("-win32.exe")
                })?;
                let part_path = staging_dir.join("spotdl.exe.part");
                Self::download_to_staging(&client, app, "spotdl", &latest_asset.url, &part_path).await?;

                Self::emit_install_progress(
                    app,
                    "spotdl",
                    "verifying",
                    "Verifying SHA-256 checksum...",
                    90.0,
                    0,
                    0,
                    format!("Verifying spotDL {} digest...", latest_asset.version),
                    None,
                );

                let actual_sha = Self::compute_sha256_file(&part_path)?;
                if actual_sha != latest_asset.sha256 {
                    return Err(format!(
                        "SHA-256 verification failed for spotDL (expected {}, got {})",
                        latest_asset.sha256, actual_sha
                    ));
                }

                let staged_bin = staging_dir.join("spotdl.exe");
                fs::rename(&part_path, &staged_bin)
                    .map_err(|e| format!("Failed staging spotdl.exe: {}", e))?;
                let version = Self::verify_binary_runs(&staged_bin, "--version")?;
                let target_bin = Self::spotdl_dir().join("spotdl.exe");
                Self::commit_staged_files(
                    &staging_dir,
                    "spotdl",
                    vec![AdminCopyFile {
                        src: staged_bin.to_string_lossy().to_string(),
                        dst: target_bin.to_string_lossy().to_string(),
                    }],
                    EngineManifestRecord {
                        version: version.clone(),
                        sha256: actual_sha,
                        source_url: latest_asset.url.clone(),
                        installed_at: chrono::Utc::now().to_rfc3339(),
                    },
                )?;

                Ok(version)
            }
            .await,
            _ => unreachable!(),
        };

        let _ = fs::remove_dir_all(&staging_dir);

        match result {
            Ok(new_ver) => {
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

        std::thread::scope(|s| {
            let handles: Vec<_> = engines
                .iter()
                .map(|&(name, flag)| {
                    s.spawn(move || {
                        let start = Instant::now();
                        let path_opt = Self::find_executable(name);

                        match path_opt {
                            Some(path) => {
                                let mut cmd = Command::new(&path);
                                let is_venv_py = name == "spotdl"
                                    && path
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .map(|n| n.to_ascii_lowercase().starts_with("python"))
                                        .unwrap_or(false);
                                if is_venv_py {
                                    cmd.args(["-m", "spotdl", flag]);
                                } else {
                                    cmd.arg(flag);
                                }
                                Self::apply_engine_env(&mut cmd);
                                let opts = ProcessOptions {
                                    timeout: DIAGNOSTICS_TIMEOUT,
                                    truncate_stdout_tail: true,
                                    ..ProcessOptions::default()
                                };
                                let cmd_res = process::run_command_with_options(&mut cmd, opts);
                                let duration_ms = start.elapsed().as_millis() as u64;

                                match cmd_res {
                                    Ok(output) => {
                                        let stdout = output.stdout.trim().to_string();
                                        let stderr = logging::redact_secrets(output.stderr.trim());
                                        let combined =
                                            if stdout.is_empty() { stderr } else { stdout };
                                        let first_line =
                                            combined.lines().next().unwrap_or("").to_string();

                                        DiagnosticResult {
                                            engine: name.to_string(),
                                            passed: output.status.success(),
                                            version: Some(first_line),
                                            command: format!("{} {}", path.display(), flag),
                                            output: combined.chars().take(400).collect(),
                                            duration_ms,
                                        }
                                    }
                                    Err(e) => DiagnosticResult {
                                        engine: name.to_string(),
                                        passed: false,
                                        version: None,
                                        command: format!("{} {}", path.display(), flag),
                                        output: e.to_string(),
                                        duration_ms,
                                    },
                                }
                            }
                            None => DiagnosticResult {
                                engine: name.to_string(),
                                passed: false,
                                version: None,
                                command: format!("{} {}", name, flag),
                                output: "Binary not detected in Engine directory or PATH".to_string(),
                                duration_ms: start.elapsed().as_millis() as u64,
                            },
                        }
                    })
                })
                .collect();

            handles
                .into_iter()
                .enumerate()
                .map(|(idx, h)| {
                    h.join().unwrap_or_else(|_| DiagnosticResult {
                        engine: engines[idx].0.to_string(),
                        passed: false,
                        version: None,
                        command: format!("{} {}", engines[idx].0, engines[idx].1),
                        output: "Diagnostic worker panicked".to_string(),
                        duration_ms: 0,
                    })
                })
                .collect()
        })
    }

    pub fn sanitize_log(text: &str) -> String {
        logging::redact_secrets(text)
    }

    pub fn build_ytdlp_request_args(url: &str, settings: &AppSettings) -> Result<Vec<String>, String> {
        let mut args = Vec::new();

        let ua = settings
            .user_agent
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
        args.push("--user-agent".to_string());
        args.push(ua.to_string());
        args.push("--add-header".to_string());
        args.push("Accept-Language:en-US,en;q=0.9".to_string());

        if let Some(scheme_idx) = url.find("://") {
            let after_scheme = &url[scheme_idx + 3..];
            let host = after_scheme.split(&['/', '?', '#'][..]).next().unwrap_or("").to_ascii_lowercase();
            if !host.is_empty() {
                args.push("--referer".to_string());
                args.push(format!("{}://{}/", &url[..scheme_idx], host));
            }
            if host == "youtu.be"
                || host == "youtube.com"
                || host.ends_with(".youtube.com")
                || host == "youtube-nocookie.com"
                || host.ends_with(".youtube-nocookie.com")
            {
                args.push("--extractor-args".to_string());
                args.push("youtube:player_client=default,web_embedded".to_string());
            }
        }

        if let Some(ffmpeg_path) = Self::find_executable("ffmpeg") {
            if let Some(parent) = ffmpeg_path.parent() {
                args.push("--ffmpeg-location".to_string());
                args.push(parent.to_string_lossy().to_string());
            }
        }

        match cookies::resolve_cookie_source(settings, None, None)? {
            ResolvedCookieSource::File(cookie_path) => {
                args.push("--cookies".to_string());
                args.push(cookie_path.to_string_lossy().to_string());
            }
            ResolvedCookieSource::Browser { spec, .. } => {
                args.push("--cookies-from-browser".to_string());
                args.push(spec);
            }
            ResolvedCookieSource::Disabled => {}
        }

        Ok(args)
    }

    pub fn unsupported_non_media_extension(url: &str) -> Option<String> {
        let parsed = reqwest::Url::parse(url.trim()).ok()?;
        let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
        let streaming_hosts = [
            "youtube.com", "youtu.be", "youtube-nocookie.com", "vimeo.com", "twitch.tv",
            "tiktok.com", "instagram.com", "facebook.com", "fb.watch", "x.com", "twitter.com",
            "dailymotion.com", "soundcloud.com", "bandcamp.com", "bilibili.com", "reddit.com",
            "rumble.com", "kick.com",
        ];
        if streaming_hosts
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{}", h)))
            || crate::spotify::is_spotify_url(url)
        {
            return None;
        }
        let path_lower = parsed.path().to_ascii_lowercase();
        let last_seg = path_lower.split('/').filter(|s| !s.is_empty()).last().unwrap_or("");
        if let Some((_, ext)) = last_seg.rsplit_once('.') {
            let unsupported_exts = [
                "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "tbz2", "txz",
                "iso", "img", "dmg", "exe", "msi", "msix", "appimage", "deb", "rpm", "apk", "cab", "pkg",
                "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "rtf", "odt", "epub", "mobi",
                "png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp", "ico", "tiff",
                "bin", "dat", "wasm", "dll", "so", "dylib", "torrent", "json", "xml", "yaml", "yml",
                "md", "html", "htm", "css", "js",
            ];
            if unsupported_exts.contains(&ext) {
                return Some(ext.to_string());
            }
        }
        None
    }

    pub fn validate_inspection_url(raw: &str) -> Result<String, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("URL cannot be empty. Enter a supported video or music URL.".to_string());
        }
        if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err("Invalid URL: contains whitespace or control characters.".to_string());
        }
        if trimmed.starts_with('-') {
            return Err("Invalid URL: must start with http://, https://, or spotify:.".to_string());
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("spotify:") {
            return match crate::spotify::try_parse_spotify_input(trimmed) {
                Some(crate::spotify::ParsedSpotifyInput::Resource { .. }) => Ok(trimmed.to_string()),
                Some(crate::spotify::ParsedSpotifyInput::Invalid { error }) => Err(error),
                _ => Err("Invalid Spotify URI.".to_string()),
            };
        }

        let after_scheme = if lower.starts_with("https://") {
            &trimmed[8..]
        } else if lower.starts_with("http://") {
            &trimmed[7..]
        } else {
            return Err("Unsupported URL scheme. Only http://, https://, and spotify: URLs are supported.".to_string());
        };

        let authority = after_scheme.split(&['/', '?', '#'][..]).next().unwrap_or("");
        if authority.is_empty()
            || authority.starts_with('.')
            || authority.contains('"')
            || authority.contains('\'')
            || authority.contains(';')
            || authority.contains('|')
        {
            return Err("Malformed URL host. Check the URL and try again.".to_string());
        }

        if let Some(crate::spotify::ParsedSpotifyInput::Invalid { error }) =
            crate::spotify::try_parse_spotify_input(trimmed)
        {
            return Err(error);
        }

        if let Some(ext) = Self::unsupported_non_media_extension(trimmed) {
            return Err(format!(
                "VANTA downloads music and video only (yt-dlp / spotDL). Generic '.{}' files are not supported.",
                ext
            ));
        }

        Ok(trimmed.to_string())
    }

    pub fn is_playlist_candidate_url(url: &str) -> bool {
        let lower = url.trim().to_ascii_lowercase();
        if lower.contains("list=") || lower.contains("/playlist") || lower.contains("/sets/") || lower.contains("/album/") {
            return true;
        }
        false
    }

    pub fn select_best_thumbnail(val: &serde_json::Value) -> Option<String> {
        let mut best: Option<(f64, String)> = None;

        if let Some(arr) = val.get("thumbnails").and_then(|v| v.as_array()) {
            for item in arr {
                let Some(url) = item.get("url").and_then(|v| v.as_str()).map(str::trim) else {
                    continue;
                };
                if !crate::is_valid_thumbnail_url(url) {
                    continue;
                }
                let lower = url.to_ascii_lowercase();
                let id_str = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if id_str.contains("storyboard") || lower.contains("/sb/") || lower.contains("_sb_") {
                    continue;
                }

                let width = item
                    .get("width")
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite() && *v > 0.0)
                    .unwrap_or(0.0);
                let height = item
                    .get("height")
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite() && *v > 0.0)
                    .unwrap_or(0.0);
                let pref = item
                    .get("preference")
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite())
                    .unwrap_or(0.0);

                let mut score = if width > 0.0 && height > 0.0 {
                    width * height
                } else if height > 0.0 {
                    height * height * 1.5
                } else if width > 0.0 {
                    width * width * 0.6
                } else {
                    1000.0
                };

                score += pref * 100.0;
                if lower.contains("maxresdefault") || lower.contains("sddefault") {
                    score += 500_000.0;
                } else if lower.contains("hq720") || lower.contains("hqdefault") {
                    score += 200_000.0;
                } else if lower.contains("mqdefault") {
                    score += 50_000.0;
                }
                if lower.starts_with("https://") {
                    score += 10.0;
                }

                if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                    best = Some((score, url.to_string()));
                }
            }
        }

        if let Some((_, url)) = best {
            return Some(url);
        }

        for field in ["album_artwork", "thumbnail"] {
            if let Some(url) = val.get(field).and_then(|v| v.as_str()).map(str::trim) {
                if crate::is_valid_thumbnail_url(url) {
                    return Some(url.to_string());
                }
            }
        }

        None
    }

    pub fn inspect_url(url: &str, settings: &AppSettings) -> Result<MediaMetadata, String> {
        Self::inspect_url_with_tracking("direct", url, settings, None, None)
    }

    pub fn inspect_url_with_tracking(
        request_id: &str,
        raw_url: &str,
        settings: &AppSettings,
        cancel_flag: Option<Arc<AtomicBool>>,
        pid_slot: Option<Arc<AtomicU32>>,
    ) -> Result<MediaMetadata, String> {
        Self::inspect_url_with_tracking_opts(request_id, raw_url, settings, cancel_flag, pid_slot, None)
    }

    pub fn inspect_url_with_tracking_opts(
        request_id: &str,
        raw_url: &str,
        settings: &AppSettings,
        cancel_flag: Option<Arc<AtomicBool>>,
        pid_slot: Option<Arc<AtomicU32>>,
        include_playlist: Option<bool>,
    ) -> Result<MediaMetadata, String> {
        let url = Self::validate_inspection_url(raw_url)?;
        if cancel_flag.as_ref().map(|f| f.load(std::sync::atomic::Ordering::SeqCst)).unwrap_or(false) {
            return Err("Inspection cancelled.".to_string());
        }

        if crate::spotify::is_spotify_url(&url) {
            return crate::spotify::resolve_spotify_metadata_blocking(&url, cancel_flag);
        }

        let ytdlp_path = Self::find_executable("yt-dlp").ok_or_else(|| {
            "yt-dlp engine is not installed. Use Install Engines in Dashboard or Diagnostics first."
                .to_string()
        })?;

        Self::inspect_url_with_binary_opts(
            &ytdlp_path,
            request_id,
            &url,
            settings,
            INSPECT_URL_TIMEOUT,
            INSPECT_MAX_STDOUT_BYTES,
            cancel_flag,
            pid_slot,
            include_playlist,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn inspect_url_with_binary(
        ytdlp_path: &Path,
        request_id: &str,
        url: &str,
        settings: &AppSettings,
        timeout: Duration,
        max_stdout_bytes: usize,
        cancel_flag: Option<Arc<AtomicBool>>,
        pid_slot: Option<Arc<AtomicU32>>,
    ) -> Result<MediaMetadata, String> {
        Self::inspect_url_with_binary_opts(
            ytdlp_path,
            request_id,
            url,
            settings,
            timeout,
            max_stdout_bytes,
            cancel_flag,
            pid_slot,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn inspect_url_with_binary_opts(
        ytdlp_path: &Path,
        request_id: &str,
        url: &str,
        settings: &AppSettings,
        timeout: Duration,
        max_stdout_bytes: usize,
        cancel_flag: Option<Arc<AtomicBool>>,
        pid_slot: Option<Arc<AtomicU32>>,
        include_playlist: Option<bool>,
    ) -> Result<MediaMetadata, String> {
        let validated_url = Self::validate_inspection_url(url)?;
        let extra_args = Self::build_ytdlp_request_args(&validated_url, settings)?;
        let wants_playlist = include_playlist.unwrap_or_else(|| Self::is_playlist_candidate_url(&validated_url));

        let mut cmd = Command::new(ytdlp_path);
        cmd.args([
            "--dump-single-json",
            if wants_playlist { "--flat-playlist" } else { "--no-playlist" },
            "--no-warnings",
            "--no-call-home",
            "--no-cache-dir",
            "--skip-download",
            "--no-exec",
            "--socket-timeout",
            "15",
            "--retries",
            "2",
            "--extractor-retries",
            "2",
        ]);
        cmd.args(&extra_args);
        if !settings.proxy_url.trim().is_empty() {
            cmd.args(["--proxy", settings.proxy_url.trim()]);
        }
        cmd.arg("--");
        cmd.arg(&validated_url);
        Self::apply_engine_env(&mut cmd);

        logging::info(
            "inspect",
            &format!("Starting URL inspection request '{}' (timeout={}s)", request_id, timeout.as_secs()),
        );

        let opts = ProcessOptions {
            timeout,
            max_stdout_bytes,
            truncate_stdout_tail: false,
            cancel_flag,
            pid_slot,
            ..ProcessOptions::default()
        };

        let output = match process::run_command_with_options(&mut cmd, opts) {
            Ok(out) => out,
            Err(ProcessError::TimedOut { duration_ms }) => {
                logging::warn(
                    "inspect",
                    &format!("Inspection request '{}' timed out after {}ms", request_id, duration_ms),
                );
                return Err(format!(
                    "URL inspection timed out after {:.0}s because the target site or extractor did not respond in time.",
                    (duration_ms as f64 / 1000.0).max(1.0)
                ));
            }
            Err(ProcessError::Cancelled) => {
                logging::info("inspect", &format!("Inspection request '{}' cancelled", request_id));
                return Err("Inspection cancelled.".to_string());
            }
            Err(ProcessError::OutputLimitExceeded { limit_bytes, .. }) => {
                logging::warn(
                    "inspect",
                    &format!(
                        "Inspection request '{}' exceeded metadata output limit ({} bytes)",
                        request_id, limit_bytes
                    ),
                );
                return Err(format!(
                    "Metadata payload exceeded safe limit ({} MiB) and was aborted safely.",
                    (limit_bytes / (1024 * 1024)).max(1)
                ));
            }
            Err(e) => {
                logging::error("inspect", &format!("Inspection request '{}' spawn/wait error: {}", request_id, e));
                return Err(format!("Failed to execute yt-dlp: {}", e));
            }
        };

        logging::info(
            "inspect",
            &format!(
                "Inspection request '{}' exited with {:?} in {}ms",
                request_id,
                output.status.code(),
                output.duration_ms
            ),
        );

        if !output.status.success() {
            let err_clean = Self::sanitize_log(if output.stderr.trim().is_empty() {
                output.stdout.trim()
            } else {
                output.stderr.trim()
            });
            let lower = err_clean.to_ascii_lowercase();

            if lower.contains("could not copy chrome cookie database")
                || lower.contains("cookie database")
                || lower.contains("dpapi")
                || lower.contains("app-bound")
                || lower.contains("database is locked")
            {
                return Err(format!(
                    "Browser cookie database access failed: {}\n\nClose the browser, select Firefox, or import a Netscape cookies.txt file in Settings > Cookies.",
                    err_clean
                ));
            }

            if lower.contains("sign in") || lower.contains("cookies for authentication") {
                return Err(format!(
                    "Authentication required: {}\n\nConfigure your browser profile or import a valid cookies.txt file in Settings > Cookies.",
                    err_clean
                ));
            }

            if lower.contains("unsupported url") {
                return Err(format!(
                    "Unsupported media URL or provider: {}",
                    err_clean.lines().next().unwrap_or("Unsupported URL")
                ));
            }

            return Err(format!(
                "Inspection failed (exit code {}): {}",
                output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()),
                if err_clean.is_empty() { "No diagnostic details reported by yt-dlp." } else { &err_clean }
            ));
        }

        let val: serde_json::Value = serde_json::from_str(&output.stdout).map_err(|e| {
            logging::warn(
                "inspect",
                &format!("Inspection request '{}' returned malformed JSON: {}", request_id, e),
            );
            format!("Received invalid or incomplete metadata from extractor: {}", e)
        })?;

        let mut formats = Vec::new();
        if let Some(formats_arr) = val.get("formats").and_then(|f| f.as_array()) {
            for f in formats_arr.iter().take(500) {
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
                let tbr = f.get("tbr").and_then(|v| v.as_f64());
                let abr = f.get("abr").and_then(|v| v.as_f64());

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
                    tbr,
                    abr,
                    is_audio_only,
                    is_video_only,
                });
            }
        }

        let is_playlist = val.get("_type").and_then(|v| v.as_str()) == Some("playlist")
            || val.get("entries").and_then(|v| v.as_array()).is_some();

        let entries: Option<Vec<PlaylistEntry>> = if is_playlist {
            val.get("entries").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .take(200)
                    .enumerate()
                    .map(|(idx, e)| {
                        let entry_id = e
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("{}", idx + 1));
                        let entry_url = e
                            .get("webpage_url")
                            .or_else(|| e.get("url"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| validated_url.clone());
                        let dur = e.get("duration").and_then(|v| {
                            v.as_u64().or_else(|| {
                                v.as_f64()
                                    .filter(|f| f.is_finite() && *f >= 0.0)
                                    .map(|f| f.round() as u64)
                            })
                        });
                        let dur_str = dur.map(|d| {
                            let m = (d % 3600) / 60;
                            let s = d % 60;
                            let h = d / 3600;
                            if h > 0 {
                                format!("{:02}:{:02}:{:02}", h, m, s)
                            } else {
                                format!("{:02}:{:02}", m, s)
                            }
                        });
                        PlaylistEntry {
                            id: entry_id,
                            index: idx + 1,
                            title: e
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Playlist Item")
                                .to_string(),
                            url: entry_url,
                            duration: dur,
                            duration_string: dur_str,
                            uploader: e
                                .get("uploader")
                                .or_else(|| e.get("channel"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            thumbnail: Self::select_best_thumbnail(e),
                        }
                    })
                    .collect()
            })
        } else {
            None
        };

        let parse_subtitle_languages = |field: &str| -> Vec<SubtitleLanguage> {
            let mut languages = val
                .get(field)
                .and_then(|value| value.as_object())
                .map(|map| {
                    map.iter()
                        .filter_map(|(code, entries)| {
                            let entries = entries.as_array()?;
                            if entries.is_empty() {
                                return None;
                            }
                            let name = entries
                                .iter()
                                .find_map(|entry| entry.get("name").and_then(|v| v.as_str()))
                                .unwrap_or(code)
                                .to_string();
                            Some(SubtitleLanguage {
                                code: code.clone(),
                                name,
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            languages.sort_by(|a, b| a.code.cmp(&b.code));
            languages
        };
        let subtitles = parse_subtitle_languages("subtitles");
        let automatic_subtitles = parse_subtitle_languages("automatic_captions");

        Ok(MediaMetadata {
            url: validated_url,
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
            duration: val.get("duration").and_then(|v| {
                v.as_u64().or_else(|| {
                    v.as_f64()
                        .filter(|f| f.is_finite() && *f >= 0.0)
                        .map(|f| f.round() as u64)
                })
            }),
            duration_string: val
                .get("duration_string")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            thumbnail: Self::select_best_thumbnail(&val),
            description: val
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(500).collect()),
            formats,
            subtitles,
            automatic_subtitles,
            is_playlist,
            playlist_count: val.get("entries").and_then(|v| v.as_array()).map(|a| a.len()),
            entries,
            extractor: val
                .get("extractor")
                .and_then(|v| v.as_str())
                .unwrap_or("yt-dlp")
                .to_string(),
            ..MediaMetadata::default()
        })
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

        let opts = ProcessOptions {
            timeout: FFPROBE_TIMEOUT,
            truncate_stdout_tail: false,
            ..ProcessOptions::default()
        };
        let output = process::run_command_with_options(&mut cmd, opts).ok()?;
        if !output.status.success() {
            return None;
        }

        let val: serde_json::Value = serde_json::from_str(&output.stdout).ok()?;
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

    pub fn verify_media_file(
        file_path: &Path,
    ) -> Option<(Option<String>, Option<String>, Option<String>, Option<String>)> {
        let ffprobe = Self::find_executable("ffprobe")?;
        if !file_path.is_file() {
            return None;
        }
        let mut cmd = Command::new(&ffprobe);
        cmd.args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            file_path.to_str()?,
        ]);
        Self::apply_engine_env(&mut cmd);

        let opts = ProcessOptions {
            timeout: FFPROBE_TIMEOUT,
            truncate_stdout_tail: false,
            ..ProcessOptions::default()
        };
        let output = process::run_command_with_options(&mut cmd, opts).ok()?;
        if !output.status.success() {
            return None;
        }

        let val: serde_json::Value = serde_json::from_str(&output.stdout).ok()?;
        let streams = val.get("streams").and_then(|s| s.as_array())?;

        let audio_stream = streams
            .iter()
            .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"));
        let video_stream = streams.iter().find(|s| {
            s.get("codec_type").and_then(|v| v.as_str()) == Some("video")
                && s.get("disposition")
                    .and_then(|d| d.get("attached_pic"))
                    .and_then(|a| a.as_u64())
                    .unwrap_or(0)
                    == 0
        });

        let mut audio_summary = None;
        let mut audio_codec = None;
        if let Some(stream) = audio_stream {
            let codec = stream
                .get("codec_name")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_uppercase();
            audio_codec = Some(codec.clone());
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
            audio_summary = Some(format!(
                "{} · {}-bit · {} Hz · {}",
                codec, bit_depth, sample_rate, channel_label
            ));
        }

        let video_codec = video_stream
            .and_then(|s| s.get("codec_name").and_then(|v| v.as_str()))
            .map(|c| c.to_uppercase());
        let resolution_label = video_stream.and_then(|s| {
            let h = s.get("height").and_then(|v| v.as_u64())?;
            let w = s.get("width").and_then(|v| v.as_u64()).unwrap_or(0);
            if w > 0 {
                Some(format!("{}x{} ({}p)", w, h, h))
            } else {
                Some(format!("{}p", h))
            }
        });

        Some((audio_summary, audio_codec, video_codec, resolution_label))
    }

    pub fn remove_managed_engine(name: &str) -> EngineUpdateResult {
        let normalized = if name.eq_ignore_ascii_case("ytdlp") || name.eq_ignore_ascii_case("yt-dlp") {
            "yt-dlp"
        } else if name.eq_ignore_ascii_case("ffmpeg") || name.eq_ignore_ascii_case("ffprobe") {
            "ffmpeg"
        } else {
            "spotdl"
        };

        let remove_paths: Vec<PathBuf> = match normalized {
            "yt-dlp" => vec![Self::ytdlp_dir()],
            "ffmpeg" => vec![Self::managed_engines_root().join("ffmpeg")],
            _ => vec![Self::spotdl_dir()],
        };

        let root = Self::managed_engines_root();
        let op = AdminInstallOp {
            action: "remove".to_string(),
            engine: normalized.to_string(),
            target_root: root.to_string_lossy().to_string(),
            files: Vec::new(),
            python_path: None,
            venv_dir: None,
            manifest_record: None,
            remove_paths: remove_paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            result_path: Self::managed_staging_dir()
                .join(format!("remove_{}.json", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .to_string(),
        };

        let res = if Self::is_dir_writable(&root) {
            Self::execute_admin_op_in_process(&op)
        } else {
            let op_path = Self::managed_staging_dir().join(format!("remove_op_{}.json", uuid::Uuid::new_v4()));
            let _ = fs::create_dir_all(Self::managed_staging_dir());
            if let Ok(serialized) = serde_json::to_string_pretty(&op) {
                let _ = fs::write(&op_path, serialized);
                Self::execute_elevated_admin_op(&op_path, Path::new(&op.result_path))
                    .unwrap_or_else(|e| AdminOpResult {
                        success: false,
                        version: None,
                        error: Some(e),
                    })
            } else {
                AdminOpResult {
                    success: false,
                    version: None,
                    error: Some("Failed preparing removal operation.".to_string()),
                }
            }
        };

        EngineUpdateResult {
            engine: normalized.to_string(),
            success: res.success,
            previous_version: String::new(),
            current_version: String::new(),
            message: if res.success {
                format!("Removed managed {} from Engine directory.", normalized)
            } else {
                res.error.unwrap_or_else(|| format!("Failed removing managed {}.", normalized))
            },
            rolled_back: None,
        }
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
    fn test_normalize_release_versions() {
        assert_eq!(EngineManager::normalize_release_version("v4.6.0"), "4.6.0");
        assert_eq!(EngineManager::normalize_release_version("4.6.0"), "4.6.0");
        assert_eq!(EngineManager::normalize_release_version("spotdl, version 4.6.0"), "4.6.0");
        assert_eq!(EngineManager::normalize_release_version("2026.11.23"), "2026.11.23");
    }

    #[test]
    fn test_release_asset_uses_upstream_digest_and_download_url() {
        let release = serde_json::json!({
            "tag_name": "2026.11.23",
            "published_at": "2026-11-23T23:49:56Z",
            "assets": [{
                "name": "yt-dlp.exe",
                "browser_download_url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp.exe",
                "digest": "sha256:622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c",
                "updated_at": "2026-11-23T23:49:50Z"
            }]
        });
        let asset = EngineManager::release_asset(&release, |name| name == "yt-dlp.exe").unwrap();
        assert_eq!(asset.version, "2026.11.23");
        assert_eq!(asset.sha256, "622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c");
        assert_eq!(asset.url, "https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp.exe");
    }

    #[test]
    fn test_release_asset_rejects_missing_digest() {
        let release = serde_json::json!({
            "tag_name": "v1.2.3",
            "assets": [{
                "name": "tool.exe",
                "browser_download_url": "https://example.com/tool.exe"
            }]
        });
        assert!(EngineManager::release_asset(&release, |name| name == "tool.exe").is_err());
    }

    #[test]
    fn test_compute_sha256_and_atomic_replace() {
        let base = env::temp_dir().join(format!("vanta_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();

        let staged = base.join("staged.bin");
        let target = base.join("Engine").join("yt-dlp").join("tool.bin");

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
    fn test_validate_inspection_url_rejects_generic_non_media_files() {
        assert!(EngineManager::validate_inspection_url("").is_err());
        assert!(EngineManager::validate_inspection_url("   ").is_err());
        assert!(EngineManager::validate_inspection_url("--exec whoami").is_err());
        assert!(EngineManager::validate_inspection_url("file:///etc/passwd").is_err());
        assert!(EngineManager::validate_inspection_url("javascript:alert(1)").is_err());
        assert!(EngineManager::validate_inspection_url("https://example.com/v?a=1 b=2").is_err());
        assert!(EngineManager::validate_inspection_url("https://").is_err());

        for generic in [
            "https://cdn.example.com/release.zip",
            "https://cdn.example.com/archive.rar",
            "https://cdn.example.com/setup.exe",
            "https://cdn.example.com/installer.msi",
            "https://cdn.example.com/manual.pdf",
            "https://cdn.example.com/ubuntu.iso",
            "https://cdn.example.com/disk.dmg",
            "https://cdn.example.com/photo.png",
        ] {
            let err = EngineManager::validate_inspection_url(generic).unwrap_err();
            assert!(
                err.contains("music and video only"),
                "expected media-only rejection for {}, got {}",
                generic,
                err
            );
        }

        let ok = EngineManager::validate_inspection_url("  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ")
            .expect("valid https url should pass");
        assert_eq!(ok, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }

    #[cfg(unix)]
    #[test]
    fn test_validate_python_executable_and_strict_no_fallback() {
        use std::os::unix::fs::PermissionsExt;
        let dir = env::temp_dir().join(format!("vanta_py_test_{}", uuid::Uuid::new_v4()));
        let spaced_dir = dir.join("Python With Spaces");
        fs::create_dir_all(&spaced_dir).unwrap();

        // Mock Python script in a directory containing spaces
        let py_script = spaced_dir.join("python3");
        fs::write(&py_script, "#!/bin/sh\necho 'Python 3.12.4'\n").unwrap();
        fs::set_permissions(&py_script, fs::Permissions::from_mode(0o755)).unwrap();

        let ok = EngineManager::validate_python_executable(&py_script.to_string_lossy());
        assert!(ok.valid);
        assert_eq!(ok.version.as_deref(), Some("3.12.4"));

        // Invalid custom path MUST NOT fall back silently to PATH python
        let mut settings = AppSettings::default();
        settings.python_path = Some("/nonexistent/dir with spaces/python.exe".to_string());
        let strict_err = EngineManager::resolve_python_for_spotdl(&settings).unwrap_err();
        assert!(strict_err.contains("Configured Python executable is invalid"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    fn write_mock_ytdlp_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        let content = format!("#!/bin/sh\n{}", body);
        fs::write(&path, content).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn test_inspect_url_with_binary_scenarios() {
        let dir = env::temp_dir().join(format!("vanta_inspect_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        let mut settings = AppSettings::default();
        settings.cookies_browser = Some("none".to_string());
        settings.cookies_file = None;

        let ok_script = write_mock_ytdlp_script(
            &dir,
            "ytdlp_ok.sh",
            r#"
printf '{"id":"vid123","title":"Sample Video","uploader":"Creator","duration":125,"extractor":"generic","formats":[{"format_id":"18","ext":"mp4","height":360,"vcodec":"avc1","acodec":"mp4a"}]}\n'
"#,
        );
        let meta = EngineManager::inspect_url_with_binary(
            &ok_script,
            "req_ok",
            "https://example.com/watch?v=1",
            &settings,
            Duration::from_secs(5),
            1024 * 1024,
            None,
            None,
        )
        .expect("valid JSON should succeed");
        assert_eq!(meta.id, "vid123");
        assert_eq!(meta.title, "Sample Video");
        assert_eq!(meta.formats.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_select_best_thumbnail_ranks_resolution_and_rejects_storyboard() {
        let sample = serde_json::json!({
            "thumbnail": "https://i.ytimg.com/vi/abc/default.jpg",
            "thumbnails": [
                { "url": "https://i.ytimg.com/sb/abc/storyboard.jpg", "width": 2000, "height": 2000 },
                { "url": "https://i.ytimg.com/vi/abc/mqdefault.jpg", "width": 320, "height": 180 },
                { "url": "https://i.ytimg.com/vi/abc/maxresdefault.jpg", "width": 1280, "height": 720 },
                { "url": "not-a-url", "width": 4000, "height": 4000 }
            ]
        });
        assert_eq!(
            EngineManager::select_best_thumbnail(&sample).as_deref(),
            Some("https://i.ytimg.com/vi/abc/maxresdefault.jpg")
        );
    }
}
