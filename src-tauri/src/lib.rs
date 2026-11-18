pub mod models;
pub mod state;
pub mod engines;
pub mod commands;

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
    let s = s.trim().to_uppercase();
    if s.ends_with("GIB") || s.ends_with("GB") {
        let num: f64 = s.trim_end_matches("GIB").trim_end_matches("GB").trim().parse().unwrap_or(0.0);
        (num * 1024.0 * 1024.0 * 1024.0) as u64
    } else if s.ends_with("MIB") || s.ends_with("MB") {
        let num: f64 = s.trim_end_matches("MIB").trim_end_matches("MB").trim().parse().unwrap_or(0.0);
        (num * 1024.0 * 1024.0) as u64
    } else if s.ends_with("KIB") || s.ends_with("KB") {
        let num: f64 = s.trim_end_matches("KIB").trim_end_matches("KB").trim().parse().unwrap_or(0.0);
        (num * 1024.0) as u64
    } else if s.ends_with('B') {
        s.trim_end_matches('B').trim().parse().unwrap_or(0)
    } else {
        s.parse().unwrap_or(0)
    }
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
    }
}
