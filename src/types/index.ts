export type EngineType = 'yt-dlp' | 'spotdl';

export type TaskStatus =
  | 'queued'
  | 'inspecting'
  | 'ready'
  | 'connecting'
  | 'downloading'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'processing'
  | 'muxing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'low' | 'normal' | 'high' | 'highest';

export type ThemeMode = 'dark' | 'light' | 'system';

export type ConflictStrategy = 'rename' | 'overwrite' | 'skip';

export interface TaskLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface SchedulerSettings {
  enabled: boolean;
  start_time: string; // HH:mm
  stop_time: string; // HH:mm
  pause_on_stop: boolean;
  days: number[]; // 0 (Sun) - 6 (Sat)
}

export interface SubtitleLanguage {
  code: string;
  name: string;
}

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
  format_note?: string;
  tbr?: number;
  abr?: number;
  is_audio_only?: boolean;
  is_video_only?: boolean;
}

export type SpotifyContentType = 'track' | 'album' | 'playlist' | 'artist';

export interface SpotifyTrackItem {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  duration?: number;
  duration_string?: string;
  track_number?: number;
  artwork?: string;
  explicit?: boolean;
  url?: string;
}

export interface PlaylistEntry {
  id: string;
  index: number;
  title: string;
  url: string;
  duration?: number;
  duration_string?: string;
  uploader?: string;
  thumbnail?: string;
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
  subtitles?: SubtitleLanguage[];
  automatic_subtitles?: SubtitleLanguage[];
  is_playlist: boolean;
  playlist_count?: number;
  extractor: string;
  content_type?: SpotifyContentType;
  artists?: string[];
  album?: string;
  album_artwork?: string;
  track_number?: number;
  release_date?: string;
  explicit?: boolean;
  owner?: string;
  tracks?: SpotifyTrackItem[];
  entries?: PlaylistEntry[];
  total_tracks?: number;
  partial_tracks?: boolean;
  metadata_source?: string;
}

export interface DownloadQueue {
  id: string;
  name: string;
  is_default: boolean;
  is_paused: boolean;
  queue_order: number;
}

export interface DownloadTask {
  id: string;
  url: string;
  title: string;
  uploader?: string;
  duration?: number;
  duration_string?: string;
  thumbnail?: string;
  album?: string;
  content_type?: SpotifyContentType;
  engine: EngineType;
  status: TaskStatus;
  progress_percentage: number;
  percentage_known?: boolean;
  speed_str: string;
  speed_bytes_per_sec: number;
  avg_speed_bytes_per_sec?: number;
  downloaded_bytes: number;
  total_bytes: number;
  remaining_bytes?: number;
  eta_str: string;
  eta_seconds?: number | null;
  elapsed_seconds?: number;
  active_connections?: number;
  last_progress_at?: string | null;
  current_phase: string;
  format_id: string;
  format_note?: string;
  subtitle_languages?: string[];
  write_auto_subtitles?: boolean;
  lyrics_lrc_content?: string | null;
  ext: string;
  video_codec?: string | null;
  audio_codec?: string | null;
  resolution_label?: string | null;
  is_audio_only: boolean;
  audio_format?: string;
  audio_bitrate?: string;
  audio_sample_rate?: number;
  audio_bit_depth?: number;
  audio_channels?: number;
  is_lossy_source?: boolean;
  verified_audio_info?: string;
  output_path: string;
  custom_filename?: string | null;
  playlist_mode?: 'single' | 'playlist';
  selected_items?: string[];
  tracks_requested?: number;
  tracks_completed?: number;
  tracks_failed?: number;
  error_message?: string;
  logs?: TaskLogEntry[];
  priority: TaskPriority;
  queue_order?: number;
  queue_id?: string;
  created_at: string;
  started_at?: string | null;
  completed_at?: string;
  retries: number;
  max_retries: number;
}

export type BrowserCookieSource =
  | 'auto'
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'brave'
  | 'opera'
  | 'vivaldi'
  | 'none';

export interface DetectedBrowserInfo {
  id: string;
  label: string;
  detected: boolean;
  profiles: string[];
  defaultProfile: string | null;
  hasCookieStore: boolean;
}

export interface CookieStatus {
  activeSource: 'file' | 'browser' | 'auto' | 'none';
  configuredBrowser: string;
  configuredProfile: string | null;
  resolvedBrowser: string | null;
  resolvedProfile: string | null;
  fileConfigured: boolean;
  fileExists: boolean;
  filePath: string;
  fileValid: boolean;
  recordCount: number;
  domainCount: number;
  httpOnlyCount: number;
  secureCount: number;
  updatedAt: string | null;
  error: string | null;
  detectedBrowsers: DetectedBrowserInfo[];
}

export interface CookieValidationResult {
  valid: boolean;
  recordCount: number;
  domainCount: number;
  httpOnlyCount: number;
  secureCount: number;
  hasNetscapeHeader?: boolean;
  errors: string[];
}

export type CookieTestStage =
  | 'disabled'
  | 'engine_missing'
  | 'file_invalid'
  | 'file_valid'
  | 'browser_not_installed'
  | 'profile_missing'
  | 'db_locked'
  | 'extraction_ok'
  | 'auth_verified'
  | 'auth_failed';

export interface CookieTestResult {
  success: boolean;
  stage: CookieTestStage;
  activeSource: string;
  browser: string;
  resolvedBrowser: string | null;
  resolvedProfile: string | null;
  browserDetected: boolean;
  profileLocated: boolean;
  databaseAccessible: boolean;
  extractionSucceeded: boolean;
  authVerified: boolean | null;
  recordCount: number;
  message: string;
  nextAction: string | null;
}

export interface DiagnosticLogInfo {
  logDir: string;
  logPath: string;
  exists: boolean;
  fileSizeBytes: number;
  recentLines: string[];
}

export interface PythonValidationResult {
  valid: boolean;
  executablePath: string;
  version?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
}

export interface AppSettings {
  schema_version?: number;
  download_dir: string;
  python_path?: string;
  max_concurrent_downloads: number;
  fragment_concurrency: number;
  global_bandwidth_limit_kbps: number;
  per_task_bandwidth_limit_kbps: number;
  max_retries: number;
  retry_delay_seconds: number;
  default_video_format: string;
  default_audio_format: string;
  default_audio_bitrate: string;
  default_audio_sample_rate?: number;
  default_audio_bit_depth?: number;
  embed_thumbnail: boolean;
  embed_metadata: boolean;
  filename_template: string;
  proxy_url: string;
  floating_notifications_enabled: boolean;
  floating_widget_enabled?: boolean;
  auto_dismiss_seconds: number;
  theme: ThemeMode;
  auto_retry_failed: boolean;
  auto_resume_on_startup: boolean;
  launch_on_startup?: boolean;
  start_minimized?: boolean;
  clipboard_monitoring?: boolean;
  conflict_strategy?: ConflictStrategy;
  verify_media_on_complete?: boolean;
  tray_minimize_on_close?: boolean;
  scheduler?: SchedulerSettings;
  cookies_browser?: BrowserCookieSource;
  cookies_profile?: string;
  cookies_file?: string;
  user_agent?: string;
}

export interface EngineInfo {
  available: boolean;
  version: string;
  path: string;
  status: 'ready' | 'missing' | 'error' | 'checking' | 'timed_out';
  lastChecked: string;
  error?: string;
  durationMs?: number;
  latestVersion?: string;
  updateAvailable?: boolean;
  isUpdating?: boolean;
}

export interface EngineStatusMap {
  ytdlp: EngineInfo;
  spotdl: EngineInfo;
  ffmpeg: EngineInfo;
  ffprobe: EngineInfo;
  python3?: EngineInfo;
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
  installRoot: string;
  installDir: string;
  ytdlpDir: string;
  spotdlDir: string;
  ffmpegDir: string;
  manifestPath: string;
  settingsFilePath?: string;
  isWritable?: boolean;
  requiresElevation?: boolean;
  requiredReady: boolean;
  missingRequired: string[];
  engines: EngineStatusMap;
}

export interface EngineUpdateResult {
  engine: string;
  success: boolean;
  previousVersion: string;
  currentVersion: string;
  message: string;
  rolledBack?: boolean;
}

export interface DiagnosticResult {
  engine: string;
  passed: boolean;
  version?: string;
  command: string;
  output: string;
  duration_ms: number;
}

export interface NotificationItem {
  id: string;
  type: 'success' | 'warning' | 'error' | 'info';
  title: string;
  message: string;
  timestamp: string;
  taskId?: string;
}
