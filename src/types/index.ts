export type TaskStatus =
  | 'queued'
  | 'extracting'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'highest' | 'high' | 'normal' | 'low';

export type EngineType = 'yt-dlp' | 'spotdl' | 'ffmpeg';

export interface FormatOption {
  format_id: string;
  ext: string;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  tbr?: number;
  abr?: number;
  format_note?: string;
  is_audio_only: boolean;
  is_video_only: boolean;
}

export interface MediaMetadata {
  url: string;
  id: string;
  title: string;
  uploader?: string;
  duration?: number;
  duration_string?: string;
  thumbnail?: string;
  description?: string;
  formats: FormatOption[];
  is_playlist: boolean;
  playlist_count?: number;
  extractor: string;
}

export interface DownloadTask {
  id: string;
  url: string;
  title: string;
  uploader?: string;
  duration?: number;
  duration_string?: string;
  thumbnail?: string;
  engine: EngineType;
  status: TaskStatus;
  progress_percentage: number;
  speed_str: string;
  speed_bytes_per_sec: number;
  downloaded_bytes: number;
  total_bytes: number;
  eta_str: string;
  current_phase: string;
  format_id: string;
  format_note?: string;
  ext: string;
  is_audio_only: boolean;
  audio_format?: string;
  audio_bitrate?: string;
  audio_sample_rate?: number;
  audio_bit_depth?: number;
  audio_channels?: number;
  is_lossy_source?: boolean;
  verified_audio_info?: string;
  output_path: string;
  error_message?: string;
  priority: TaskPriority;
  created_at: string;
  completed_at?: string;
  retries: number;
  max_retries: number;
}

export interface EngineInfo {
  available: boolean;
  version: string;
  path: string;
  status: 'ready' | 'missing' | 'error';
  lastChecked: string;
  error?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  isUpdating?: boolean;
}

export interface EngineUpdateResult {
  engine: string;
  success: boolean;
  previousVersion: string;
  currentVersion: string;
  message: string;
  rolledBack?: boolean;
}

export interface EngineStatusMap {
  ytdlp: EngineInfo;
  spotdl: EngineInfo;
  ffmpeg: EngineInfo;
  ffprobe: EngineInfo;
  python3: EngineInfo;
}

export interface AppSettings {
  download_dir: string;
  max_concurrent_downloads: number;
  fragment_concurrency: number;
  global_bandwidth_limit_kbps: number;
  per_task_bandwidth_limit_kbps: number;
  max_retries: number;
  retry_delay_seconds: number;
  default_video_format: string;
  default_audio_format: string;
  default_audio_bitrate: string;
  default_audio_bit_depth?: number;
  default_audio_sample_rate?: number;
  embed_thumbnail: boolean;
  embed_metadata: boolean;
  filename_template: string;
  proxy_url: string;
  floating_notifications_enabled: boolean;
  auto_dismiss_seconds: number;
  theme: 'dark';
  auto_retry_failed: boolean;
  auto_resume_on_startup: boolean;
  cookies_browser?: 'auto' | 'chrome' | 'firefox' | 'edge' | 'brave' | 'opera' | 'vivaldi' | 'safari' | 'none';
  cookies_file?: string;
  cookies_content?: string;
  enable_adult_sites?: boolean;
  bypass_age_gate?: boolean;
  user_agent?: string;
}

export interface NotificationItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: string;
  taskId?: string;
}

export interface DiagnosticResult {
  engine: string;
  passed: boolean;
  version?: string;
  command: string;
  output: string;
  duration_ms: number;
}

export interface EngineInstallProgress {
  engine: string;
  status: 'downloading' | 'verifying' | 'extracting' | 'installing' | 'ready' | 'error';
  phase: string;
  progressPercentage: number;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
  error?: string;
}

export interface ManagedEngineInfo {
  installDir: string;
  manifestPath: string;
  requiredReady: boolean;
  missingRequired: string[];
  engines: EngineStatusMap;
}
