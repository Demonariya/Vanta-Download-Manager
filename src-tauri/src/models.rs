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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryItem {
    pub id: String,
    pub name: String,
    pub color: String,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub destination_dir: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
            start_time: "01:00".to_string(),
            stop_time: "06:00".to_string(),
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
    #[serde(default)]
    pub verified_sha256: Option<String>,
    #[serde(default)]
    pub expected_sha256: Option<String>,
    #[serde(default)]
    pub checksum_verified: Option<bool>,
    pub output_path: String,
    #[serde(default)]
    pub custom_filename: Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub playlist_mode: Option<String>,
    pub error_message: Option<String>,
    #[serde(default)]
    pub logs: Vec<TaskLogEntry>,
    pub priority: TaskPriority,
    #[serde(default)]
    pub queue_order: i64,
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
    pub category_id: Option<String>,
    pub playlist_mode: Option<String>,
    pub expected_sha256: Option<String>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_direct_file: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepts_ranges: Option<bool>,
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
    pub install_dir: String,
    pub manifest_path: String,
    pub required_ready: bool,
    pub missing_required: Vec<String>,
    pub engines: EngineStatusMap,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationItem {
    pub id: String,
    pub r#type: String,
    pub title: String,
    pub message: String,
    pub timestamp: String,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub download_dir: String,
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
    pub floating_notifications_enabled: bool,
    pub floating_widget_enabled: bool,
    pub auto_dismiss_seconds: u32,
    pub theme: String,
    pub auto_retry_failed: bool,
    pub auto_resume_on_startup: bool,
    pub clipboard_monitoring: bool,
    pub conflict_strategy: String,
    pub verify_media_on_complete: bool,
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
            download_dir: default_download_dir,
            max_concurrent_downloads: 3,
            fragment_concurrency: 4,
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
            floating_notifications_enabled: true,
            floating_widget_enabled: true,
            auto_dismiss_seconds: 5,
            theme: "dark".to_string(),
            auto_retry_failed: true,
            auto_resume_on_startup: true,
            clipboard_monitoring: false,
            conflict_strategy: "rename".to_string(),
            verify_media_on_complete: true,
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
