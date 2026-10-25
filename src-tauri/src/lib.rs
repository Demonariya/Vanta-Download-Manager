pub mod commands;
pub mod engines;
pub mod models;
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

pub fn parse_bytes(input: &str) -> u64 {
    let text = input.trim().to_ascii_uppercase();
    for (suffix, multiplier) in [
        ("GIB", 1_073_741_824.0),
        ("GB", 1_073_741_824.0),
        ("MIB", 1_048_576.0),
        ("MB", 1_048_576.0),
        ("KIB", 1024.0),
        ("KB", 1024.0),
    ] {
        if let Some(number) = text.strip_suffix(suffix) {
            return number.trim().parse::<f64>().map(|n| (n.max(0.0) * multiplier) as u64).unwrap_or(0);
        }
    }
    text.strip_suffix('B').unwrap_or(&text).trim().parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_removes_windows_invalid_characters() {
        let cleaned = sanitize_filename("Video: Title / Episode * 1 <HD>?.mp4");
        for invalid in [':', '/', '*', '<', '>', '?'] {
            assert!(!cleaned.contains(invalid));
        }
    }

    #[test]
    fn parses_common_byte_units() {
        assert_eq!(parse_bytes("1024B"), 1024);
        assert_eq!(parse_bytes("1MB"), 1_048_576);
        assert_eq!(parse_bytes("1.5GiB"), 1_610_612_736);
    }
}
