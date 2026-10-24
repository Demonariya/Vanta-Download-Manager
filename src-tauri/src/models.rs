use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Extracting,
    Downloading,
    Processing,
    Completed,
    Paused,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskPriority {
    Highest,
    High,
    Normal,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum EngineType {
    YtDlp,
    Spotdl,
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
pub struct EngineInfo {
    pub available: bool,
    pub version: String,
    pub path: String,
    pub status: String,
    pub last_checked: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
