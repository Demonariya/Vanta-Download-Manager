use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Inspecting,
    Ready,
    #[serde(alias = "extracting")]
    Connecting,
    Downloading,
    Pausing,
    Paused,
    Resuming,
    Processing,
    Muxing,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Queued => "queued",
            TaskStatus::Inspecting => "inspecting",
            TaskStatus::Ready => "ready",
            TaskStatus::Connecting => "connecting",
            TaskStatus::Downloading => "downloading",
            TaskStatus::Pausing => "pausing",
            TaskStatus::Paused => "paused",
            TaskStatus::Resuming => "resuming",
            TaskStatus::Processing => "processing",
            TaskStatus::Muxing => "muxing",
            TaskStatus::Verifying => "verifying",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "inspecting" => TaskStatus::Inspecting,
            "ready" => TaskStatus::Ready,
            "connecting" | "extracting" => TaskStatus::Connecting,
            "downloading" => TaskStatus::Downloading,
            "pausing" => TaskStatus::Pausing,
            "paused" => TaskStatus::Paused,
            "resuming" => TaskStatus::Resuming,
            "processing" => TaskStatus::Processing,
            "muxing" => TaskStatus::Muxing,
            "verifying" => TaskStatus::Verifying,
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            _ => TaskStatus::Queued,
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            TaskStatus::Inspecting
                | TaskStatus::Connecting
                | TaskStatus::Downloading
                | TaskStatus::Pausing
                | TaskStatus::Resuming
                | TaskStatus::Processing
                | TaskStatus::Muxing
                | TaskStatus::Verifying
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskPriority {
    Highest,
    High,
    Normal,
    Low,
}

impl TaskPriority {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskPriority::Highest => "highest",
            TaskPriority::High => "high",
            TaskPriority::Normal => "normal",
            TaskPriority::Low => "low",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "highest" => TaskPriority::Highest,
            "high" => TaskPriority::High,
            "low" => TaskPriority::Low,
            _ => TaskPriority::Normal,
        }
    }

    pub fn order_rank(&self) -> u32 {
        match self {
            TaskPriority::Highest => 0,
            TaskPriority::High => 1,
            TaskPriority::Normal => 2,
            TaskPriority::Low => 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SchedulerSettings {
    pub enabled: bool,
    pub start_time: String,
    pub stop_time: String,
    pub pause_on_stop: bool,
    pub days: Vec<u32>,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            start_time: "00:00".to_string(),
            stop_time: "00:00".to_string(),
            pause_on_stop: true,
            days: vec![0, 1, 2, 3, 4, 5, 6],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<u64>,
    pub duration_string: Option<String>,
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    pub engine: String,
    pub status: TaskStatus,
    pub progress_percentage: f64,
    #[serde(default = "default_true")]
    pub percentage_known: bool,
    pub speed_str: String,
    pub speed_bytes_per_sec: f64,
    #[serde(default)]
    pub avg_speed_bytes_per_sec: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    #[serde(default)]
    pub remaining_bytes: u64,
    pub eta_str: String,
    #[serde(default)]
    pub eta_seconds: Option<u64>,
    #[serde(default)]
    pub elapsed_seconds: u64,
    #[serde(default)]
    pub active_connections: u32,
    #[serde(default)]
    pub last_progress_at: Option<String>,
    pub current_phase: String,
    pub format_id: String,
    pub format_note: Option<String>,
    #[serde(default)]
    pub subtitle_languages: Vec<String>,
    #[serde(default)]
    pub write_auto_subtitles: bool,
    #[serde(default)]
    pub lyrics_lrc_content: Option<String>,
    pub ext: String,
    #[serde(default)]
    pub video_codec: Option<String>,
    #[serde(default)]
    pub audio_codec: Option<String>,
    #[serde(default)]
    pub resolution_label: Option<String>,
    pub is_audio_only: bool,
    pub audio_format: Option<String>,
    pub audio_bitrate: Option<String>,
    pub audio_sample_rate: Option<u32>,
    pub audio_bit_depth: Option<u32>,
    pub audio_channels: Option<u32>,
    pub is_lossy_source: Option<bool>,
    pub verified_audio_info: Option<String>,
    pub output_path: String,
    #[serde(default)]
    pub custom_filename: Option<String>,
    #[serde(default)]
    pub playlist_mode: Option<String>,
    #[serde(default)]
    pub selected_items: Option<Vec<String>>,
    #[serde(default)]
    pub tracks_requested: Option<u32>,
    #[serde(default)]
    pub tracks_completed: Option<u32>,
    #[serde(default)]
    pub tracks_failed: Option<u32>,
    pub error_message: Option<String>,
    #[serde(default)]
    pub logs: Vec<TaskLogEntry>,
    pub priority: TaskPriority,
    #[serde(default)]
    pub queue_order: i64,
    #[serde(default = "default_queue_id")]
    pub queue_id: String,
    pub created_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub retries: u32,
    pub max_retries: u32,
}

fn default_true() -> bool {
    true
}

fn default_queue_id() -> String {
    "main".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskPayload {
    pub url: String,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<u64>,
    pub duration_string: Option<String>,
    pub thumbnail: Option<String>,
    pub album: Option<String>,
    pub content_type: Option<String>,
    pub format_id: Option<String>,
    pub format_note: Option<String>,
    pub subtitle_languages: Option<Vec<String>>,
    pub write_auto_subtitles: Option<bool>,
    pub lyrics_lrc_content: Option<String>,
    pub ext: Option<String>,
    pub is_audio_only: Option<bool>,
    pub audio_format: Option<String>,
    pub audio_bitrate: Option<String>,
    pub audio_sample_rate: Option<u32>,
    pub audio_bit_depth: Option<u32>,
    pub audio_channels: Option<u32>,
    pub is_lossy_source: Option<bool>,
    pub output_path: Option<String>,
    pub priority: Option<TaskPriority>,
    pub custom_filename: Option<String>,
    pub playlist_mode: Option<String>,
    pub selected_items: Option<Vec<String>>,
    #[serde(default)]
    pub queue_id: Option<String>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SubtitleLanguage {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormatOption {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    pub format_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tbr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abr: Option<f64>,
    pub is_audio_only: bool,
    pub is_video_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpotifyTrackItem {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_string: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_number: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaylistEntry {
    pub id: String,
    pub index: usize,
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_string: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MediaMetadata {
    pub url: String,
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<u64>,
    pub duration_string: Option<String>,
    pub thumbnail: Option<String>,
    pub description: Option<String>,
    pub formats: Vec<FormatOption>,
    #[serde(default)]
    pub subtitles: Vec<SubtitleLanguage>,
    #[serde(default)]
    pub automatic_subtitles: Vec<SubtitleLanguage>,
    pub is_playlist: bool,
    pub playlist_count: Option<usize>,
    pub extractor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artists: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_artwork: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_number: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<SpotifyTrackItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<PlaylistEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tracks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_tracks: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub available: bool,
    pub version: String,
    pub path: String,
    pub status: String,
    pub last_checked: String,
    pub error: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: Option<bool>,
    pub is_updating: Option<bool>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatusMap {
    pub ytdlp: EngineInfo,
    pub spotdl: EngineInfo,
    pub ffmpeg: EngineInfo,
    pub ffprobe: EngineInfo,
    pub python3: EngineInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineUpdateResult {
    pub engine: String,
    pub success: bool,
    pub previous_version: String,
    pub current_version: String,
    pub message: String,
    pub rolled_back: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallProgress {
    pub engine: String,
    pub status: String,
    pub phase: String,
    pub progress_percentage: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub message: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedEngineInfo {
    pub install_root: String,
    pub install_dir: String,
    pub ytdlp_dir: String,
    pub spotdl_dir: String,
    pub ffmpeg_dir: String,
    pub manifest_path: String,
    pub settings_file_path: String,
    pub is_writable: bool,
    pub requires_elevation: bool,
    pub required_ready: bool,
    pub missing_required: Vec<String>,
    pub engines: EngineStatusMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonValidationResult {
    pub valid: bool,
    pub executable_path: String,
    pub version: Option<String>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticResult {
    pub engine: String,
    pub passed: bool,
    pub version: Option<String>,
    pub command: String,
    pub output: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogInfo {
    pub log_dir: String,
    pub log_path: String,
    pub exists: bool,
    pub file_size_bytes: u64,
    pub recent_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieValidationResult {
    pub valid: bool,
    pub record_count: usize,
    pub domain_count: usize,
    pub http_only_count: usize,
    pub secure_count: usize,
    pub has_netscape_header: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBrowserInfo {
    pub id: String,
    pub label: String,
    pub detected: bool,
    pub profiles: Vec<String>,
    pub default_profile: Option<String>,
    pub has_cookie_store: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieStatus {
    pub active_source: String,
    pub configured_browser: String,
    pub configured_profile: Option<String>,
    pub resolved_browser: Option<String>,
    pub resolved_profile: Option<String>,
    pub file_configured: bool,
    pub file_exists: bool,
    pub file_path: String,
    pub file_valid: bool,
    pub record_count: usize,
    pub domain_count: usize,
    pub http_only_count: usize,
    pub secure_count: usize,
    pub updated_at: Option<String>,
    pub error: Option<String>,
    pub detected_browsers: Vec<DetectedBrowserInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieTestResult {
    pub success: bool,
    pub stage: String,
    pub active_source: String,
    pub browser: String,
    pub resolved_browser: Option<String>,
    pub resolved_profile: Option<String>,
    pub browser_detected: bool,
    pub profile_located: bool,
    pub database_accessible: bool,
    pub extraction_succeeded: bool,
    pub auth_verified: Option<bool>,
    pub record_count: usize,
    pub message: String,
    pub next_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NotificationItem {
    pub id: String,
    pub r#type: String,
    pub title: String,
    pub message: String,
    pub timestamp: String,
    #[serde(rename = "taskId", alias = "task_id")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DownloadQueue {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_paused: bool,
    pub queue_order: i64,
    /// Zero inherits the application's global concurrent-download limit.
    #[serde(default)]
    pub max_concurrent_downloads: u32,
    /// Zero inherits the application's global bandwidth policy.
    #[serde(default)]
    pub bandwidth_limit_kbps: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    pub schema_version: u32,
    pub download_dir: String,
    pub python_path: Option<String>,
    pub max_concurrent_downloads: u32,
    pub fragment_concurrency: u32,
    pub global_bandwidth_limit_kbps: u64,
    pub per_task_bandwidth_limit_kbps: u64,
    pub max_retries: u32,
    pub retry_delay_seconds: u32,
    pub default_video_format: String,
    pub default_audio_format: String,
    pub default_audio_bitrate: String,
    pub default_audio_bit_depth: Option<u32>,
    pub default_audio_sample_rate: Option<u32>,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub filename_template: String,
    pub proxy_url: String,
    pub auto_dismiss_seconds: u32,
    pub theme: String,
    pub auto_retry_failed: bool,
    pub auto_resume_on_startup: bool,
    pub launch_on_startup: bool,
    pub start_minimized: bool,
    pub clipboard_monitoring: bool,
    pub conflict_strategy: String,
    pub verify_media_on_complete: bool,
    pub verify_fragments: bool,
    pub tray_minimize_on_close: bool,
    pub scheduler: SchedulerSettings,
    pub cookies_browser: Option<String>,
    pub cookies_profile: Option<String>,
    pub cookies_file: Option<String>,
    pub user_agent: Option<String>,
}


impl Default for AppSettings {
    fn default() -> Self {
        let default_download_dir = default_downloads_path()
            .to_string_lossy()
            .to_string();

        Self {
            schema_version: 1,
            download_dir: default_download_dir,
            python_path: None,
            max_concurrent_downloads: 3,
            fragment_concurrency: 3,
            global_bandwidth_limit_kbps: 0,
            per_task_bandwidth_limit_kbps: 0,
            max_retries: 3,
            retry_delay_seconds: 5,
            default_video_format: "best".to_string(),
            default_audio_format: "mp3".to_string(),
            default_audio_bitrate: "320k".to_string(),
            default_audio_bit_depth: Some(24),
            default_audio_sample_rate: Some(48000),
            embed_thumbnail: true,
            embed_metadata: true,
            filename_template: "%(title)s [%(id)s].%(ext)s".to_string(),
            proxy_url: "".to_string(),
            auto_dismiss_seconds: 5,
            theme: "dark".to_string(),
            auto_retry_failed: true,
            auto_resume_on_startup: true,
            launch_on_startup: false,
            start_minimized: false,
            clipboard_monitoring: false,
            conflict_strategy: "rename".to_string(),
            verify_media_on_complete: true,
            verify_fragments: true,
            tray_minimize_on_close: true,
            scheduler: SchedulerSettings::default(),
            cookies_browser: Some("auto".to_string()),
            cookies_profile: None,
            cookies_file: None,
            user_agent: Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".to_string()),
        }
    }
}

pub fn default_downloads_path() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let dl = std::path::PathBuf::from(profile).join("Downloads").join("VANTA");
            return dl;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let dl = std::path::PathBuf::from(home).join("Downloads").join("VANTA");
        return dl;
    }
    std::path::PathBuf::from("./downloads")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_fragment_concurrency_matches_engine_limit() {
        assert_eq!(AppSettings::default().fragment_concurrency, 3);
    }

    #[test]
    fn test_media_metadata_video_audio_formats_and_entries_roundtrip() {
        let playlist = MediaMetadata {
            url: "https://www.youtube.com/playlist?list=PL123".to_string(),
            id: "PL123".to_string(),
            title: "Sample Playlist".to_string(),
            uploader: Some("Channel".to_string()),
            formats: vec![
                FormatOption {
                    format_id: "137".to_string(),
                    ext: "mp4".to_string(),
                    resolution: Some("1920x1080".to_string()),
                    width: Some(1920),
                    height: Some(1080),
                    fps: Some(60.0),
                    vcodec: Some("avc1.640028".to_string()),
                    acodec: Some("none".to_string()),
                    filesize: Some(50_000_000),
                    filesize_approx: None,
                    format_note: Some("1080p60".to_string()),
                    tbr: Some(4200.5),
                    abr: None,
                    is_audio_only: false,
                    is_video_only: true,
                },
                FormatOption {
                    format_id: "251".to_string(),
                    ext: "webm".to_string(),
                    resolution: Some("audio only".to_string()),
                    width: None,
                    height: None,
                    fps: None,
                    vcodec: Some("none".to_string()),
                    acodec: Some("opus".to_string()),
                    filesize: None,
                    filesize_approx: Some(3_500_000),
                    format_note: Some("medium".to_string()),
                    tbr: Some(135.2),
                    abr: Some(128.0),
                    is_audio_only: true,
                    is_video_only: false,
                },
            ],
            is_playlist: true,
            playlist_count: Some(1),
            extractor: "youtube".to_string(),
            entries: Some(vec![PlaylistEntry {
                id: "vid1".to_string(),
                index: 1,
                title: "First Episode".to_string(),
                url: "https://www.youtube.com/watch?v=vid1".to_string(),
                duration: Some(125),
                duration_string: Some("02:05".to_string()),
                uploader: Some("Channel".to_string()),
                thumbnail: None,
            }]),
            ..MediaMetadata::default()
        };

        let json_str = serde_json::to_string(&playlist).unwrap();
        let parsed: MediaMetadata = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed, playlist);
        assert_eq!(parsed.formats[0].tbr, Some(4200.5));
        assert_eq!(parsed.formats[1].abr, Some(128.0));
        assert_eq!(parsed.entries.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_media_metadata_missing_optional_fields_deserialize_cleanly() {
        let minimal_json = r#"{
            "url": "https://example.com/video",
            "id": "v1",
            "title": "Minimal",
            "uploader": null,
            "duration": null,
            "duration_string": null,
            "thumbnail": null,
            "description": null,
            "formats": [],
            "is_playlist": false,
            "playlist_count": null,
            "extractor": "generic"
        }"#;
        let parsed: MediaMetadata = serde_json::from_str(minimal_json).unwrap();
        assert_eq!(parsed.title, "Minimal");
        assert!(parsed.entries.is_none());
    }

    #[test]
    fn test_app_settings_defaults_include_schema_version_and_python_path() {
        let partial = r#"{"download_dir": "D:\\Media", "max_concurrent_downloads": 5}"#;
        let parsed: AppSettings = serde_json::from_str(partial).unwrap();
        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.download_dir, "D:\\Media");
        assert_eq!(parsed.max_concurrent_downloads, 5);
        assert!(parsed.python_path.is_none());
    }

    #[test]
    fn test_notification_item_and_engine_update_info_casing() {
        let notif = NotificationItem {
            id: "n1".to_string(),
            r#type: "success".to_string(),
            title: "Done".to_string(),
            message: "Saved".to_string(),
            timestamp: "2026-11-20T00:00:00Z".to_string(),
            task_id: Some("task_123".to_string()),
        };
        let notif_json = serde_json::to_value(&notif).unwrap();
        assert_eq!(notif_json["taskId"], "task_123");
        assert!(notif_json.get("task_id").is_none());

        let from_legacy: NotificationItem = serde_json::from_str(
            r#"{"id":"n2","type":"info","title":"T","message":"M","timestamp":"ts","task_id":"t2"}"#,
        )
        .unwrap();
        assert_eq!(from_legacy.task_id.as_deref(), Some("t2"));

        let update = EngineUpdateInfo {
            current_version: "2026.01.01".to_string(),
            latest_version: "2026.01.02".to_string(),
            update_available: true,
        };
        let update_json = serde_json::to_value(&update).unwrap();
        assert_eq!(update_json["currentVersion"], "2026.01.01");
        assert_eq!(update_json["latestVersion"], "2026.01.02");
        assert_eq!(update_json["updateAvailable"], true);
    }

    #[test]
    fn legacy_download_queue_json_defaults_new_limits_to_inherit() {
        let queue: DownloadQueue = serde_json::from_str(
            r#"{"id":"main","name":"Main Queue","is_default":true,"is_paused":false,"queue_order":0}"#,
        ).unwrap();
        assert_eq!(queue.max_concurrent_downloads, 0);
        assert_eq!(queue.bandwidth_limit_kbps, 0);
    }

    #[test]
    fn test_scheduler_settings_defaults() {
        let sched = SchedulerSettings::default();
        assert!(!sched.enabled);
        assert_eq!(sched.start_time, "00:00");
        assert_eq!(sched.stop_time, "00:00");
        assert!(sched.pause_on_stop);
        assert_eq!(sched.days, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn test_scheduler_settings_json_roundtrip_and_partial_deserialization() {
        let custom = SchedulerSettings {
            enabled: true,
            start_time: "22:15".to_string(),
            stop_time: "05:30".to_string(),
            pause_on_stop: false,
            days: vec![1, 2, 3, 4, 5],
        };
        let encoded = serde_json::to_string(&custom).unwrap();
        let decoded: SchedulerSettings = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, custom);

        // Partial JSON fills omitted fields from SchedulerSettings::default()
        let partial: SchedulerSettings =
            serde_json::from_str(r#"{"enabled": true, "start_time": "03:00"}"#).unwrap();
        assert!(partial.enabled);
        assert_eq!(partial.start_time, "03:00");
        assert_eq!(partial.stop_time, "00:00");
        assert!(partial.pause_on_stop);
        assert_eq!(partial.days, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn test_scheduler_settings_equality_and_inequality() {
        let a = SchedulerSettings::default();
        let b = SchedulerSettings::default();
        assert_eq!(a, b);

        let diff_enabled = SchedulerSettings {
            enabled: true,
            ..SchedulerSettings::default()
        };
        assert_ne!(a, diff_enabled);

        let diff_days = SchedulerSettings {
            days: vec![1, 3, 5],
            ..SchedulerSettings::default()
        };
        assert_ne!(a, diff_days);
    }

    #[test]
    fn test_app_settings_scheduler_fallback_and_preservation() {
        // Legacy JSON without a scheduler block defaults cleanly
        let legacy: AppSettings = serde_json::from_str(r#"{"theme": "dark"}"#).unwrap();
        assert_eq!(legacy.scheduler, SchedulerSettings::default());

        // Custom scheduler embedded inside AppSettings survives roundtrip
        let mut custom = AppSettings::default();
        custom.scheduler = SchedulerSettings {
            enabled: true,
            start_time: "00:30".to_string(),
            stop_time: "04:45".to_string(),
            pause_on_stop: false,
            days: vec![0, 6],
        };
        let serialized = serde_json::to_string(&custom).unwrap();
        let roundtripped: AppSettings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtripped.scheduler, custom.scheduler);
    }
}
