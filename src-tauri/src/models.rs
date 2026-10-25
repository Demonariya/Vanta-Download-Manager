use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Extracting,
    Downloading,
    Processing,
    Completed,
    Paused,
    Retrying,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskPriority {
    Highest,
    High,
    Normal,
    Low,
}

impl Default for TaskPriority {
    fn default() -> Self { Self::Normal }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum EngineType {
    #[serde(rename = "yt-dlp")]
    YtDlp,
    #[serde(rename = "spotdl")]
    Spotdl,
    #[serde(rename = "ffmpeg")]
    Ffmpeg,
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
    pub engine: EngineType,
    pub status: TaskStatus,
    pub progress_percentage: f64,
    pub speed_str: String,
    pub speed_bytes_per_sec: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub eta_str: String,
    pub current_phase: String,
    pub format_id: String,
    pub format_note: Option<String>,
    pub ext: String,
    pub is_audio_only: bool,
    pub audio_format: Option<String>,
    pub audio_bitrate: Option<String>,
    pub audio_sample_rate: Option<u32>,
    pub audio_bit_depth: Option<u32>,
    pub audio_channels: Option<u32>,
    pub is_lossy_source: Option<bool>,
    pub verified_audio_info: Option<String>,
    pub output_path: String,
    pub error_message: Option<String>,
    pub priority: TaskPriority,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub retries: u32,
    pub max_retries: u32,
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
    pub tbr: Option<f64>,
    pub abr: Option<f64>,
    pub format_note: Option<String>,
    pub is_audio_only: bool,
    pub is_video_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct NotificationItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
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
    pub auto_dismiss_seconds: u32,
    pub theme: String,
    pub auto_retry_failed: bool,
    pub auto_resume_on_startup: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            download_dir: String::new(),
            max_concurrent_downloads: 3,
            fragment_concurrency: 4,
            global_bandwidth_limit_kbps: 0,
            per_task_bandwidth_limit_kbps: 0,
            max_retries: 3,
            retry_delay_seconds: 5,
            default_video_format: "best".into(),
            default_audio_format: "mp3".into(),
            default_audio_bitrate: "320k".into(),
            default_audio_bit_depth: Some(24),
            default_audio_sample_rate: Some(48_000),
            embed_thumbnail: true,
            embed_metadata: true,
            filename_template: "%(title)s [%(id)s].%(ext)s".into(),
            proxy_url: String::new(),
            floating_notifications_enabled: true,
            auto_dismiss_seconds: 5,
            theme: "dark".into(),
            auto_retry_failed: true,
            auto_resume_on_startup: true,
        }
    }
}
