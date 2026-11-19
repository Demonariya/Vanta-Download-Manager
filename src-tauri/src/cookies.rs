use crate::engines::EngineManager;
use crate::logging;
use crate::models::{
    AppSettings, CookieStatus, CookieTestResult, CookieValidationResult, DetectedBrowserInfo,
};
use crate::process;
use crate::state::AppState;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SUPPORTED_BROWSERS: [(&str, &str); 6] = [
    ("chrome", "Google Chrome"),
    ("edge", "Microsoft Edge"),
    ("firefox", "Mozilla Firefox"),
    ("brave", "Brave Browser"),
    ("opera", "Opera"),
    ("vivaldi", "Vivaldi"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedCookieSource {
    File(PathBuf),
    Browser {
        browser: String,
        profile: Option<String>,
        spec: String,
    },
    Disabled,
}

pub fn managed_cookies_path() -> PathBuf {
    AppState::app_data_dir().join("cookies.txt")
}

/// Validates Netscape HTTP Cookie File format strictly without leaking any cookie values.
pub fn validate_netscape_cookies(content: &str) -> CookieValidationResult {
    let mut errors = Vec::new();
    let mut domains = HashSet::new();
    let mut record_count = 0usize;
    let mut http_only_count = 0usize;
    let mut secure_count = 0usize;
    let mut has_netscape_header = false;

    for (idx, raw_line) in content.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw_line.trim_end_matches('\r');
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        if let Some(after_prefix) = trimmed.strip_prefix("#HttpOnly_") {
            http_only_count += 1;
            if let Err(err) = parse_cookie_columns(after_prefix, line_no, &mut domains, &mut secure_count) {
                if errors.len() < 5 {
                    errors.push(err);
                }
            } else {
                record_count += 1;
            }
            continue;
        }

        if trimmed.starts_with('#') {
            if trimmed.to_ascii_lowercase().contains("netscape http cookie file") {
                has_netscape_header = true;
            }
            continue;
        }

        if let Err(err) = parse_cookie_columns(line, line_no, &mut domains, &mut secure_count) {
            if errors.len() < 5 {
                errors.push(err);
            }
        } else {
            record_count += 1;
        }
    }

    if record_count == 0 && errors.is_empty() {
        errors.push("No valid cookie entries found. Paste a Netscape cookies.txt export with tab-separated columns.".to_string());
    }

    CookieValidationResult {
        valid: errors.is_empty() && record_count > 0,
        record_count,
        domain_count: domains.len(),
        http_only_count,
        secure_count,
        has_netscape_header,
        errors,
    }
}

fn parse_cookie_columns(
    row: &str,
    line_no: usize,
    domains: &mut HashSet<String>,
    secure_count: &mut usize,
) -> Result<(), String> {
    let cols: Vec<&str> = row.split('\t').collect();
    if cols.len() != 7 {
        return Err(format!(
            "Line {}: expected 7 tab-separated Netscape fields, found {}.",
            line_no,
            cols.len()
        ));
    }

    let domain = cols[0].trim();
    let include_subdomains = cols[1].trim();
    let cookie_path = cols[2].trim();
    let secure_flag = cols[3].trim();
    let expiration = cols[4].trim();
    let name = cols[5].trim();
    let _value = cols[6];

    if domain.is_empty() || domain.contains(' ') {
        return Err(format!("Line {}: invalid cookie domain.", line_no));
    }
    if !include_subdomains.eq_ignore_ascii_case("TRUE")
        && !include_subdomains.eq_ignore_ascii_case("FALSE")
    {
        return Err(format!(
            "Line {}: domain flag must be TRUE or FALSE.",
            line_no
        ));
    }
    if cookie_path.is_empty() || !cookie_path.starts_with('/') {
        return Err(format!("Line {}: cookie path must start with '/'.", line_no));
    }
    if !secure_flag.eq_ignore_ascii_case("TRUE") && !secure_flag.eq_ignore_ascii_case("FALSE") {
        return Err(format!(
            "Line {}: secure flag must be TRUE or FALSE.",
            line_no
        ));
    }
    if expiration.parse::<u64>().is_err() {
        return Err(format!(
            "Line {}: expiration must be a non-negative UNIX timestamp.",
            line_no
        ));
    }
    if name.is_empty() {
        return Err(format!("Line {}: cookie name must not be empty.", line_no));
    }

    if secure_flag.eq_ignore_ascii_case("TRUE") {
        *secure_count += 1;
    }
    domains.insert(domain.trim_start_matches('.').to_ascii_lowercase());
    Ok(())
}

fn normalize_netscape_text(content: &str) -> String {
    let mut normalized = String::new();
    let trimmed = content.trim();
    let has_header = trimmed
        .lines()
        .next()
        .map(|l| l.to_ascii_lowercase().contains("netscape http cookie file"))
        .unwrap_or(false);

    if !has_header {
        normalized.push_str("# Netscape HTTP Cookie File\n");
    }

    for line in trimmed.lines() {
        normalized.push_str(line.trim_end_matches('\r'));
        normalized.push('\n');
    }
    normalized
}

#[cfg(unix)]
fn apply_private_file_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(windows)]
fn apply_private_file_permissions(path: &Path) {
    if let Ok(username) = env::var("USERNAME") {
        let user_trim = username.trim();
        if !user_trim.is_empty() {
            let mut cmd = Command::new("icacls");
            cmd.args([
                path.to_string_lossy().as_ref(),
                "/inheritance:r",
                "/grant:r",
                &format!("{}:(R,W)", user_trim),
            ]);
            let _ = process::run_captured_command(&mut cmd);
        }
    }
}

#[cfg(all(not(unix), not(windows)))]
fn apply_private_file_permissions(_path: &Path) {}

pub fn save_cookies_file(state: &AppState, content: &str) -> Result<CookieStatus, String> {
    let validation = validate_netscape_cookies(content);
    if !validation.valid {
        return Err(validation
            .errors
            .first()
            .cloned()
            .unwrap_or_else(|| "Invalid Netscape cookies format.".to_string()));
    }

    let app_dir = AppState::app_data_dir();
    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed creating app data dir: {}", e))?;

    let target = managed_cookies_path();
    let temp = app_dir.join(format!("cookies.txt.tmp.{}", uuid::Uuid::new_v4()));
    let normalized = normalize_netscape_text(content);

    {
        let mut f = fs::File::create(&temp)
            .map_err(|e| format!("Failed creating temporary cookie file: {}", e))?;
        f.write_all(normalized.as_bytes())
            .map_err(|e| format!("Failed writing temporary cookie file: {}", e))?;
        f.flush()
            .map_err(|e| format!("Failed flushing cookie file: {}", e))?;
    }

    apply_private_file_permissions(&temp);
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&temp, &target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("Failed committing cookie file: {}", e)
    })?;
    apply_private_file_permissions(&target);

    let mut settings = state.get_settings();
    settings.cookies_file = Some(target.to_string_lossy().to_string());
    state.save_settings(&settings);

    logging::info(
        "cookies",
        &format!(
            "Saved validated cookie file ({} records across {} domains).",
            validation.record_count, validation.domain_count
        ),
    );

    Ok(get_cookie_status(&settings))
}

pub fn remove_cookies_file(state: &AppState) -> Result<CookieStatus, String> {
    let mut settings = state.get_settings();
    if let Some(ref configured) = settings.cookies_file {
        let p = PathBuf::from(configured);
        if p.exists() {
            let _ = fs::remove_file(&p);
        }
    }
    let default_path = managed_cookies_path();
    if default_path.exists() {
        let _ = fs::remove_file(&default_path);
    }

    settings.cookies_file = None;
    state.save_settings(&settings);
    logging::info("cookies", "Removed imported cookies file and cleared configuration.");
    Ok(get_cookie_status(&settings))
}

fn chromium_profiles_in_user_data(user_data_dir: &Path) -> (Vec<String>, bool) {
    if !user_data_dir.is_dir() {
        return (Vec::new(), false);
    }

    let mut profiles = Vec::new();
    let mut has_cookie_store = false;

    if let Ok(entries) = fs::read_dir(user_data_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let is_profile_name = name == "Default" || name.starts_with("Profile ");
            let network_cookies = p.join("Network").join("Cookies");
            let legacy_cookies = p.join("Cookies");
            if is_profile_name || network_cookies.is_file() || legacy_cookies.is_file() {
                if network_cookies.is_file() || legacy_cookies.is_file() {
                    has_cookie_store = true;
                    profiles.push(name);
                }
            }
        }
    }

    // Opera puts Cookies directly inside Opera Stable/
    if profiles.is_empty() {
        if user_data_dir.join("Network").join("Cookies").is_file()
            || user_data_dir.join("Cookies").is_file()
        {
            has_cookie_store = true;
            profiles.push("Default".to_string());
        }
    }

    profiles.sort_by(|a, b| {
        if a == "Default" {
            std::cmp::Ordering::Less
        } else if b == "Default" {
            std::cmp::Ordering::Greater
        } else {
            a.cmp(b)
        }
    });

    (profiles, has_cookie_store)
}

fn firefox_profiles_in_dir(profiles_root: &Path) -> (Vec<String>, bool) {
    if !profiles_root.is_dir() {
        return (Vec::new(), false);
    }

    let mut profiles = Vec::new();
    let mut has_cookie_store = false;

    if let Ok(entries) = fs::read_dir(profiles_root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            if p.join("cookies.sqlite").is_file() {
                has_cookie_store = true;
                profiles.push(entry.file_name().to_string_lossy().to_string());
            }
        }
    }

    profiles.sort_by(|a, b| {
        let a_def = a.contains("default-release") || a.ends_with(".default");
        let b_def = b.contains("default-release") || b.ends_with(".default");
        b_def.cmp(&a_def).then_with(|| a.cmp(b))
    });

    (profiles, has_cookie_store)
}

/// Pure filesystem-based browser/profile detector parameterized by root data dirs for testability.
pub fn detect_browsers_from_roots(
    local_app_data: Option<&Path>,
    roaming_app_data: Option<&Path>,
    home_dir: Option<&Path>,
) -> Vec<DetectedBrowserInfo> {
    let mut results = Vec::new();

    for (id, label) in SUPPORTED_BROWSERS {
        let mut candidate_roots: Vec<PathBuf> = Vec::new();

        if cfg!(windows) {
            if let Some(local) = local_app_data {
                match id {
                    "chrome" => candidate_roots.push(local.join("Google").join("Chrome").join("User Data")),
                    "edge" => candidate_roots.push(local.join("Microsoft").join("Edge").join("User Data")),
                    "brave" => candidate_roots.push(local.join("BraveSoftware").join("Brave-Browser").join("User Data")),
                    "vivaldi" => candidate_roots.push(local.join("Vivaldi").join("User Data")),
                    _ => {}
                }
            }
            if let Some(roaming) = roaming_app_data {
                match id {
                    "firefox" => candidate_roots.push(roaming.join("Mozilla").join("Firefox").join("Profiles")),
                    "opera" => candidate_roots.push(roaming.join("Opera Software").join("Opera Stable")),
                    _ => {}
                }
            }
        } else if let Some(home) = home_dir {
            let xdg = env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"));
            match id {
                "chrome" => {
                    candidate_roots.push(xdg.join("google-chrome"));
                    candidate_roots.push(xdg.join("chromium"));
                    candidate_roots.push(home.join("Library/Application Support/Google/Chrome"));
                }
                "edge" => {
                    candidate_roots.push(xdg.join("microsoft-edge"));
                    candidate_roots.push(home.join("Library/Application Support/Microsoft Edge"));
                }
                "brave" => {
                    candidate_roots.push(xdg.join("BraveSoftware").join("Brave-Browser"));
                    candidate_roots.push(home.join("Library/Application Support/BraveSoftware/Brave-Browser"));
                }
                "vivaldi" => {
                    candidate_roots.push(xdg.join("vivaldi"));
                    candidate_roots.push(home.join("Library/Application Support/Vivaldi"));
                }
                "opera" => {
                    candidate_roots.push(xdg.join("opera"));
                    candidate_roots.push(home.join("Library/Application Support/com.operasoftware.Opera"));
                }
                "firefox" => {
                    candidate_roots.push(home.join(".mozilla").join("firefox"));
                    candidate_roots.push(home.join("Library/Application Support/Firefox/Profiles"));
                }
                _ => {}
            }
        }

        let mut detected = false;
        let mut profiles = Vec::new();
        let mut has_cookie_store = false;

        for root in candidate_roots {
            if root.exists() {
                detected = true;
                let (found_profiles, found_cookies) = if id == "firefox" {
                    firefox_profiles_in_dir(&root)
                } else {
                    chromium_profiles_in_user_data(&root)
                };
                if found_cookies {
                    has_cookie_store = true;
                }
                for p in found_profiles {
                    if !profiles.contains(&p) {
                        profiles.push(p);
                    }
                }
            }
        }

        let default_profile = profiles.first().cloned();
        results.push(DetectedBrowserInfo {
            id: id.to_string(),
            label: label.to_string(),
            detected,
            profiles,
            default_profile,
            has_cookie_store,
        });
    }

    results
}

pub fn detect_installed_browsers() -> Vec<DetectedBrowserInfo> {
    let local = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Local")));
    let roaming = env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Roaming")));
    let home = env::var_os("HOME").map(PathBuf::from);

    detect_browsers_from_roots(local.as_deref(), roaming.as_deref(), home.as_deref())
}

pub fn format_browser_spec(browser: &str, profile: Option<&str>) -> String {
    match profile.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => format!("{}:{}", browser, p),
        None => browser.to_string(),
    }
}

/// Deterministic cookie resolution shared by inspect_url, downloads, and cookie test:
/// 1) Valid explicitly imported/stored Netscape cookie file (--cookies <path>)
/// 2) Selected browser/profile (or validated auto-detected installed browser) (--cookies-from-browser)
/// 3) Disabled / none
pub fn resolve_cookie_source(
    settings: &AppSettings,
    override_browser: Option<&str>,
    override_profile: Option<&str>,
) -> Result<ResolvedCookieSource, String> {
    let default_path = managed_cookies_path();
    let explicit_file = settings
        .cookies_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let candidate_file = explicit_file.as_ref().or_else(|| {
        if default_path.exists() {
            Some(&default_path)
        } else {
            None
        }
    });

    if let Some(path) = candidate_file {
        if path.exists() {
            let content = fs::read_to_string(path)
                .map_err(|e| format!("Failed reading imported cookie file '{}': {}", path.display(), e))?;
            let validation = validate_netscape_cookies(&content);
            if !validation.valid {
                let reason = validation
                    .errors
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "Invalid Netscape cookie file".to_string());
                return Err(format!(
                    "Imported cookie file '{}' is invalid: {}. Replace or remove it in Settings > Cookies.",
                    path.display(),
                    reason
                ));
            }
            return Ok(ResolvedCookieSource::File(path.clone()));
        } else if explicit_file.is_some() {
            return Err(format!(
                "Configured cookie file '{}' does not exist. Re-import or clear it in Settings > Cookies.",
                path.display()
            ));
        }
    }

    let browser_raw = override_browser
        .or(settings.cookies_browser.as_deref())
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();

    if browser_raw.is_empty() || browser_raw == "none" {
        return Ok(ResolvedCookieSource::Disabled);
    }

    let profile_opt = override_profile
        .or(settings.cookies_profile.as_deref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if browser_raw == "auto" {
        let detected = detect_installed_browsers();
        // Prefer browsers that actually have a located cookie store first; on Windows Firefox
        // does not hit Chrome v127+ App-Bound Encryption DPAPI locks as often, but pick any detected store cleanly.
        let chosen = detected
            .iter()
            .find(|b| b.has_cookie_store)
            .or_else(|| detected.iter().find(|b| b.detected));

        if let Some(b) = chosen {
            let chosen_profile = profile_opt.or_else(|| b.default_profile.clone());
            let spec = format_browser_spec(&b.id, chosen_profile.as_deref());
            return Ok(ResolvedCookieSource::Browser {
                browser: b.id.clone(),
                profile: chosen_profile,
                spec,
            });
        }
        return Ok(ResolvedCookieSource::Disabled);
    }

    let spec = format_browser_spec(&browser_raw, profile_opt.as_deref());
    Ok(ResolvedCookieSource::Browser {
        browser: browser_raw,
        profile: profile_opt,
        spec,
    })
}

pub fn get_cookie_status(settings: &AppSettings) -> CookieStatus {
    let detected_browsers = detect_installed_browsers();
    let configured_browser = settings
        .cookies_browser
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    let configured_profile = settings
        .cookies_profile
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let default_path = managed_cookies_path();
    let configured_file_str = settings
        .cookies_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let file_configured = configured_file_str.is_some();
    let effective_path = configured_file_str
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| default_path.clone());
    let file_exists = effective_path.is_file();

    let mut file_valid = false;
    let mut record_count = 0usize;
    let mut domain_count = 0usize;
    let mut http_only_count = 0usize;
    let mut secure_count = 0usize;
    let mut updated_at = None;
    let mut error = None;

    if file_exists {
        if let Ok(meta) = fs::metadata(&effective_path) {
            if let Ok(mod_time) = meta.modified() {
                let dt: chrono::DateTime<chrono::Utc> = mod_time.into();
                updated_at = Some(dt.to_rfc3339());
            }
        }
        match fs::read_to_string(&effective_path) {
            Ok(text) => {
                let validation = validate_netscape_cookies(&text);
                file_valid = validation.valid;
                record_count = validation.record_count;
                domain_count = validation.domain_count;
                http_only_count = validation.http_only_count;
                secure_count = validation.secure_count;
                if !validation.valid {
                    error = validation.errors.first().cloned();
                }
            }
            Err(e) => {
                error = Some(format!("Unable to read cookie file: {}", e));
            }
        }
    } else if file_configured {
        error = Some("Configured cookies.txt file does not exist on disk.".to_string());
    }

    let resolution = resolve_cookie_source(settings, None, None);
    let (active_source, resolved_browser, resolved_profile) = match resolution {
        Ok(ResolvedCookieSource::File(_)) => ("file".to_string(), None, None),
        Ok(ResolvedCookieSource::Browser { browser, profile, .. }) => {
            let mode = if configured_browser == "auto" {
                "auto".to_string()
            } else {
                "browser".to_string()
            };
            (mode, Some(browser), profile)
        }
        Ok(ResolvedCookieSource::Disabled) => ("none".to_string(), None, None),
        Err(e) => {
            if error.is_none() {
                error = Some(e);
            }
            ("file".to_string(), None, None)
        }
    };

    CookieStatus {
        active_source,
        configured_browser: if configured_browser.is_empty() {
            "auto".to_string()
        } else {
            configured_browser
        },
        configured_profile,
        resolved_browser,
        resolved_profile,
        file_configured,
        file_exists,
        file_path: effective_path.to_string_lossy().to_string(),
        file_valid,
        record_count,
        domain_count,
        http_only_count,
        secure_count,
        updated_at,
        error,
        detected_browsers,
    }
}

pub fn test_cookie_extraction(
    settings: &AppSettings,
    override_browser: Option<&str>,
    override_profile: Option<&str>,
    test_url: Option<&str>,
) -> CookieTestResult {
    let requested_browser = override_browser
        .or(settings.cookies_browser.as_deref())
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    let requested_profile = override_profile
        .or(settings.cookies_profile.as_deref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let ytdlp_path = match EngineManager::find_executable("yt-dlp") {
        Some(p) => p,
        None => {
            return CookieTestResult {
                success: false,
                stage: "engine_missing".to_string(),
                active_source: "none".to_string(),
                browser: requested_browser,
                resolved_browser: None,
                resolved_profile: requested_profile,
                browser_detected: false,
                profile_located: false,
                database_accessible: false,
                extraction_succeeded: false,
                auth_verified: None,
                record_count: 0,
                message: "yt-dlp engine is not installed. Install engines in Dashboard or Diagnostics first.".to_string(),
                next_action: Some("Install required engines before testing cookies.".to_string()),
            };
        }
    };

    // If caller explicitly passed a browser to test in Settings UI (that isn't file-forced),
    // test the effective resolved source when requested_browser matches settings, OR if user explicitly clicked Test on a browser option while no file overrides.
    let status = get_cookie_status(settings);
    let resolved = resolve_cookie_source(settings, override_browser, override_profile);

    match resolved {
        Err(err) => CookieTestResult {
            success: false,
            stage: "file_invalid".to_string(),
            active_source: "file".to_string(),
            browser: requested_browser,
            resolved_browser: None,
            resolved_profile: None,
            browser_detected: false,
            profile_located: false,
            database_accessible: false,
            extraction_succeeded: false,
            auth_verified: None,
            record_count: status.record_count,
            message: err,
            next_action: Some("Upload or paste a valid Netscape cookies.txt file, or click Clear Cookies to use browser cookies.".to_string()),
        },
        Ok(ResolvedCookieSource::Disabled) => {
            let is_auto = requested_browser == "auto";
            CookieTestResult {
                success: false,
                stage: if is_auto {
                    "browser_not_installed".to_string()
                } else {
                    "disabled".to_string()
                },
                active_source: "none".to_string(),
                browser: requested_browser.clone(),
                resolved_browser: None,
                resolved_profile: None,
                browser_detected: false,
                profile_located: false,
                database_accessible: false,
                extraction_succeeded: false,
                auth_verified: None,
                record_count: 0,
                message: if is_auto {
                    "No supported browser with an active cookie profile was detected on this machine.".to_string()
                } else {
                    "Cookie extraction is currently disabled ('none').".to_string()
                },
                next_action: Some(
                    "Select an installed browser or import a Netscape cookies.txt file."
                        .to_string(),
                ),
            }
        }
        Ok(ResolvedCookieSource::File(cookie_path)) => {
            if let Some(url) = test_url.map(str::trim).filter(|u| !u.is_empty()) {
                let mut cmd = Command::new(&ytdlp_path);
                cmd.args([
                    "--cookies",
                    cookie_path.to_string_lossy().as_ref(),
                    "--dump-single-json",
                    "--skip-download",
                    "--no-playlist",
                    "--no-warnings",
                    url,
                ]);
                EngineManager::apply_engine_env(&mut cmd);

                let opts = process::ProcessOptions {
                    timeout: process::COOKIE_TEST_TIMEOUT,
                    ..process::ProcessOptions::default()
                };
                match process::run_command_with_options(&mut cmd, opts) {
                    Ok(out) if out.status.success() => CookieTestResult {
                        success: true,
                        stage: "auth_verified".to_string(),
                        active_source: "file".to_string(),
                        browser: "file".to_string(),
                        resolved_browser: None,
                        resolved_profile: None,
                        browser_detected: false,
                        profile_located: true,
                        database_accessible: true,
                        extraction_succeeded: true,
                        auth_verified: Some(true),
                        record_count: status.record_count,
                        message: format!(
                            "Imported cookie file ({} entries across {} domains) verified against target URL.",
                            status.record_count, status.domain_count
                        ),
                        next_action: None,
                    },
                    Ok(out) => {
                        let clean_err = logging::redact_secrets(&out.stderr);
                        CookieTestResult {
                            success: false,
                            stage: "auth_failed".to_string(),
                            active_source: "file".to_string(),
                            browser: "file".to_string(),
                            resolved_browser: None,
                            resolved_profile: None,
                            browser_detected: false,
                            profile_located: true,
                            database_accessible: true,
                            extraction_succeeded: true,
                            auth_verified: Some(false),
                            record_count: status.record_count,
                            message: format!(
                                "Cookie file format is valid ({} entries), but URL verification failed: {}",
                                status.record_count,
                                clean_err.lines().next().unwrap_or("Authentication rejected")
                            ),
                            next_action: Some("Export fresh cookies for the target site while logged in and re-import.".to_string()),
                        }
                    }
                    Err(e) => CookieTestResult {
                        success: false,
                        stage: "auth_failed".to_string(),
                        active_source: "file".to_string(),
                        browser: "file".to_string(),
                        resolved_browser: None,
                        resolved_profile: None,
                        browser_detected: false,
                        profile_located: true,
                        database_accessible: true,
                        extraction_succeeded: false,
                        auth_verified: Some(false),
                        record_count: status.record_count,
                        message: e,
                        next_action: Some("Check yt-dlp installation in Diagnostics.".to_string()),
                    },
                }
            } else {
                CookieTestResult {
                    success: true,
                    stage: "file_valid".to_string(),
                    active_source: "file".to_string(),
                    browser: "file".to_string(),
                    resolved_browser: None,
                    resolved_profile: None,
                    browser_detected: false,
                    profile_located: true,
                    database_accessible: true,
                    extraction_succeeded: true,
                    auth_verified: None,
                    record_count: status.record_count,
                    message: format!(
                        "Active imported cookies.txt is valid ({} cookies across {} domains). Add a Test URL to verify site login.",
                        status.record_count, status.domain_count
                    ),
                    next_action: None,
                }
            }
        }
        Ok(ResolvedCookieSource::Browser {
            browser,
            profile,
            spec,
        }) => {
            let detected_entry = status
                .detected_browsers
                .iter()
                .find(|b| b.id == browser);
            let browser_detected = detected_entry.map(|b| b.detected).unwrap_or(false);
            let profile_located = detected_entry
                .map(|b| {
                    if let Some(ref p) = profile {
                        b.profiles.iter().any(|existing| existing.eq_ignore_ascii_case(p))
                    } else {
                        b.has_cookie_store
                    }
                })
                .unwrap_or(false);

            if !browser_detected {
                return CookieTestResult {
                    success: false,
                    stage: "browser_not_installed".to_string(),
                    active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                    browser: requested_browser,
                    resolved_browser: Some(browser.clone()),
                    resolved_profile: profile,
                    browser_detected: false,
                    profile_located: false,
                    database_accessible: false,
                    extraction_succeeded: false,
                    auth_verified: None,
                    record_count: 0,
                    message: format!("Browser '{}' was not detected on this machine.", browser),
                    next_action: Some("Choose an installed browser or import a Netscape cookies.txt file.".to_string()),
                };
            }

            if profile.is_some() && !profile_located {
                return CookieTestResult {
                    success: false,
                    stage: "profile_missing".to_string(),
                    active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                    browser: requested_browser,
                    resolved_browser: Some(browser.clone()),
                    resolved_profile: profile.clone(),
                    browser_detected: true,
                    profile_located: false,
                    database_accessible: false,
                    extraction_succeeded: false,
                    auth_verified: None,
                    record_count: 0,
                    message: format!(
                        "Profile '{}' was not found for browser '{}'. Available profiles: {}",
                        profile.as_deref().unwrap_or(""),
                        browser,
                        detected_entry
                            .map(|b| if b.profiles.is_empty() { "none".to_string() } else { b.profiles.join(", ") })
                            .unwrap_or_else(|| "none".to_string())
                    ),
                    next_action: Some("Pick an existing profile name or leave Profile blank for default.".to_string()),
                };
            }

            let target_url = test_url
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .unwrap_or("https://www.youtube.com/robots.txt");

            let mut cmd = Command::new(&ytdlp_path);
            cmd.args([
                "--cookies-from-browser",
                &spec,
                "--dump-single-json",
                "--skip-download",
                "--no-playlist",
                "--no-warnings",
                target_url,
            ]);
            EngineManager::apply_engine_env(&mut cmd);

            let opts = process::ProcessOptions {
                timeout: process::COOKIE_TEST_TIMEOUT,
                ..process::ProcessOptions::default()
            };
            match process::run_command_with_options(&mut cmd, opts) {
                Ok(out) => {
                    let combined_err = logging::redact_secrets(&format!("{}\n{}", out.stderr, out.stdout));
                    let lower = combined_err.to_ascii_lowercase();

                    let is_db_lock_or_dpapi = lower.contains("could not copy chrome cookie database")
                        || lower.contains("could not copy")
                        || lower.contains("cookie database")
                        || lower.contains("dpapi")
                        || lower.contains("app-bound")
                        || lower.contains("database is locked")
                        || lower.contains("failed to decrypt");

                    let is_missing_cookie_db = lower.contains("could not find")
                        && (lower.contains("cookie") || lower.contains("database") || lower.contains("profile"));

                    if is_db_lock_or_dpapi {
                        CookieTestResult {
                            success: false,
                            stage: "db_locked".to_string(),
                            active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                            browser: requested_browser,
                            resolved_browser: Some(browser.clone()),
                            resolved_profile: profile,
                            browser_detected: true,
                            profile_located,
                            database_accessible: false,
                            extraction_succeeded: false,
                            auth_verified: None,
                            record_count: 0,
                            message: format!(
                                "Cookie database for '{}' is locked or protected by Windows App-Bound Encryption while the browser is running.",
                                browser
                            ),
                            next_action: Some(
                                "Close the browser completely, switch to Firefox, or export & import cookies.txt."
                                    .to_string(),
                            ),
                        }
                    } else if is_missing_cookie_db {
                        CookieTestResult {
                            success: false,
                            stage: "profile_missing".to_string(),
                            active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                            browser: requested_browser,
                            resolved_browser: Some(browser.clone()),
                            resolved_profile: profile,
                            browser_detected: true,
                            profile_located: false,
                            database_accessible: false,
                            extraction_succeeded: false,
                            auth_verified: None,
                            record_count: 0,
                            message: format!("Could not locate a readable cookie database for '{}'.", spec),
                            next_action: Some("Verify browser profile name or import cookies.txt directly.".to_string()),
                        }
                    } else if out.status.success() {
                        let has_custom_url = test_url.map(|u| !u.trim().is_empty()).unwrap_or(false);
                        CookieTestResult {
                            success: true,
                            stage: if has_custom_url { "auth_verified" } else { "extraction_ok" }.to_string(),
                            active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                            browser: requested_browser,
                            resolved_browser: Some(browser.clone()),
                            resolved_profile: profile,
                            browser_detected: true,
                            profile_located: true,
                            database_accessible: true,
                            extraction_succeeded: true,
                            auth_verified: if has_custom_url { Some(true) } else { None },
                            record_count: 0,
                            message: if has_custom_url {
                                format!("Verified cookie extraction from '{}' against target URL.", spec)
                            } else {
                                format!("Successfully accessed '{}' cookie database cleanly.", spec)
                            },
                            next_action: None,
                        }
                    } else {
                        // Cookie DB opened cleanly by yt-dlp, but target URL itself failed (e.g. robots.txt isn't an extractor URL or auth failed)
                        let has_custom_url = test_url.map(|u| !u.trim().is_empty()).unwrap_or(false);
                        let is_unsupported_probe = !has_custom_url && lower.contains("unsupported url");
                        if is_unsupported_probe {
                            CookieTestResult {
                                success: true,
                                stage: "extraction_ok".to_string(),
                                active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                                browser: requested_browser,
                                resolved_browser: Some(browser.clone()),
                                resolved_profile: profile,
                                browser_detected: true,
                                profile_located: true,
                                database_accessible: true,
                                extraction_succeeded: true,
                                auth_verified: None,
                                record_count: 0,
                                message: format!("Cookie database for '{}' opened cleanly without lock or decryption errors.", spec),
                                next_action: None,
                            }
                        } else {
                            CookieTestResult {
                                success: false,
                                stage: "auth_failed".to_string(),
                                active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                                browser: requested_browser,
                                resolved_browser: Some(browser.clone()),
                                resolved_profile: profile,
                                browser_detected: true,
                                profile_located: true,
                                database_accessible: true,
                                extraction_succeeded: true,
                                auth_verified: Some(false),
                                record_count: 0,
                                message: format!(
                                    "Browser cookies loaded from '{}', but target URL returned: {}",
                                    spec,
                                    combined_err
                                        .lines()
                                        .find(|l| !l.trim().is_empty())
                                        .unwrap_or("Verification failed")
                                ),
                                next_action: Some("Ensure you are signed in to the site inside that browser profile or import cookies.txt.".to_string()),
                            }
                        }
                    }
                }
                Err(e) => CookieTestResult {
                    success: false,
                    stage: "auth_failed".to_string(),
                    active_source: if requested_browser == "auto" { "auto" } else { "browser" }.to_string(),
                    browser: requested_browser,
                    resolved_browser: Some(browser),
                    resolved_profile: profile,
                    browser_detected: true,
                    profile_located,
                    database_accessible: false,
                    extraction_succeeded: false,
                    auth_verified: None,
                    record_count: 0,
                    message: e,
                    next_action: Some("Check yt-dlp health in Diagnostics.".to_string()),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_netscape_cookies_valid_with_httponly() {
        let sample = "\
# Netscape HTTP Cookie File
# This is a generated file! Do not edit.
.youtube.com\tTRUE\t/\tTRUE\t1899999999\tSID\tabcdef12345
#HttpOnly_.example.com\tTRUE\t/\tFALSE\t1899999999\tSESSION\tsecret_val
";
        let res = validate_netscape_cookies(sample);
        assert!(res.valid);
        assert!(res.has_netscape_header);
        assert_eq!(res.record_count, 2);
        assert_eq!(res.domain_count, 2);
        assert_eq!(res.http_only_count, 1);
        assert_eq!(res.secure_count, 1);
        assert!(res.errors.is_empty());
    }

    #[test]
    fn test_validate_netscape_cookies_rejects_empty_and_malformed() {
        let empty = validate_netscape_cookies("   \n# Netscape HTTP Cookie File\n  ");
        assert!(!empty.valid);
        assert_eq!(empty.record_count, 0);

        let bad = validate_netscape_cookies("not a valid cookie line\n.site.com\tMAYBE\tbadpath\tTRUE\tnonnum\tname\tval");
        assert!(!bad.valid);
        assert!(!bad.errors.is_empty());
    }

    #[test]
    fn test_resolve_cookie_source_precedence_file_over_browser() {
        let tmp = env::temp_dir().join(format!("vanta_cookie_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let cookie_file = tmp.join("cookies.txt");
        fs::write(
            &cookie_file,
            "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t1899999999\tAUTH\ttok123\n",
        )
        .unwrap();

        let mut settings = AppSettings::default();
        settings.cookies_browser = Some("firefox".to_string());
        settings.cookies_file = Some(cookie_file.to_string_lossy().to_string());

        let resolved = resolve_cookie_source(&settings, None, None).unwrap();
        assert_eq!(resolved, ResolvedCookieSource::File(cookie_file));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_resolve_cookie_source_errors_when_explicit_file_is_invalid() {
        let tmp = env::temp_dir().join(format!("vanta_cookie_bad_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let cookie_file = tmp.join("cookies.txt");
        fs::write(&cookie_file, "corrupt garbage content").unwrap();

        let mut settings = AppSettings::default();
        settings.cookies_file = Some(cookie_file.to_string_lossy().to_string());
        settings.cookies_browser = Some("chrome".to_string());

        let res = resolve_cookie_source(&settings, None, None);
        assert!(res.is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_detect_browsers_from_temp_roots() {
        let tmp = env::temp_dir().join(format!("vanta_browsers_{}", uuid::Uuid::new_v4()));
        #[cfg(windows)]
        let ff_dir = tmp.join("roaming").join("Mozilla").join("Firefox").join("Profiles").join("abcd.default-release");
        #[cfg(not(windows))]
        let ff_dir = tmp.join("home").join(".mozilla").join("firefox").join("abcd.default-release");

        fs::create_dir_all(&ff_dir).unwrap();
        fs::write(ff_dir.join("cookies.sqlite"), b"sqlite-placeholder").unwrap();

        let detected = detect_browsers_from_roots(
            Some(&tmp.join("local")),
            Some(&tmp.join("roaming")),
            Some(&tmp.join("home")),
        );
        let firefox = detected.iter().find(|b| b.id == "firefox").unwrap();
        assert!(firefox.detected);
        assert!(firefox.has_cookie_store);
        assert_eq!(firefox.default_profile.as_deref(), Some("abcd.default-release"));

        let _ = fs::remove_dir_all(&tmp);
    }
}
