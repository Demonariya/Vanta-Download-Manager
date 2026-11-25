use crate::logging;
use crate::models::{MediaMetadata, SpotifyTrackItem};
use regex::Regex;
use reqwest::redirect::Policy;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, Notify};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CRAWLER_USER_AGENT: &str = "curl/8.5.0";
const CACHE_TTL: Duration = Duration::from_secs(600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_WEB_API_PLAYLIST_TRACKS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpotifyContentType {
    Track,
    Album,
    Playlist,
    Artist,
}

impl SpotifyContentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Album => "album",
            Self::Playlist => "playlist",
            Self::Artist => "artist",
        }
    }

    pub fn from_str(raw: &str) -> Option<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "track" => Some(Self::Track),
            "album" => Some(Self::Album),
            "playlist" => Some(Self::Playlist),
            "artist" => Some(Self::Artist),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedSpotifyInput {
    Resource {
        content_type: SpotifyContentType,
        id: String,
        uri: String,
        canonical_url: String,
    },
    ShortLink {
        url: String,
    },
    Invalid {
        error: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpotifyOpenGraphMeta {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub album_from_description: Option<String>,
    pub track_number: Option<u32>,
    pub release_date: Option<String>,
    pub song_count: Option<usize>,
    pub owner: Option<String>,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    expires_at: Instant,
    data: MediaMetadata,
}

#[derive(Debug, Clone)]
struct WebApiToken {
    token: String,
    expires_at: Instant,
}

static METADATA_CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
static INFLIGHT_MAP: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
static WEB_API_TOKEN_CACHE: OnceLock<AsyncMutex<Option<WebApiToken>>> = OnceLock::new();

fn metadata_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    METADATA_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn inflight_map() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    INFLIGHT_MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn token_cache() -> &'static AsyncMutex<Option<WebApiToken>> {
    WEB_API_TOKEN_CACHE.get_or_init(|| AsyncMutex::new(None))
}

pub fn format_duration(seconds: u64) -> String {
    if seconds == 0 {
        return "00:00".to_string();
    }
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

pub fn is_valid_spotify_id(id: &str) -> bool {
    let len = id.len();
    (10..=36).contains(&len) && id.chars().all(|c| c.is_ascii_alphanumeric())
}

pub fn is_spotify_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    let host_no_port = lower.split(':').next().unwrap_or("");
    matches!(
        host_no_port,
        "open.spotify.com"
            | "play.spotify.com"
            | "www.spotify.com"
            | "spotify.com"
            | "spotify.link"
            | "spoti.fi"
    ) || host_no_port.ends_with(".spotify.com")
}

fn is_short_link_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    let host_no_port = lower.split(':').next().unwrap_or("");
    matches!(host_no_port, "spotify.link" | "spoti.fi")
}

/// Parses a URL or Spotify URI.
/// Returns `None` if input is clearly non-Spotify (e.g. YouTube/Vimeo).
/// Returns `Some(ParsedSpotifyInput::Invalid { .. })` for malformed/unsupported Spotify URLs.
pub fn try_parse_spotify_input(raw: &str) -> Option<ParsedSpotifyInput> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        if trimmed.to_ascii_lowercase().contains("spotify") {
            return Some(ParsedSpotifyInput::Invalid {
                error: "Malformed Spotify URL: contains whitespace or control characters."
                    .to_string(),
            });
        }
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("spotify:") {
        let parts: Vec<&str> = trimmed.split(':').collect();
        if parts.len() < 3 {
            return Some(ParsedSpotifyInput::Invalid {
                error: "Malformed Spotify URI. Expected spotify:track:<id>, spotify:album:<id>, spotify:playlist:<id>, or spotify:artist:<id>."
                    .to_string(),
            });
        }
        let raw_type = parts[1];
        let id = parts[2].trim();
        let content_type = match SpotifyContentType::from_str(raw_type) {
            Some(t) => t,
            None => {
                return Some(ParsedSpotifyInput::Invalid {
                    error: format!(
                        "Unsupported Spotify URI type \"{}\". Supported types: track, album, playlist, artist.",
                        raw_type
                    ),
                });
            }
        };
        if !is_valid_spotify_id(id) {
            return Some(ParsedSpotifyInput::Invalid {
                error: format!("Malformed Spotify {} ID \"{}\".", content_type.as_str(), id),
            });
        }
        let type_str = content_type.as_str();
        return Some(ParsedSpotifyInput::Resource {
            content_type,
            id: id.to_string(),
            uri: format!("spotify:{}:{}", type_str, id),
            canonical_url: format!("https://open.spotify.com/{}/{}", type_str, id),
        });
    }

    let after_scheme = if lower.starts_with("https://") {
        &trimmed[8..]
    } else if lower.starts_with("http://") {
        &trimmed[7..]
    } else {
        return None;
    };

    let (authority, rest) = match after_scheme.find('/') {
        Some(idx) => (&after_scheme[..idx], &after_scheme[idx..]),
        None => {
            let host_only = after_scheme.split(&['?', '#'][..]).next().unwrap_or("");
            (host_only, "")
        }
    };

    let host = authority.split('@').last().unwrap_or(authority);
    if !is_spotify_host(host) {
        return None;
    }

    let path_only = rest.split(&['?', '#'][..]).next().unwrap_or("");
    let segments: Vec<&str> = path_only
        .split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if is_short_link_host(host) {
        if segments.is_empty() {
            return Some(ParsedSpotifyInput::Invalid {
                error: "Malformed Spotify short link: missing link code.".to_string(),
            });
        }
        return Some(ParsedSpotifyInput::ShortLink {
            url: trimmed.to_string(),
        });
    }

    let mut idx = 0usize;
    if let Some(first) = segments.get(idx) {
        let f_lower = first.to_ascii_lowercase();
        if f_lower.starts_with("intl-") && f_lower.len() >= 7 {
            idx += 1;
        }
    }
    if let Some(seg) = segments.get(idx) {
        if seg.eq_ignore_ascii_case("embed") {
            idx += 1;
        }
    }

    let raw_type = match segments.get(idx) {
        Some(s) if !s.is_empty() => *s,
        _ => {
            return Some(ParsedSpotifyInput::Invalid {
                error: "Incomplete Spotify URL: expected /track/<id>, /album/<id>, /playlist/<id>, or /artist/<id>."
                    .to_string(),
            });
        }
    };

    let content_type = match SpotifyContentType::from_str(raw_type) {
        Some(t) => t,
        None => {
            return Some(ParsedSpotifyInput::Invalid {
                error: format!(
                    "Unsupported Spotify URL type \"{}\". Supported types: track, album, playlist, artist.",
                    raw_type
                ),
            });
        }
    };

    let raw_id = match segments.get(idx + 1) {
        Some(s) if !s.is_empty() => *s,
        _ => {
            return Some(ParsedSpotifyInput::Invalid {
                error: format!("Malformed Spotify URL: missing {} ID.", content_type.as_str()),
            });
        }
    };

    if !is_valid_spotify_id(raw_id) {
        return Some(ParsedSpotifyInput::Invalid {
            error: format!(
                "Malformed Spotify {} ID \"{}\".",
                content_type.as_str(),
                raw_id
            ),
        });
    }

    let type_str = content_type.as_str();
    Some(ParsedSpotifyInput::Resource {
        content_type,
        id: raw_id.to_string(),
        uri: format!("spotify:{}:{}", type_str, raw_id),
        canonical_url: format!("https://open.spotify.com/{}/{}", type_str, raw_id),
    })
}

pub fn is_spotify_url(raw: &str) -> bool {
    try_parse_spotify_input(raw).is_some()
}

pub fn is_generic_spotify_icon(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("favicon")
        || lower.ends_with(".ico")
        || lower.contains("spotifycdn.com/cdn/images/")
}

pub fn split_spotify_artists(raw: &str) -> Vec<String> {
    raw.replace('\u{00a0}', " ")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn decode_html_entities(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut out = input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&#X27;", "'")
        .replace("&apos;", "'")
        .replace("&#x2F;", "/")
        .replace("&#x2f;", "/")
        .replace("&nbsp;", " ");

    if let Ok(dec_re) = Regex::new(r"&#(\d+);") {
        out = dec_re
            .replace_all(&out, |caps: &regex::Captures| {
                caps.get(1)
                    .and_then(|m| m.as_str().parse::<u32>().ok())
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| caps[0].to_string())
            })
            .into_owned();
    }

    if let Ok(hex_re) = Regex::new(r"(?i)&#x([0-9a-f]+);") {
        out = hex_re
            .replace_all(&out, |caps: &regex::Captures| {
                caps.get(1)
                    .and_then(|m| u32::from_str_radix(m.as_str(), 16).ok())
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| caps[0].to_string())
            })
            .into_owned();
    }

    out
}

pub fn extract_spotify_next_data(html: &str) -> Option<Value> {
    let re = Regex::new(r#"(?is)<script\b[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>(.*?)</script>"#)
        .ok()?;
    let caps = re.captures(html)?;
    let raw_json = caps.get(1)?.as_str();
    let root: Value = serde_json::from_str(raw_json).ok()?;
    root.get("props")?
        .get("pageProps")?
        .get("state")?
        .get("data")?
        .get("entity")
        .cloned()
}

pub fn parse_spotify_opengraph_meta(html: &str) -> SpotifyOpenGraphMeta {
    let mut meta = SpotifyOpenGraphMeta::default();
    let tag_re = match Regex::new(r#"(?is)<meta\b([^>]+)>"#) {
        Ok(r) => r,
        Err(_) => return meta,
    };
    let prop_re = match Regex::new(r#"(?i)(?:property|name)\s*=\s*["']([^"']+)["']"#) {
        Ok(r) => r,
        Err(_) => return meta,
    };
    let content_re = match Regex::new(r#"(?i)content\s*=\s*["']([^"']*)["']"#) {
        Ok(r) => r,
        Err(_) => return meta,
    };

    for caps in tag_re.captures_iter(html) {
        let attrs = &caps[1];
        let prop = match prop_re.captures(attrs).and_then(|c| c.get(1)) {
            Some(m) => m.as_str().to_ascii_lowercase(),
            None => continue,
        };
        let val_raw = match content_re.captures(attrs).and_then(|c| c.get(1)) {
            Some(m) => m.as_str(),
            None => continue,
        };
        let val = decode_html_entities(val_raw).trim().to_string();
        if val.is_empty() {
            continue;
        }

        match prop.as_str() {
            "og:title" if meta.title.is_none() => meta.title = Some(val),
            "og:description" if meta.description.is_none() => meta.description = Some(val),
            "og:image" if !is_generic_spotify_icon(&val) && meta.image.is_none() => {
                meta.image = Some(val)
            }
            "music:album:track" => {
                if let Ok(n) = val.parse::<u32>() {
                    if n > 0 {
                        meta.track_number = Some(n);
                    }
                }
            }
            "music:release_date" if meta.release_date.is_none() => meta.release_date = Some(val),
            "music:song_count" => {
                if let Ok(n) = val.parse::<usize>() {
                    if n > 0 {
                        meta.song_count = Some(n);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(ref desc) = meta.description {
        let parts: Vec<String> = desc
            .split('·')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() >= 4 && parts[2].eq_ignore_ascii_case("song") {
            meta.album_from_description = Some(parts[1].clone());
            if meta.release_date.is_none()
                && parts[3].len() == 4
                && parts[3].chars().all(|c| c.is_ascii_digit())
            {
                meta.release_date = Some(parts[3].clone());
            }
        }
        for p in &parts {
            let p_lower = p.to_ascii_lowercase();
            if (p_lower.ends_with(" songs")
                || p_lower.ends_with(" song")
                || p_lower.ends_with(" items")
                || p_lower.ends_with(" item"))
                && meta.song_count.is_none()
            {
                if let Some(first_word) = p.split_whitespace().next() {
                    if let Ok(n) = first_word.parse::<usize>() {
                        if n > 0 {
                            meta.song_count = Some(n);
                        }
                    }
                }
            }
        }
        if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("playlist") && meta.owner.is_none() {
            meta.owner = Some(parts[1].clone());
        }
    }

    meta
}

fn extract_spotify_id_from_uri(uri: &str) -> String {
    uri.split(':').last().unwrap_or("").to_string()
}

fn spotify_uri_to_url(uri: &str) -> Option<String> {
    let parts: Vec<&str> = uri.split(':').collect();
    if parts.len() >= 3 && parts[0] == "spotify" && !parts[1].is_empty() && !parts[2].is_empty() {
        Some(format!("https://open.spotify.com/{}/{}", parts[1], parts[2]))
    } else {
        None
    }
}

fn pick_largest_artwork_url(entity: &Value) -> Option<String> {
    let mut best_url: Option<String> = None;
    let mut best_score: i64 = -1;

    let mut check_arr = |arr: Option<&Vec<Value>>| {
        if let Some(items) = arr {
            for item in items {
                let url = match item.get("url").and_then(|v| v.as_str()) {
                    Some(u) if !u.is_empty() && !is_generic_spotify_icon(u) => u,
                    _ => continue,
                };
                let score = item
                    .get("maxWidth")
                    .or_else(|| item.get("width"))
                    .or_else(|| item.get("height"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                if best_url.is_none() || score > best_score {
                    best_url = Some(url.to_string());
                    best_score = score;
                }
            }
        }
    };

    check_arr(
        entity
            .get("visualIdentity")
            .and_then(|v| v.get("image"))
            .and_then(|v| v.as_array()),
    );
    check_arr(
        entity
            .get("coverArt")
            .and_then(|v| v.get("sources"))
            .and_then(|v| v.as_array()),
    );
    check_arr(entity.get("images").and_then(|v| v.as_array()));

    best_url
}

pub fn build_media_metadata_from_entity(
    canonical_url: &str,
    id: &str,
    content_type: SpotifyContentType,
    entity: &Value,
    og_meta: Option<&SpotifyOpenGraphMeta>,
    source: &str,
) -> Result<MediaMetadata, String> {
    let raw_title = entity
        .get("title")
        .or_else(|| entity.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if raw_title.is_empty() {
        return Err("Spotify metadata payload omitted resource title.".to_string());
    }

    let artwork = pick_largest_artwork_url(entity)
        .or_else(|| og_meta.and_then(|m| m.image.clone()));
    let release_date = entity
        .get("releaseDate")
        .and_then(|v| v.get("isoString"))
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(10).collect::<String>())
        .or_else(|| og_meta.and_then(|m| m.release_date.clone()));
    let explicit = entity.get("isExplicit").and_then(|v| v.as_bool());
    let resolved_id = entity
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(id)
        .to_string();

    if content_type == SpotifyContentType::Track {
        let mut artists: Vec<String> = entity
            .get("artists")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        if artists.is_empty() {
            if let Some(sub) = entity.get("subtitle").and_then(|v| v.as_str()) {
                artists = split_spotify_artists(sub);
            }
        }

        let duration_sec = entity
            .get("duration")
            .and_then(|v| v.as_u64())
            .filter(|&ms| ms > 0)
            .map(|ms| (ms + 500) / 1000);
        let duration_string = duration_sec.map(format_duration);
        let album = og_meta.and_then(|m| m.album_from_description.clone());
        let uploader = if artists.is_empty() {
            None
        } else {
            Some(artists.join(", "))
        };
        let desc_parts: Vec<&str> = [
            uploader.as_deref(),
            album.as_deref(),
            release_date.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect();
        let description = if desc_parts.is_empty() {
            None
        } else {
            Some(desc_parts.join(" · "))
        };

        return Ok(MediaMetadata {
            url: canonical_url.to_string(),
            id: resolved_id,
            title: raw_title,
            uploader,
            duration: duration_sec,
            duration_string,
            thumbnail: artwork.clone(),
            description,
            formats: Vec::new(),
            subtitles: Vec::new(),
            automatic_subtitles: Vec::new(),
            is_playlist: false,
            playlist_count: None,
            extractor: "spotdl".to_string(),
            content_type: Some("track".to_string()),
            artists: if artists.is_empty() { None } else { Some(artists) },
            album,
            album_artwork: artwork,
            track_number: og_meta.and_then(|m| m.track_number),
            release_date,
            explicit,
            tracks: None,
            entries: None,
            total_tracks: None,
            owner: None,
            partial_tracks: None,
            metadata_source: Some(source.to_string()),
        });
    }

    let raw_track_list = entity
        .get("trackList")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut tracks = Vec::new();
    for (idx, t) in raw_track_list.iter().enumerate() {
        let t_title = match t.get("title").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        let dur_sec = t
            .get("duration")
            .and_then(|v| v.as_u64())
            .filter(|&ms| ms > 0)
            .map(|ms| (ms + 500) / 1000);
        let uri = t.get("uri").and_then(|v| v.as_str()).unwrap_or("");
        let item_id = if !uri.is_empty() {
            extract_spotify_id_from_uri(uri)
        } else {
            t.get("uid")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| (idx + 1).to_string())
        };
        let item_artists = t
            .get("subtitle")
            .and_then(|v| v.as_str())
            .map(split_spotify_artists)
            .unwrap_or_default();

        tracks.push(SpotifyTrackItem {
            id: item_id,
            title: t_title,
            artists: item_artists,
            album: if content_type == SpotifyContentType::Album {
                Some(raw_title.clone())
            } else {
                None
            },
            duration: dur_sec,
            duration_string: dur_sec.map(format_duration),
            track_number: Some((idx + 1) as u32),
            artwork: artwork.clone(),
            explicit: t.get("isExplicit").and_then(|v| v.as_bool()),
            url: if uri.is_empty() {
                None
            } else {
                spotify_uri_to_url(uri)
            },
        });
    }

    let sum_duration: u64 = tracks.iter().filter_map(|t| t.duration).sum();
    let total_duration = if sum_duration > 0 {
        Some(sum_duration)
    } else {
        None
    };

    match content_type {
        SpotifyContentType::Album => {
            let mut artists: Vec<String> = entity
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if artists.is_empty() {
                if let Some(sub) = entity.get("subtitle").and_then(|v| v.as_str()) {
                    artists = split_spotify_artists(sub);
                }
            }
            let reported = og_meta.and_then(|m| m.song_count).unwrap_or(0);
            let max_count = tracks.len().max(reported);
            let total_tracks = if max_count > 0 { Some(max_count) } else { None };
            let partial_tracks = total_tracks
                .filter(|&tot| !tracks.is_empty() && tracks.len() < tot)
                .map(|_| true);
            let uploader = if artists.is_empty() {
                None
            } else {
                Some(artists.join(", "))
            };
            let count_label = total_tracks.map(|n| format!("{} tracks", n));
            let desc_parts: Vec<&str> = [
                uploader.as_deref(),
                count_label.as_deref(),
                release_date.as_deref(),
            ]
            .into_iter()
            .flatten()
            .collect();
            let description = if desc_parts.is_empty() {
                None
            } else {
                Some(desc_parts.join(" · "))
            };

            Ok(MediaMetadata {
                url: canonical_url.to_string(),
                id: resolved_id,
                title: raw_title.clone(),
                uploader,
                duration: total_duration,
                duration_string: total_duration.map(format_duration),
                thumbnail: artwork.clone(),
                description,
                formats: Vec::new(),
                subtitles: Vec::new(),
                automatic_subtitles: Vec::new(),
                is_playlist: true,
                playlist_count: total_tracks,
                extractor: "spotdl".to_string(),
                content_type: Some("album".to_string()),
                artists: if artists.is_empty() { None } else { Some(artists) },
                album: Some(raw_title),
                album_artwork: artwork,
                track_number: None,
                release_date,
                explicit,
                tracks: Some(tracks),
                entries: None,
                total_tracks,
                owner: None,
                partial_tracks,
                metadata_source: Some(source.to_string()),
            })
        }
        SpotifyContentType::Playlist => {
            let owner = entity
                .get("subtitle")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    entity
                        .get("authors")
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.first())
                        .and_then(|a| a.get("name"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                })
                .or_else(|| og_meta.and_then(|m| m.owner.clone()));

            let reported = og_meta.and_then(|m| m.song_count).unwrap_or(0);
            let max_count = tracks.len().max(reported);
            let total_tracks = if max_count > 0 { Some(max_count) } else { None };
            let partial_tracks = total_tracks
                .filter(|&tot| !tracks.is_empty() && tracks.len() < tot)
                .map(|_| true);

            let owner_label = owner.as_ref().map(|o| format!("Curated by {}", o));
            let count_label = total_tracks.map(|n| format!("{} tracks", n));
            let desc_parts: Vec<&str> = [owner_label.as_deref(), count_label.as_deref()]
                .into_iter()
                .flatten()
                .collect();

            Ok(MediaMetadata {
                url: canonical_url.to_string(),
                id: resolved_id,
                title: raw_title,
                uploader: owner.clone(),
                duration: total_duration,
                duration_string: total_duration.map(format_duration),
                thumbnail: artwork.clone(),
                description: if desc_parts.is_empty() {
                    None
                } else {
                    Some(desc_parts.join(" · "))
                },
                formats: Vec::new(),
                subtitles: Vec::new(),
                automatic_subtitles: Vec::new(),
                is_playlist: true,
                playlist_count: total_tracks,
                extractor: "spotdl".to_string(),
                content_type: Some("playlist".to_string()),
                artists: None,
                album: None,
                album_artwork: artwork,
                track_number: None,
                release_date: None,
                explicit: None,
                tracks: Some(tracks),
                entries: None,
                total_tracks,
                owner,
                partial_tracks,
                metadata_source: Some(source.to_string()),
            })
        }
        SpotifyContentType::Artist => {
            let total_tracks = if tracks.is_empty() {
                None
            } else {
                Some(tracks.len())
            };
            let is_playlist = !tracks.is_empty();
            let description = og_meta
                .and_then(|m| m.description.clone())
                .or_else(|| total_tracks.map(|n| format!("{} top tracks", n)));

            Ok(MediaMetadata {
                url: canonical_url.to_string(),
                id: resolved_id,
                title: raw_title.clone(),
                uploader: Some(raw_title.clone()),
                duration: total_duration,
                duration_string: total_duration.map(format_duration),
                thumbnail: artwork.clone(),
                description,
                formats: Vec::new(),
                subtitles: Vec::new(),
                automatic_subtitles: Vec::new(),
                is_playlist,
                playlist_count: total_tracks,
                extractor: "spotdl".to_string(),
                content_type: Some("artist".to_string()),
                artists: Some(vec![raw_title]),
                album: None,
                album_artwork: artwork,
                track_number: None,
                release_date: None,
                explicit: None,
                tracks: Some(tracks),
                entries: None,
                total_tracks,
                owner: None,
                partial_tracks: None,
                metadata_source: Some(source.to_string()),
            })
        }
        SpotifyContentType::Track => unreachable!(),
    }
}

pub fn build_media_metadata_from_oembed(
    canonical_url: &str,
    id: &str,
    content_type: SpotifyContentType,
    oembed: &Value,
) -> Result<MediaMetadata, String> {
    let title = oembed
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Spotify oEmbed response did not include a title.".to_string())?;

    let thumbnail = oembed
        .get("thumbnail_url")
        .and_then(|v| v.as_str())
        .filter(|u| !u.is_empty() && !is_generic_spotify_icon(u))
        .map(|u| u.to_string());

    Ok(MediaMetadata {
        url: canonical_url.to_string(),
        id: id.to_string(),
        title,
        uploader: None,
        duration: None,
        duration_string: None,
        thumbnail: thumbnail.clone(),
        description: Some("Partial Spotify metadata retrieved via oEmbed fallback.".to_string()),
        formats: Vec::new(),
        subtitles: Vec::new(),
        automatic_subtitles: Vec::new(),
        is_playlist: matches!(
            content_type,
            SpotifyContentType::Album | SpotifyContentType::Playlist
        ),
        playlist_count: None,
        extractor: "spotdl".to_string(),
        content_type: Some(content_type.as_str().to_string()),
        artists: None,
        album: None,
        album_artwork: thumbnail,
        track_number: None,
        release_date: None,
        explicit: None,
        tracks: None,
        entries: None,
        total_tracks: None,
        owner: None,
        partial_tracks: Some(true),
        metadata_source: Some("spotify-oembed".to_string()),
    })
}

fn pick_web_api_image(images: Option<&Vec<Value>>) -> Option<String> {
    let items = images?;
    items
        .iter()
        .filter_map(|i| {
            let url = i.get("url").and_then(|v| v.as_str())?;
            if is_generic_spotify_icon(url) {
                return None;
            }
            let width = i.get("width").and_then(|v| v.as_u64()).unwrap_or(0);
            Some((width, url.to_string()))
        })
        .max_by_key(|(w, _)| *w)
        .map(|(_, url)| url)
}

pub fn build_media_metadata_from_web_api(
    canonical_url: &str,
    id: &str,
    content_type: SpotifyContentType,
    payload: &Value,
    extra_tracks: Option<&[Value]>,
) -> Result<MediaMetadata, String> {
    let title = payload
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Spotify Web API response omitted resource name.".to_string())?;
    let resolved_id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(id)
        .to_string();

    match content_type {
        SpotifyContentType::Track => {
            let artists: Vec<String> = payload
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let duration = payload
                .get("duration_ms")
                .and_then(|v| v.as_u64())
                .filter(|&ms| ms > 0)
                .map(|ms| (ms + 500) / 1000);
            let album_obj = payload.get("album");
            let artwork = pick_web_api_image(
                album_obj
                    .and_then(|a| a.get("images"))
                    .and_then(|v| v.as_array()),
            );
            let album = album_obj
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let release_date = album_obj
                .and_then(|a| a.get("release_date"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let uploader = if artists.is_empty() {
                None
            } else {
                Some(artists.join(", "))
            };
            let desc_parts: Vec<&str> = [
                uploader.as_deref(),
                album.as_deref(),
                release_date.as_deref(),
            ]
            .into_iter()
            .flatten()
            .collect();
            let description = if desc_parts.is_empty() {
                None
            } else {
                Some(desc_parts.join(" · "))
            };

            Ok(MediaMetadata {
                url: canonical_url.to_string(),
                id: resolved_id,
                title,
                uploader,
                duration,
                duration_string: duration.map(format_duration),
                thumbnail: artwork.clone(),
                description,
                formats: Vec::new(),
                subtitles: Vec::new(),
                automatic_subtitles: Vec::new(),
                is_playlist: false,
                playlist_count: None,
                extractor: "spotdl".to_string(),
                content_type: Some("track".to_string()),
                artists: if artists.is_empty() { None } else { Some(artists) },
                album,
                album_artwork: artwork,
                track_number: payload
                    .get("track_number")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32),
                release_date,
                explicit: payload.get("explicit").and_then(|v| v.as_bool()),
                tracks: None,
                entries: None,
                total_tracks: None,
                owner: None,
                partial_tracks: None,
                metadata_source: Some("spotify-web-api".to_string()),
            })
        }
        SpotifyContentType::Album => {
            let artists: Vec<String> = payload
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let artwork = pick_web_api_image(payload.get("images").and_then(|v| v.as_array()));
            let fallback_items = payload
                .get("tracks")
                .and_then(|t| t.get("items"))
                .and_then(|v| v.as_array())
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let items = extra_tracks.unwrap_or(fallback_items);

            let tracks: Vec<SpotifyTrackItem> = items
                .iter()
                .enumerate()
                .filter_map(|(idx, t)| {
                    let t_name = t.get("name").and_then(|v| v.as_str())?.trim().to_string();
                    if t_name.is_empty() {
                        return None;
                    }
                    let dur = t
                        .get("duration_ms")
                        .and_then(|v| v.as_u64())
                        .filter(|&ms| ms > 0)
                        .map(|ms| (ms + 500) / 1000);
                    let item_artists: Vec<String> = t
                        .get("artists")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect()
                        })
                        .filter(|v: &Vec<String>| !v.is_empty())
                        .unwrap_or_else(|| artists.clone());
                    let tid = t
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let url = t
                        .get("external_urls")
                        .and_then(|e| e.get("spotify"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| {
                            if tid.is_empty() {
                                None
                            } else {
                                Some(format!("https://open.spotify.com/track/{}", tid))
                            }
                        });
                    Some(SpotifyTrackItem {
                        id: if tid.is_empty() {
                            (idx + 1).to_string()
                        } else {
                            tid
                        },
                        title: t_name,
                        artists: item_artists,
                        album: Some(title.clone()),
                        duration: dur,
                        duration_string: dur.map(format_duration),
                        track_number: t
                            .get("track_number")
                            .and_then(|v| v.as_u64())
                            .map(|n| n as u32)
                            .or(Some((idx + 1) as u32)),
                        artwork: artwork.clone(),
                        explicit: t.get("explicit").and_then(|v| v.as_bool()),
                        url,
                    })
                })
                .collect();

            let total_tracks = payload
                .get("total_tracks")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .or_else(|| if tracks.is_empty() { None } else { Some(tracks.len()) });
            let sum_dur: u64 = tracks.iter().filter_map(|t| t.duration).sum();
            let duration = if sum_dur > 0 { Some(sum_dur) } else { None };
            let partial_tracks = total_tracks
                .filter(|&tot| tracks.len() < tot)
                .map(|_| true);
            let uploader = if artists.is_empty() {
                None
            } else {
                Some(artists.join(", "))
            };
            let release_date = payload
                .get("release_date")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            Ok(MediaMetadata {
                url: canonical_url.to_string(),
                id: resolved_id,
                title: title.clone(),
                uploader,
                duration,
                duration_string: duration.map(format_duration),
                thumbnail: artwork.clone(),
                description: None,
                formats: Vec::new(),
                subtitles: Vec::new(),
                automatic_subtitles: Vec::new(),
                is_playlist: true,
                playlist_count: total_tracks,
                extractor: "spotdl".to_string(),
                content_type: Some("album".to_string()),
                artists: if artists.is_empty() { None } else { Some(artists) },
                album: Some(title),
                album_artwork: artwork,
                track_number: None,
                release_date,
                explicit: None,
                tracks: Some(tracks),
                entries: None,
                total_tracks,
                owner: None,
                partial_tracks,
                metadata_source: Some("spotify-web-api".to_string()),
            })
        }
        SpotifyContentType::Playlist => {
            let owner = payload
                .get("owner")
                .and_then(|o| o.get("display_name").or_else(|| o.get("id")))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let artwork = pick_web_api_image(payload.get("images").and_then(|v| v.as_array()));
            let fallback_items = payload
                .get("tracks")
                .and_then(|t| t.get("items"))
                .and_then(|v| v.as_array())
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let items = extra_tracks.unwrap_or(fallback_items);

            let tracks: Vec<SpotifyTrackItem> = items
                .iter()
                .enumerate()
                .filter_map(|(idx, entry)| {
                    let t = entry.get("track").unwrap_or(entry);
                    let t_name = t.get("name").and_then(|v| v.as_str())?.trim().to_string();
                    if t_name.is_empty() {
                        return None;
                    }
                    let dur = t
                        .get("duration_ms")
                        .and_then(|v| v.as_u64())
                        .filter(|&ms| ms > 0)
                        .map(|ms| (ms + 500) / 1000);
                    let item_artists: Vec<String> = t
                        .get("artists")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    let tid = t
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let item_art = pick_web_api_image(
                        t.get("album")
                            .and_then(|a| a.get("images"))
                            .and_then(|v| v.as_array()),
                    )
                    .or_else(|| artwork.clone());
                    let url = t
                        .get("external_urls")
                        .and_then(|e| e.get("spotify"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| {
                            if tid.is_empty() {
                                None
                            } else {
                                Some(format!("https://open.spotify.com/track/{}", tid))
                            }
                        });
                    Some(SpotifyTrackItem {
                        id: if tid.is_empty() {
                            (idx + 1).to_string()
                        } else {
                            tid
                        },
                        title: t_name,
                        artists: item_artists,
                        album: t
                            .get("album")
                            .and_then(|a| a.get("name"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        duration: dur,
                        duration_string: dur.map(format_duration),
                        track_number: Some((idx + 1) as u32),
                        artwork: item_art,
                        explicit: t.get("explicit").and_then(|v| v.as_bool()),
                        url,
                    })
                })
                .collect();

            let total_tracks = payload
                .get("tracks")
                .and_then(|t| t.get("total"))
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .or_else(|| if tracks.is_empty() { None } else { Some(tracks.len()) });
            let sum_dur: u64 = tracks.iter().filter_map(|t| t.duration).sum();
            let duration = if sum_dur > 0 { Some(sum_dur) } else { None };
            let partial_tracks = total_tracks
                .filter(|&tot| tracks.len() < tot)
                .map(|_| true);

            Ok(MediaMetadata {
                url: canonical_url.to_string(),
                id: resolved_id,
                title,
                uploader: owner.clone(),
                duration,
                duration_string: duration.map(format_duration),
                thumbnail: artwork.clone(),
                description: None,
                formats: Vec::new(),
                subtitles: Vec::new(),
                automatic_subtitles: Vec::new(),
                is_playlist: true,
                playlist_count: total_tracks,
                extractor: "spotdl".to_string(),
                content_type: Some("playlist".to_string()),
                artists: None,
                album: None,
                album_artwork: artwork,
                track_number: None,
                release_date: None,
                explicit: None,
                tracks: Some(tracks),
                entries: None,
                total_tracks,
                owner,
                partial_tracks,
                metadata_source: Some("spotify-web-api".to_string()),
            })
        }
        SpotifyContentType::Artist => {
            let artwork = pick_web_api_image(payload.get("images").and_then(|v| v.as_array()));
            let items = extra_tracks.unwrap_or(&[]);
            let tracks: Vec<SpotifyTrackItem> = items
                .iter()
                .enumerate()
                .filter_map(|(idx, t)| {
                    let t_name = t.get("name").and_then(|v| v.as_str())?.trim().to_string();
                    if t_name.is_empty() {
                        return None;
                    }
                    let dur = t
                        .get("duration_ms")
                        .and_then(|v| v.as_u64())
                        .filter(|&ms| ms > 0)
                        .map(|ms| (ms + 500) / 1000);
                    let item_artists: Vec<String> = t
                        .get("artists")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect()
                        })
                        .filter(|v: &Vec<String>| !v.is_empty())
                        .unwrap_or_else(|| vec![title.clone()]);
                    let tid = t
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let url = t
                        .get("external_urls")
                        .and_then(|e| e.get("spotify"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| {
                            if tid.is_empty() {
                                None
                            } else {
                                Some(format!("https://open.spotify.com/track/{}", tid))
                            }
                        });
                    Some(SpotifyTrackItem {
                        id: if tid.is_empty() {
                            (idx + 1).to_string()
                        } else {
                            tid
                        },
                        title: t_name,
                        artists: item_artists,
                        album: t
                            .get("album")
                            .and_then(|a| a.get("name"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        duration: dur,
                        duration_string: dur.map(format_duration),
                        track_number: Some((idx + 1) as u32),
                        artwork: pick_web_api_image(
                            t.get("album")
                                .and_then(|a| a.get("images"))
                                .and_then(|v| v.as_array()),
                        )
                        .or_else(|| artwork.clone()),
                        explicit: t.get("explicit").and_then(|v| v.as_bool()),
                        url,
                    })
                })
                .collect();
            let total_tracks = if tracks.is_empty() {
                None
            } else {
                Some(tracks.len())
            };
            let sum_dur: u64 = tracks.iter().filter_map(|t| t.duration).sum();
            let duration = if sum_dur > 0 { Some(sum_dur) } else { None };

            Ok(MediaMetadata {
                url: canonical_url.to_string(),
                id: resolved_id,
                title: title.clone(),
                uploader: Some(title.clone()),
                duration,
                duration_string: duration.map(format_duration),
                thumbnail: artwork.clone(),
                description: total_tracks.map(|n| format!("{} top tracks", n)),
                formats: Vec::new(),
                subtitles: Vec::new(),
                automatic_subtitles: Vec::new(),
                is_playlist: !tracks.is_empty(),
                playlist_count: total_tracks,
                extractor: "spotdl".to_string(),
                content_type: Some("artist".to_string()),
                artists: Some(vec![title]),
                album: None,
                album_artwork: artwork,
                track_number: None,
                release_date: None,
                explicit: None,
                tracks: Some(tracks),
                entries: None,
                total_tracks,
                owner: None,
                partial_tracks: None,
                metadata_source: Some("spotify-web-api".to_string()),
            })
        }
    }
}

async fn run_cancellable<F, T>(
    fut: F,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<T, String>
where
    F: std::future::Future<Output = T>,
{
    let Some(flag) = cancel_flag else {
        return Ok(fut.await);
    };
    if flag.load(Ordering::SeqCst) {
        return Err("Inspection cancelled.".to_string());
    }

    tokio::pin!(fut);
    let mut interval = tokio::time::interval(Duration::from_millis(80));
    loop {
        tokio::select! {
            res = &mut fut => return Ok(res),
            _ = interval.tick() => {
                if flag.load(Ordering::SeqCst) {
                    return Err("Inspection cancelled.".to_string());
                }
            }
        }
    }
}

fn cache_get(key: &str, now: Instant, ttl: Duration) -> Option<MediaMetadata> {
    let mut guard = metadata_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|_, v| v.expires_at > now);
    if ttl.is_zero() {
        return None;
    }
    guard.get(key).map(|entry| entry.data.clone())
}

fn cache_put(key: &str, data: MediaMetadata, now: Instant, ttl: Duration) {
    if ttl.is_zero() {
        return;
    }
    let mut guard = metadata_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(
        key.to_string(),
        CacheEntry {
            expires_at: now + ttl,
            data,
        },
    );
}

pub fn clear_spotify_cache() {
    let mut guard = metadata_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.clear();
}

async fn resolve_short_link_async(
    client: &reqwest::Client,
    short_url: &str,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<String, String> {
    let no_redirect_client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed creating Spotify HTTP client: {}", e))?;

    let mut current = short_url.to_string();
    for _ in 0..6 {
        let resp = run_cancellable(
            no_redirect_client
                .get(&current)
                .header("User-Agent", BROWSER_USER_AGENT)
                .header("Accept-Language", "en-US,en;q=0.9")
                .send(),
            cancel_flag,
        )
        .await?
        .map_err(|e| format!("Failed resolving Spotify short link: {}", e))?;

        let status = resp.status();
        if status.is_redirection() {
            if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
                if let Ok(loc_str) = loc.to_str() {
                    let next_url = if loc_str.starts_with('/') {
                        format!("https://open.spotify.com{}", loc_str)
                    } else {
                        loc_str.to_string()
                    };
                    let lower = next_url.to_ascii_lowercase();
                    if !lower.starts_with("http://") && !lower.starts_with("https://") {
                        return Err(
                            "Spotify short link redirected to an unsupported URL scheme."
                                .to_string(),
                        );
                    }
                    current = next_url;
                    if let Some(ParsedSpotifyInput::Resource { canonical_url, .. }) =
                        try_parse_spotify_input(&current)
                    {
                        return Ok(canonical_url);
                    }
                    continue;
                }
            }
            break;
        }

        let final_url = resp.url().to_string();
        if let Some(ParsedSpotifyInput::Resource { canonical_url, .. }) =
            try_parse_spotify_input(&final_url)
        {
            return Ok(canonical_url);
        }
        break;
    }

    // Fallback: let standard client follow redirects if intermediate link needed cookies/GET follow
    let _ = client;
    match try_parse_spotify_input(&current) {
        Some(ParsedSpotifyInput::Resource { canonical_url, .. }) => Ok(canonical_url),
        Some(ParsedSpotifyInput::Invalid { error }) => Err(error),
        _ => Err(
            "Spotify short link could not be resolved to a track, album, playlist, or artist URL."
                .to_string(),
        ),
    }
}

async fn fetch_web_api_token(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Option<String> {
    let mut guard = token_cache().lock().await;
    if let Some(ref cached) = *guard {
        if cached.expires_at > Instant::now() + Duration::from_secs(15) {
            return Some(cached.token.clone());
        }
    }

    let resp = run_cancellable(
        client
            .post("https://accounts.spotify.com/api/token")
            .basic_auth(client_id, Some(client_secret))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body("grant_type=client_credentials")
            .send(),
        cancel_flag,
    )
    .await
    .ok()?
    .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let json: Value = resp.json().await.ok()?;
    let token = json.get("access_token")?.as_str()?.to_string();
    let expires_in = json.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    *guard = Some(WebApiToken {
        token: token.clone(),
        expires_at: Instant::now() + Duration::from_secs(expires_in),
    });
    Some(token)
}

async fn try_fetch_web_api_async(
    client: &reqwest::Client,
    content_type: SpotifyContentType,
    id: &str,
    canonical_url: &str,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<Option<MediaMetadata>, String> {
    let client_id = std::env::var("SPOTIFY_CLIENT_ID")
        .or_else(|_| std::env::var("VANTA_SPOTIFY_CLIENT_ID"))
        .unwrap_or_default();
    let client_secret = std::env::var("SPOTIFY_CLIENT_SECRET")
        .or_else(|_| std::env::var("VANTA_SPOTIFY_CLIENT_SECRET"))
        .unwrap_or_default();

    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Ok(None);
    }

    let Some(token) =
        fetch_web_api_token(client, client_id.trim(), client_secret.trim(), cancel_flag).await
    else {
        return Ok(None);
    };

    let endpoint = match content_type {
        SpotifyContentType::Track => format!("https://api.spotify.com/v1/tracks/{}", id),
        SpotifyContentType::Album => format!("https://api.spotify.com/v1/albums/{}", id),
        SpotifyContentType::Playlist => format!("https://api.spotify.com/v1/playlists/{}", id),
        SpotifyContentType::Artist => format!("https://api.spotify.com/v1/artists/{}", id),
    };

    let resp = run_cancellable(client.get(&endpoint).bearer_auth(&token).send(), cancel_flag)
        .await?
        .map_err(|e| format!("Spotify Web API network error: {}", e))?;

    if resp.status().as_u16() == 404 {
        return Err(format!(
            "Spotify {} not found, private, or unavailable (HTTP 404).",
            content_type.as_str()
        ));
    }
    if resp.status().as_u16() == 429 {
        return Err("Spotify API rate limit reached (HTTP 429). Please retry shortly.".to_string());
    }
    if !resp.status().is_success() {
        return Ok(None);
    }

    let payload: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let mut extra_tracks: Vec<Value> = Vec::new();
    let has_extra = match content_type {
        SpotifyContentType::Artist => {
            if let Ok(Ok(top_resp)) = run_cancellable(
                client
                    .get(format!(
                        "https://api.spotify.com/v1/artists/{}/top-tracks?market=US",
                        id
                    ))
                    .bearer_auth(&token)
                    .send(),
                cancel_flag,
            )
            .await
            {
                if top_resp.status().is_success() {
                    if let Ok(top_json) = top_resp.json::<Value>().await {
                        if let Some(arr) = top_json.get("tracks").and_then(|v| v.as_array()) {
                            extra_tracks = arr.clone();
                        }
                    }
                }
            }
            true
        }
        SpotifyContentType::Album | SpotifyContentType::Playlist => {
            if let Some(items) = payload
                .get("tracks")
                .and_then(|t| t.get("items"))
                .and_then(|v| v.as_array())
            {
                extra_tracks.extend(items.iter().cloned());
            }
            let mut next_url = payload
                .get("tracks")
                .and_then(|t| t.get("next"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            while let Some(url) = next_url {
                if extra_tracks.len() >= MAX_WEB_API_PLAYLIST_TRACKS {
                    break;
                }
                let Ok(Ok(page_resp)) =
                    run_cancellable(client.get(&url).bearer_auth(&token).send(), cancel_flag).await
                else {
                    break;
                };
                if !page_resp.status().is_success() {
                    break;
                }
                let Ok(page_json) = page_resp.json::<Value>().await else {
                    break;
                };
                let Some(arr) = page_json.get("items").and_then(|v| v.as_array()) else {
                    break;
                };
                if arr.is_empty() {
                    break;
                }
                extra_tracks.extend(arr.iter().cloned());
                next_url = page_json
                    .get("next")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            extra_tracks.truncate(MAX_WEB_API_PLAYLIST_TRACKS);
            true
        }
        SpotifyContentType::Track => false,
    };

    let meta = build_media_metadata_from_web_api(
        canonical_url,
        id,
        content_type,
        &payload,
        if has_extra {
            Some(&extra_tracks)
        } else {
            None
        },
    )?;
    Ok(Some(meta))
}

async fn fetch_public_endpoints_async(
    client: &reqwest::Client,
    content_type: SpotifyContentType,
    id: &str,
    canonical_url: &str,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<MediaMetadata, String> {
    let embed_url = format!(
        "https://open.spotify.com/embed/{}/{}",
        content_type.as_str(),
        id
    );

    let embed_fut = client
        .get(&embed_url)
        .header("User-Agent", BROWSER_USER_AGENT)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send();
    let og_fut = client
        .get(canonical_url)
        .header("User-Agent", CRAWLER_USER_AGENT)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send();

    let (embed_res, og_res) = run_cancellable(
        async { tokio::join!(embed_fut, og_fut) },
        cancel_flag,
    )
    .await?;

    let embed_resp = embed_res.map_err(|e| {
        if e.is_timeout() {
            format!(
                "Spotify metadata request timed out after {}s.",
                REQUEST_TIMEOUT.as_secs()
            )
        } else {
            format!("Unable to reach Spotify metadata service: {}", e)
        }
    })?;

    if embed_resp.status().as_u16() == 404 {
        return Err(format!(
            "Spotify {} not found, private, or unavailable (HTTP 404).",
            content_type.as_str()
        ));
    }
    if embed_resp.status().as_u16() == 429 {
        return Err(
            "Spotify metadata endpoint is temporarily rate-limited (HTTP 429). Please retry in a moment."
                .to_string(),
        );
    }

    let mut og_meta = SpotifyOpenGraphMeta::default();
    if let Ok(og_resp) = og_res {
        if og_resp.status().as_u16() == 404 {
            return Err(format!(
                "Spotify {} not found, private, or unavailable (HTTP 404).",
                content_type.as_str()
            ));
        }
        if og_resp.status().as_u16() == 429 {
            return Err(
                "Spotify metadata endpoint is temporarily rate-limited (HTTP 429). Please retry in a moment."
                    .to_string(),
            );
        }
        if og_resp.status().is_success() {
            if let Ok(html) = run_cancellable(og_resp.text(), cancel_flag).await? {
                og_meta = parse_spotify_opengraph_meta(&html);
            }
        }
    }

    let embed_status = embed_resp.status();
    if embed_status.is_success() {
        let embed_html = run_cancellable(embed_resp.text(), cancel_flag)
            .await?
            .map_err(|e| format!("Failed reading Spotify embed response: {}", e))?;
        if let Some(entity) = extract_spotify_next_data(&embed_html) {
            return build_media_metadata_from_entity(
                canonical_url,
                id,
                content_type,
                &entity,
                Some(&og_meta),
                "spotify-embed",
            );
        }
    }

    // Fallback to public Spotify oEmbed API (canonical_url is safe ASCII https://open.spotify.com/<type>/<id>)
    let encoded_url = canonical_url.replace(':', "%3A").replace('/', "%2F");
    let oembed_url = format!("https://open.spotify.com/oembed?url={}", encoded_url);
    let oembed_resp = run_cancellable(
        client
            .get(&oembed_url)
            .header("User-Agent", BROWSER_USER_AGENT)
            .send(),
        cancel_flag,
    )
    .await?
    .map_err(|e| format!("Failed querying Spotify oEmbed endpoint: {}", e))?;

    if oembed_resp.status().as_u16() == 404 {
        return Err(format!(
            "Spotify {} not found, private, or unavailable (HTTP 404).",
            content_type.as_str()
        ));
    }
    if oembed_resp.status().as_u16() == 429 {
        return Err(
            "Spotify metadata endpoint is temporarily rate-limited (HTTP 429). Please retry in a moment."
                .to_string(),
        );
    }
    if !oembed_resp.status().is_success() {
        return Err(format!(
            "Unable to retrieve Spotify metadata (embed HTTP {}, oEmbed HTTP {}).",
            embed_status.as_u16(),
            oembed_resp.status().as_u16()
        ));
    }

    let oembed_json: Value = run_cancellable(oembed_resp.json::<Value>(), cancel_flag)
        .await?
        .map_err(|e| format!("Malformed JSON from Spotify oEmbed: {}", e))?;

    build_media_metadata_from_oembed(canonical_url, id, content_type, &oembed_json)
}

pub async fn resolve_spotify_metadata_async(
    raw_url: &str,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<MediaMetadata, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed creating HTTP client: {}", e))?;

    let mut parsed = match try_parse_spotify_input(raw_url) {
        Some(p) => p,
        None => {
            return Err("URL is not a recognized Spotify resource URL or URI.".to_string());
        }
    };

    if let ParsedSpotifyInput::Invalid { error } = parsed {
        return Err(error);
    }

    if let ParsedSpotifyInput::ShortLink { url } = parsed {
        let resolved_url =
            resolve_short_link_async(&client, &url, cancel_flag.as_ref()).await?;
        parsed = match try_parse_spotify_input(&resolved_url) {
            Some(p) => p,
            None => {
                return Err(
                    "Resolved Spotify short link does not point to a supported Spotify resource."
                        .to_string(),
                )
            }
        };
        if let ParsedSpotifyInput::Invalid { error } = parsed {
            return Err(error);
        }
    }

    let (content_type, id, uri, canonical_url) = match parsed {
        ParsedSpotifyInput::Resource {
            content_type,
            id,
            uri,
            canonical_url,
        } => (content_type, id, uri, canonical_url),
        _ => {
            return Err("Unable to parse Spotify resource.".to_string());
        }
    };

    if let Some(cached) = cache_get(&uri, Instant::now(), CACHE_TTL) {
        return Ok(cached);
    }

    // Deduplicate concurrent identical requests while allowing caller cancellation
    let notify = {
        let mut map = inflight_map().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(&uri) {
            Some(Arc::clone(existing))
        } else {
            let n = Arc::new(Notify::new());
            map.insert(uri.clone(), n);
            None
        }
    };

    if let Some(existing_notify) = notify {
        run_cancellable(existing_notify.notified(), cancel_flag.as_ref()).await?;
        if let Some(cached) = cache_get(&uri, Instant::now(), CACHE_TTL) {
            return Ok(cached);
        }
        // Previous leader failed; fall through and perform a clean attempt
        let mut map = inflight_map().lock().unwrap_or_else(|e| e.into_inner());
        map.entry(uri.clone()).or_insert_with(|| Arc::new(Notify::new()));
    }

    struct InflightGuard {
        key: String,
    }
    impl Drop for InflightGuard {
        fn drop(&mut self) {
            let mut map = inflight_map().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(n) = map.remove(&self.key) {
                n.notify_waiters();
            }
        }
    }
    let _inflight_guard = InflightGuard { key: uri.clone() };

    let web_api_res = match try_fetch_web_api_async(
        &client,
        content_type,
        &id,
        &canonical_url,
        cancel_flag.as_ref(),
    )
    .await
    {
        Ok(Some(meta)) => Some(meta),
        Ok(None) => None,
        Err(e) => {
            let lower = e.to_ascii_lowercase();
            if lower.contains("404") || lower.contains("rate limit") || lower.contains("cancelled")
            {
                return Err(e);
            }
            None
        }
    };

    let metadata = match web_api_res {
        Some(m) => m,
        None => {
            fetch_public_endpoints_async(
                &client,
                content_type,
                &id,
                &canonical_url,
                cancel_flag.as_ref(),
            )
            .await?
        }
    };

    logging::info(
        "spotify",
        &format!(
            "Resolved {} -> \"{}\" (source={})",
            uri,
            metadata.title,
            metadata.metadata_source.as_deref().unwrap_or("unknown")
        ),
    );

    cache_put(&uri, metadata.clone(), Instant::now(), CACHE_TTL);
    Ok(metadata)
}

pub fn resolve_spotify_metadata_blocking(
    raw_url: &str,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<MediaMetadata, String> {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        return tokio::task::block_in_place(|| {
            handle.block_on(resolve_spotify_metadata_async(raw_url, cancel_flag))
        });
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Failed creating runtime for Spotify resolver: {}", e))?;
    rt.block_on(resolve_spotify_metadata_async(raw_url, cancel_flag))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_spotify_urls_and_uris() {
        assert_eq!(
            try_parse_spotify_input("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc"),
            Some(ParsedSpotifyInput::Resource {
                content_type: SpotifyContentType::Track,
                id: "4cOdK2wGLETKBW3PvgPWqT".to_string(),
                uri: "spotify:track:4cOdK2wGLETKBW3PvgPWqT".to_string(),
                canonical_url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT".to_string(),
            })
        );

        assert_eq!(
            try_parse_spotify_input("https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3?si=xyz"),
            Some(ParsedSpotifyInput::Resource {
                content_type: SpotifyContentType::Album,
                id: "1DFixLWuPkv3KT3TnV35m3".to_string(),
                uri: "spotify:album:1DFixLWuPkv3KT3TnV35m3".to_string(),
                canonical_url: "https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3".to_string(),
            })
        );

        assert_eq!(
            try_parse_spotify_input("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
            Some(ParsedSpotifyInput::Resource {
                content_type: SpotifyContentType::Playlist,
                id: "37i9dQZF1DXcBWIGoYBM5M".to_string(),
                uri: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M".to_string(),
                canonical_url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M".to_string(),
            })
        );

        assert_eq!(
            try_parse_spotify_input("spotify:artist:0gxyHStUsqpMadRV0Di1Qt"),
            Some(ParsedSpotifyInput::Resource {
                content_type: SpotifyContentType::Artist,
                id: "0gxyHStUsqpMadRV0Di1Qt".to_string(),
                uri: "spotify:artist:0gxyHStUsqpMadRV0Di1Qt".to_string(),
                canonical_url: "https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt".to_string(),
            })
        );

        assert_eq!(
            try_parse_spotify_input("https://spotify.link/abc123XYZ"),
            Some(ParsedSpotifyInput::ShortLink {
                url: "https://spotify.link/abc123XYZ".to_string(),
            })
        );

        assert_eq!(try_parse_spotify_input("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(try_parse_spotify_input("https://example.com/?ref=spotify.com"), None);

        assert!(matches!(
            try_parse_spotify_input("https://open.spotify.com/user/spotify"),
            Some(ParsedSpotifyInput::Invalid { .. })
        ));
        assert!(matches!(
            try_parse_spotify_input("https://open.spotify.com/track/"),
            Some(ParsedSpotifyInput::Invalid { .. })
        ));
    }

    #[test]
    fn test_embed_track_and_album_and_playlist_normalization_never_fabricated() {
        let track_html = r#"
        <html><head></head><body>
        <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"type":"track","id":"4cOdK2wGLETKBW3PvgPWqT","title":"Never Gonna Give You Up","artists":[{"name":"Rick Astley","uri":"spotify:artist:0gxyHStUsqpMadRV0Di1Qt"}],"duration":213573,"releaseDate":{"isoString":"1987-11-12T00:00:00Z"},"isExplicit":false,"visualIdentity":{"image":[{"url":"https://image-cdn-fa.spotifycdn.com/image/real-cover-640.jpg","maxWidth":640}]}}}}}}}</script>
        </body></html>"#;

        let og_html = r#"
        <meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987"/>
        <meta name="music:album:track" content="1"/>
        <meta name="music:release_date" content="1987-11-12"/>
        "#;

        let entity = extract_spotify_next_data(track_html).unwrap();
        let og = parse_spotify_opengraph_meta(og_html);
        let meta = build_media_metadata_from_entity(
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
            "4cOdK2wGLETKBW3PvgPWqT",
            SpotifyContentType::Track,
            &entity,
            Some(&og),
            "spotify-embed",
        )
        .unwrap();

        assert_eq!(meta.title, "Never Gonna Give You Up");
        assert_eq!(meta.uploader.as_deref(), Some("Rick Astley"));
        assert_eq!(meta.album.as_deref(), Some("Whenever You Need Somebody"));
        assert_eq!(meta.track_number, Some(1));
        assert_eq!(meta.duration, Some(214));
        assert_eq!(meta.duration_string.as_deref(), Some("03:34"));
        assert_eq!(meta.release_date.as_deref(), Some("1987-11-12"));
        assert_ne!(meta.title, "Spotify Music Track");
        assert_ne!(meta.uploader.as_deref(), Some("Spotify Artist"));
        assert!(!meta.thumbnail.as_deref().unwrap_or("").contains("favicon"));
        assert!(meta.entries.is_none());
    }

    #[test]
    fn test_spotify_album_playlist_artist_oembed_and_web_api_builders() {
        let album_entity = serde_json::json!({
            "id": "1DFixLWuPkv3KT3TnV35m3",
            "title": "Emotion",
            "artists": [{ "name": "Carly Rae Jepsen" }],
            "releaseDate": { "isoString": "2015-09-25T00:00:00Z" },
            "visualIdentity": { "image": [{ "url": "https://i.scdn.co/image/album640", "maxWidth": 640 }] },
            "trackList": [
                { "title": "Run Away with Me", "subtitle": "Carly Rae Jepsen", "duration": 251000, "uri": "spotify:track:aaa111222333" },
                { "title": "Emotion", "subtitle": "Carly Rae Jepsen", "duration": 197000, "uri": "spotify:track:bbb111222333" }
            ]
        });
        let album_meta = build_media_metadata_from_entity(
            "https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3",
            "1DFixLWuPkv3KT3TnV35m3",
            SpotifyContentType::Album,
            &album_entity,
            None,
            "spotify-embed",
        )
        .unwrap();
        assert_eq!(album_meta.content_type.as_deref(), Some("album"));
        assert_eq!(album_meta.total_tracks, Some(2));
        assert!(album_meta.entries.is_none());

        let playlist_entity = serde_json::json!({
            "id": "37i9dQZF1DXcBWIGoYBM5M",
            "title": "Today's Top Hits",
            "subtitle": "Spotify",
            "trackList": [
                { "title": "Track One", "subtitle": "Artist One", "duration": 180000, "uri": "spotify:track:track1234567890" }
            ]
        });
        let og_pl = SpotifyOpenGraphMeta {
            song_count: Some(50),
            ..SpotifyOpenGraphMeta::default()
        };
        let playlist_meta = build_media_metadata_from_entity(
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
            "37i9dQZF1DXcBWIGoYBM5M",
            SpotifyContentType::Playlist,
            &playlist_entity,
            Some(&og_pl),
            "spotify-embed",
        )
        .unwrap();
        assert_eq!(playlist_meta.owner.as_deref(), Some("Spotify"));
        assert_eq!(playlist_meta.partial_tracks, Some(true));

        let artist_entity = serde_json::json!({
            "id": "0gxyHStUsqpMadRV0Di1Qt",
            "title": "Rick Astley",
            "trackList": [
                { "title": "Never Gonna Give You Up", "subtitle": "Rick Astley", "duration": 213000, "uri": "spotify:track:4cOdK2wGLETKBW3PvgPWqT" }
            ]
        });
        let artist_meta = build_media_metadata_from_entity(
            "https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt",
            "0gxyHStUsqpMadRV0Di1Qt",
            SpotifyContentType::Artist,
            &artist_entity,
            None,
            "spotify-embed",
        )
        .unwrap();
        assert_eq!(artist_meta.content_type.as_deref(), Some("artist"));
        assert_eq!(artist_meta.tracks.as_ref().unwrap().len(), 1);

        let oembed_meta = build_media_metadata_from_oembed(
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
            "4cOdK2wGLETKBW3PvgPWqT",
            SpotifyContentType::Track,
            &serde_json::json!({
                "title": "Never Gonna Give You Up",
                "thumbnail_url": "https://open.spotifycdn.com/cdn/images/favicon.0f31d2ea.ico"
            }),
        )
        .unwrap();
        assert!(oembed_meta.thumbnail.is_none());
        assert_eq!(oembed_meta.partial_tracks, Some(true));

        let web_track = build_media_metadata_from_web_api(
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
            "4cOdK2wGLETKBW3PvgPWqT",
            SpotifyContentType::Track,
            &serde_json::json!({
                "id": "4cOdK2wGLETKBW3PvgPWqT",
                "name": "Never Gonna Give You Up",
                "duration_ms": 213573,
                "track_number": 1,
                "explicit": false,
                "artists": [{ "name": "Rick Astley" }],
                "album": {
                    "name": "Whenever You Need Somebody",
                    "release_date": "1987-11-12",
                    "images": [{ "url": "https://i.scdn.co/image/rick640", "width": 640 }]
                }
            }),
            None,
        )
        .unwrap();
        let serialized = serde_json::to_string(&web_track).unwrap();
        let roundtrip: MediaMetadata = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtrip, web_track);
    }

    #[test]
    fn test_cache_behavior() {
        clear_spotify_cache();
        let key = "spotify:track:testcache123456";
        let now = Instant::now();
        let mut meta = MediaMetadata::default();
        meta.id = "testcache123456".to_string();
        meta.title = "Real Track Title".to_string();

        assert!(cache_get(key, now, Duration::from_secs(60)).is_none());
        cache_put(key, meta.clone(), now, Duration::from_secs(60));
        assert_eq!(
            cache_get(key, now + Duration::from_secs(30), Duration::from_secs(60))
                .unwrap()
                .title,
            "Real Track Title"
        );
        assert!(cache_get(key, now + Duration::from_secs(61), Duration::from_secs(60)).is_none());
    }
}
