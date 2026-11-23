pub mod commands;
pub mod cookies;
pub mod engines;
pub mod logging;
pub mod models;
pub mod process;
pub mod spotify;
pub mod state;

pub use state::AppState;

pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => '_',
            _ => c,
        })
        .collect()
}

pub fn parse_bytes(s: &str) -> u64 {
    let cleaned = s.trim().trim_start_matches('~').trim();
    if cleaned.is_empty() {
        return 0;
    }
    let upper = cleaned.to_ascii_uppercase();
    if upper == "NA" || upper == "N/A" || upper == "UNKNOWN" || upper == "--" {
        return 0;
    }

    let parse_scaled = |raw: &str, suffix: &str, mult: f64| -> Option<u64> {
        raw.strip_suffix(suffix)
            .map(str::trim)
            .and_then(|n| n.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| (v * mult).round() as u64)
    };

    if let Some(v) = parse_scaled(&upper, "TIB", 1024.0 * 1024.0 * 1024.0 * 1024.0)
        .or_else(|| parse_scaled(&upper, "TB", 1024.0 * 1024.0 * 1024.0 * 1024.0))
        .or_else(|| parse_scaled(&upper, "GIB", 1024.0 * 1024.0 * 1024.0))
        .or_else(|| parse_scaled(&upper, "GB", 1024.0 * 1024.0 * 1024.0))
        .or_else(|| parse_scaled(&upper, "MIB", 1024.0 * 1024.0))
        .or_else(|| parse_scaled(&upper, "MB", 1024.0 * 1024.0))
        .or_else(|| parse_scaled(&upper, "KIB", 1024.0))
        .or_else(|| parse_scaled(&upper, "KB", 1024.0))
        .or_else(|| parse_scaled(&upper, "B", 1.0))
    {
        return v;
    }

    upper
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v.round() as u64)
        .unwrap_or(0)
}

pub fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if let Some(&next) = chars.peek() {
                if next == '[' {
                    let _ = chars.next();
                    while let Some(ch) = chars.next() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                    continue;
                } else if next == ']' {
                    let _ = chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            let _ = chars.next();
                            break;
                        }
                    }
                    continue;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

pub fn is_valid_thumbnail_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    if lower.contains(' ') || lower.contains('"') || lower.contains('\'') || lower.contains('<') || lower.contains('>') {
        return false;
    }
    if lower.contains("storyboard")
        || lower.contains("/sb/")
        || lower.contains("_sb_")
        || lower.contains(".vtt")
        || lower.ends_with(".mhtml")
    {
        return false;
    }
    let after_scheme = if lower.starts_with("https://") {
        &lower[8..]
    } else {
        &lower[7..]
    };
    let host = after_scheme.split(&['/', '?', '#'][..]).next().unwrap_or("");
    !host.is_empty() && !host.starts_with('.')
}

pub fn is_placeholder_task_title(title: &str) -> bool {
    let t = title.trim();
    t.is_empty()
        || t == "Loading..."
        || t == "Inspecting..."
        || t == "Resolving..."
        || t == "Unknown Title"
        || t == "Queued video URL"
        || t == "Queued Download"
        || t == "Download Task"
        || t == "Queued Item"
        || t == "Media"
        || t == "Spotify Track / Album"
        || t == "Spotify Music Track"
        || t == "Spotify Album / Playlist"
        || t.starts_with("Batch Item:")
        || t.starts_with("Batch Media:")
        || t.starts_with("Inspecting ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename() {
        let raw = "Video: Title / Episode * 1 <HD>?.mp4";
        let cleaned = sanitize_filename(raw);
        assert!(!cleaned.contains(':'));
        assert!(!cleaned.contains('/'));
        assert!(!cleaned.contains('*'));
        assert!(!cleaned.contains('<'));
        assert!(!cleaned.contains('>'));
        assert!(!cleaned.contains('?'));
    }

    #[test]
    fn test_parse_bytes() {
        assert_eq!(parse_bytes("1024B"), 1024);
        assert_eq!(parse_bytes("1MB"), 1048576);
        assert_eq!(parse_bytes("1.5GiB"), 1610612736);
        assert_eq!(parse_bytes("~ 2.0 MiB"), 2097152);
        assert_eq!(parse_bytes("Unknown"), 0);
        assert_eq!(parse_bytes("N/A"), 0);
    }

    #[test]
    fn test_strip_ansi_and_thumbnail_validation() {
        assert_eq!(strip_ansi_codes("\x1b[32m[download]\x1b[0m 42.5%"), "[download] 42.5%");
        assert!(is_valid_thumbnail_url("https://i.ytimg.com/vi/abc/hqdefault.jpg"));
        assert!(!is_valid_thumbnail_url("javascript:alert(1)"));
        assert!(!is_valid_thumbnail_url("https://i.ytimg.com/sb/abc/storyboard0.jpg"));
        assert!(is_placeholder_task_title("Queued Download"));
        assert!(!is_placeholder_task_title("Never Gonna Give You Up"));
    }
}

