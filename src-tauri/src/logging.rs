use crate::models::DiagnosticLogInfo;
use crate::state::AppState;
use regex::Regex;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_LOG_SIZE_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB per log file
const MAX_ROTATED_FILES: usize = 3;

static LOG_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

static RE_BEARER: OnceLock<Regex> = OnceLock::new();
static RE_AUTH_HEADER: OnceLock<Regex> = OnceLock::new();
static RE_COOKIE_KV: OnceLock<Regex> = OnceLock::new();
static RE_QUERY_SECRET: OnceLock<Regex> = OnceLock::new();
static RE_NETSCAPE_LINE: OnceLock<Regex> = OnceLock::new();

fn log_mutex() -> &'static Mutex<()> {
    LOG_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn logs_dir() -> PathBuf {
    AppState::app_data_dir().join("logs")
}

pub fn primary_log_path() -> PathBuf {
    logs_dir().join("vanta.log")
}

/// Redacts credentials, bearer tokens, cookie headers, query tokens, and Netscape cookie row values.
pub fn redact_secrets(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    let re_bearer = RE_BEARER.get_or_init(|| {
        Regex::new(r"(?i)(bearer\s+)[a-z0-9_\-\.~=+/]+")
            .expect("valid bearer redaction regex")
    });
    let re_auth = RE_AUTH_HEADER.get_or_init(|| {
        Regex::new(r"(?i)(authorization\s*:\s*)[^\r\n]+")
            .expect("valid authorization redaction regex")
    });
    let re_cookie = RE_COOKIE_KV.get_or_init(|| {
        Regex::new(r#"(?i)(["']?(?:set-)?cookie["']?\s*:\s*["']?)[^"'\r\n]+"#)
            .expect("valid cookie header redaction regex")
    });
    let re_query = RE_QUERY_SECRET.get_or_init(|| {
        Regex::new(r"(?i)([?&](?:sig|signature|token|session_token|auth|key|secret|password|passwd|sid|hsid|ssid|apisid|sapisid)=)[^&\s]+")
            .expect("valid query secret redaction regex")
    });
    let re_netscape = RE_NETSCAPE_LINE.get_or_init(|| {
        Regex::new(r"(?m)^([^\t\r\n]+\t(?:TRUE|FALSE)\t[^\t\r\n]+\t(?:TRUE|FALSE)\t\d+\t[^\t\r\n]+\t)([^\r\n]+)$")
            .expect("valid netscape cookie redaction regex")
    });

    let s1 = re_bearer.replace_all(text, "${1}[REDACTED_TOKEN]");
    let s2 = re_auth.replace_all(&s1, "${1}[REDACTED_TOKEN]");
    let s3 = re_cookie.replace_all(&s2, "${1}[REDACTED_COOKIE]");
    let s4 = re_query.replace_all(&s3, "${1}[REDACTED]");
    let s5 = re_netscape.replace_all(&s4, "${1}[REDACTED_VALUE]");
    s5.into_owned()
}

fn rotate_if_needed(path: &PathBuf) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.len() < MAX_LOG_SIZE_BYTES {
        return;
    }

    for idx in (1..=MAX_ROTATED_FILES).rev() {
        let src = if idx == 1 {
            path.clone()
        } else {
            PathBuf::from(format!("{}.{}", path.display(), idx - 1))
        };
        let dst = PathBuf::from(format!("{}.{}", path.display(), idx));
        if dst.exists() {
            let _ = fs::remove_file(&dst);
        }
        if src.exists() {
            let _ = fs::rename(&src, &dst);
        }
    }
}

pub fn write_log(level: &str, component: &str, message: &str) {
    let dir = logs_dir();
    let path = primary_log_path();
    let _guard = log_mutex().lock().unwrap_or_else(|e| e.into_inner());

    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    rotate_if_needed(&path);

    let sanitized = redact_secrets(message).replace('\r', "");
    let line = format!(
        "[{}] [{}] [{}] {}\n",
        chrono::Utc::now().to_rfc3339(),
        level.to_ascii_uppercase(),
        component,
        sanitized.trim_end()
    );

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn info(component: &str, message: &str) {
    write_log("INFO", component, message);
}

pub fn warn(component: &str, message: &str) {
    write_log("WARN", component, message);
}

pub fn error(component: &str, message: &str) {
    write_log("ERROR", component, message);
}

pub fn install_panic_hook() {
    PANIC_HOOK_INSTALLED.get_or_init(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            let location = panic_info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "unknown location".to_string());

            let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "non-string panic payload".to_string()
            };

            let thread_name = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();

            write_log(
                "PANIC",
                "panic_hook",
                &format!(
                    "Unhandled panic on thread '{}' at {}: {}",
                    thread_name, location, payload
                ),
            );
            prev(panic_info);
        }));
    });
}

pub fn get_diagnostic_log_info(max_lines: usize) -> DiagnosticLogInfo {
    let dir = logs_dir();
    let path = primary_log_path();
    let limit = max_lines.clamp(10, 500);

    let (file_size_bytes, recent_lines) = match fs::File::open(&path) {
        Ok(mut file) => {
            let size = file.metadata().map(|m| m.len()).unwrap_or(0);
            // Read only tail 128 KiB so even a full 2 MiB file is fast to inspect
            let start = size.saturating_sub(128 * 1024);
            let _ = file.seek(SeekFrom::Start(start));
            let mut buf = Vec::new();
            let _ = file.read_to_end(&mut buf);
            let raw = String::from_utf8_lossy(&buf);
            let sanitized = redact_secrets(&raw);
            let mut lines: Vec<String> = sanitized
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect();
            if lines.len() > limit {
                lines = lines.split_off(lines.len() - limit);
            }
            (size, lines)
        }
        Err(_) => (0, Vec::new()),
    };

    DiagnosticLogInfo {
        log_dir: dir.to_string_lossy().to_string(),
        log_path: path.to_string_lossy().to_string(),
        exists: path.exists(),
        file_size_bytes,
        recent_lines,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_secrets_strips_tokens_cookies_and_netscape_rows() {
        let raw = concat!(
            "Authorization: Bearer super_secret_token_123\n",
            "Cookie: SID=abc123; HSID=def456\n",
            "Set-Cookie: session=xyz789; HttpOnly\n",
            "https://example.com/watch?v=1&token=my_secret_tok&sig=abcdef\n",
            ".example.com\tTRUE\t/\tTRUE\t1899999999\tSESSION_ID\tvery_sensitive_cookie_val"
        );

        let cleaned = redact_secrets(raw);
        assert!(!cleaned.contains("super_secret_token_123"));
        assert!(!cleaned.contains("SID=abc123"));
        assert!(!cleaned.contains("session=xyz789"));
        assert!(!cleaned.contains("my_secret_tok"));
        assert!(!cleaned.contains("abcdef"));
        assert!(!cleaned.contains("very_sensitive_cookie_val"));
        assert!(cleaned.contains("[REDACTED_TOKEN]"));
        assert!(cleaned.contains("[REDACTED_COOKIE]"));
        assert!(cleaned.contains("[REDACTED_VALUE]"));
    }
}
