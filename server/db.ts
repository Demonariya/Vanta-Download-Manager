import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppSettings,
  DownloadTask,
  NotificationItem,
  TaskLogEntry,
} from '../src/types';
import { isValidThumbnailUrl, sanitizeFilename } from '../src/utils/engine-parser';
import { DEFAULT_SCHEDULER_SETTINGS } from '../src/utils/scheduler';

export const SETTINGS_SCHEMA_VERSION = 1;

export function getAppDataDir(): string {
  const override = process.env.VANTA_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'VANTA Download Manager');
  }
  if (process.env.XDG_DATA_HOME?.trim()) {
    return path.join(process.env.XDG_DATA_HOME.trim(), 'vanta-download-manager');
  }
  return path.resolve(process.cwd(), '.vanta_data');
}

function migrateLegacyWindowsDataIfNeeded(targetDir: string): void {
  if (process.platform !== 'win32') return;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;
  const legacyDir = path.join(localAppData, 'com.vanta.downloadmanager');
  if (legacyDir === targetDir || !fs.existsSync(legacyDir)) return;

  for (const filename of ['vanta.db', 'vanta_native.db', 'cookies.txt']) {
    const src = path.join(legacyDir, filename);
    const dst = path.join(targetDir, filename);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.copyFileSync(src, dst);
      } catch {
        // Non-fatal best-effort migration
      }
    }
  }
}

export function getSettingsFilePath(dir = getAppDataDir()): string {
  return path.join(dir, 'settings.v1.json');
}

export function buildDefaultSettings(): AppSettings {
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    download_dir: path.join(os.homedir() || process.cwd(), 'Downloads', 'VANTA'),
    max_concurrent_downloads: 3,
    fragment_concurrency: 3,
    global_bandwidth_limit_kbps: 0,
    per_task_bandwidth_limit_kbps: 0,
    max_retries: 3,
    retry_delay_seconds: 5,
    default_video_format: 'best',
    default_audio_format: 'mp3',
    default_audio_bitrate: '320k',
    default_audio_sample_rate: 48000,
    default_audio_bit_depth: 24,
    embed_thumbnail: true,
    embed_metadata: true,
    filename_template: '%(title)s [%(id)s].%(ext)s',
    proxy_url: '',
    auto_dismiss_seconds: 5,
    theme: 'dark',
    auto_retry_failed: true,
    auto_resume_on_startup: true,
    launch_on_startup: false,
    start_minimized: false,
    clipboard_monitoring: false,
    conflict_strategy: 'rename',
    verify_media_on_complete: true,
    tray_minimize_on_close: true,
    scheduler: { ...DEFAULT_SCHEDULER_SETTINGS },
    cookies_browser: 'auto',
    cookies_profile: undefined,
    cookies_file: undefined,
    python_path: '',
    user_agent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

export function validateSettings(settings: AppSettings): void {
  if (!settings.download_dir || !String(settings.download_dir).trim()) {
    throw new Error('Download directory cannot be empty.');
  }
  if (!Number.isFinite(settings.max_concurrent_downloads) || settings.max_concurrent_downloads < 1 || settings.max_concurrent_downloads > 16) {
    throw new Error('Max concurrent downloads must be between 1 and 16.');
  }
  if (!Number.isInteger(settings.fragment_concurrency) || settings.fragment_concurrency < 1 || settings.fragment_concurrency > 3) {
    throw new Error('Fragment concurrency must be between 1 and 3.');
  }
  if (!Number.isFinite(settings.max_retries) || settings.max_retries < 0 || settings.max_retries > 20) {
    throw new Error('Max retries must be between 0 and 20.');
  }
  if (!Number.isFinite(settings.retry_delay_seconds) || settings.retry_delay_seconds < 1 || settings.retry_delay_seconds > 300) {
    throw new Error('Retry delay must be between 1 and 300 seconds.');
  }
  if (!Number.isInteger(settings.max_concurrent_downloads)) {
    throw new Error('Max concurrent downloads must be a whole number.');
  }
  if (!Number.isInteger(settings.max_retries)) {
    throw new Error('Max retries must be a whole number.');
  }
  if (!Number.isInteger(settings.retry_delay_seconds)) {
    throw new Error('Retry delay must be a whole number.');
  }
  for (const [label, value] of [
    ['Global bandwidth limit', settings.global_bandwidth_limit_kbps],
    ['Per-task bandwidth limit', settings.per_task_bandwidth_limit_kbps],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000) {
      throw new Error(`${label} must be a whole number between 0 and 10,000,000 KB/s.`);
    }
  }
  const scheduler = settings.scheduler || DEFAULT_SCHEDULER_SETTINGS;
  const validTime = (value: string) => /^([01]\\d|2[0-3]):[0-5]\\d$/.test(value);
  if (!validTime(scheduler.start_time) || !validTime(scheduler.stop_time)) {
    throw new Error('Scheduler start and stop times must use valid HH:mm values.');
  }
  if (!Array.isArray(scheduler.days) || scheduler.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('Scheduler days must contain valid weekdays (0–6).');
  }
  if (typeof scheduler.enabled !== 'boolean' || typeof scheduler.pause_on_stop !== 'boolean') {
    throw new Error('Scheduler enabled and pause settings must be boolean values.');
  }
  if (![3, 5, 8, 10, 15, 30].includes(settings.auto_dismiss_seconds)) {
    throw new Error('Notification duration must be one of the supported values.');
  }
  if (!['rename', 'overwrite', 'skip'].includes(settings.conflict_strategy || 'rename')) {
    throw new Error('Conflict strategy must be rename, overwrite, or skip.');
  }
  if (!['dark', 'light', 'system'].includes(settings.theme)) {
    throw new Error('Theme must be dark, light, or system.');
  }
  if (!settings.filename_template || !String(settings.filename_template).trim()) {
    throw new Error('Filename template cannot be empty.');
  }
  const proxy = (settings.proxy_url || '').trim();
  if (proxy && !/^(https?|socks4|socks5):\/\//i.test(proxy)) {
    throw new Error('Proxy URL must begin with http://, https://, socks4://, or socks5://.');
  }
  const cookiesFile = (settings.cookies_file || '').trim();
  if (cookiesFile && !fs.existsSync(cookiesFile)) {
    throw new Error(`Configured cookies file does not exist: ${cookiesFile}`);
  }
}

export function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function initializeDatabaseSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      uploader TEXT,
      duration INTEGER,
      duration_string TEXT,
      thumbnail TEXT,
      engine TEXT NOT NULL,
      status TEXT NOT NULL,
      progress_percentage REAL DEFAULT 0,
      speed_str TEXT DEFAULT '0 B/s',
      speed_bytes_per_sec REAL DEFAULT 0,
      downloaded_bytes INTEGER DEFAULT 0,
      total_bytes INTEGER DEFAULT 0,
      eta_str TEXT DEFAULT '--',
      current_phase TEXT DEFAULT 'queued',
      format_id TEXT DEFAULT 'best',
      format_note TEXT,
      ext TEXT DEFAULT 'mp4',
      is_audio_only INTEGER DEFAULT 0,
      audio_format TEXT,
      audio_bitrate TEXT,
      output_path TEXT NOT NULL,
      error_message TEXT,
      priority TEXT DEFAULT 'normal',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      retries INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      task_id TEXT
    );
  `);

  const migrations = [
    'ALTER TABLE tasks ADD COLUMN audio_sample_rate INTEGER',
    'ALTER TABLE tasks ADD COLUMN audio_bit_depth INTEGER',
    'ALTER TABLE tasks ADD COLUMN audio_channels INTEGER',
    'ALTER TABLE tasks ADD COLUMN is_lossy_source INTEGER DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN verified_audio_info TEXT',
    'ALTER TABLE tasks ADD COLUMN album TEXT',
    'ALTER TABLE tasks ADD COLUMN content_type TEXT',
    'ALTER TABLE tasks ADD COLUMN remaining_bytes INTEGER DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN percentage_known INTEGER DEFAULT 1',
    'ALTER TABLE tasks ADD COLUMN avg_speed_bytes_per_sec REAL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN eta_seconds INTEGER',
    'ALTER TABLE tasks ADD COLUMN elapsed_seconds INTEGER DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN active_connections INTEGER DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN last_progress_at TEXT',
    'ALTER TABLE tasks ADD COLUMN video_codec TEXT',
    'ALTER TABLE tasks ADD COLUMN audio_codec TEXT',
    'ALTER TABLE tasks ADD COLUMN resolution_label TEXT',
    'ALTER TABLE tasks ADD COLUMN custom_filename TEXT',
    'ALTER TABLE tasks ADD COLUMN playlist_mode TEXT',
    'ALTER TABLE tasks ADD COLUMN selected_items_json TEXT',
    'ALTER TABLE tasks ADD COLUMN tracks_requested INTEGER',
    'ALTER TABLE tasks ADD COLUMN tracks_completed INTEGER',
    'ALTER TABLE tasks ADD COLUMN tracks_failed INTEGER',
    'ALTER TABLE tasks ADD COLUMN logs_json TEXT',
    'ALTER TABLE tasks ADD COLUMN queue_order INTEGER DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN started_at TEXT',
  ];

  for (const sql of migrations) {
    try {
      database.exec(sql);
    } catch {
      // column already exists
    }
  }

  try {
    database.exec("DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')");
  } catch {}
}

function hydrateSettingsObject(rawObj: Record<string, any>, dataRoot: string): AppSettings {
  const defaults = buildDefaultSettings();
  const merged: any = { ...defaults, ...rawObj, schema_version: SETTINGS_SCHEMA_VERSION };
  delete merged.cookies_content;
  delete merged.enable_adult_sites;
  delete merged.bypass_age_gate;

  if (!merged.download_dir || !String(merged.download_dir).trim()) {
    merged.download_dir = defaults.download_dir;
  }
  if (merged.cookies_file && typeof merged.cookies_file === 'string' && !fs.existsSync(merged.cookies_file)) {
    if (merged.cookies_file === path.resolve(dataRoot, 'cookies.txt')) {
      merged.cookies_file = undefined;
    }
  }
  if (!merged.scheduler || typeof merged.scheduler !== 'object') {
    merged.scheduler = { ...DEFAULT_SCHEDULER_SETTINGS };
  }
  // The download engine intentionally caps fragment parallelism at three.
  // Normalize legacy values (the old default was four) so the UI and engine agree.
  const requestedFragments = Number(merged.fragment_concurrency);
  merged.fragment_concurrency = Number.isFinite(requestedFragments)
    ? Math.min(3, Math.max(1, Math.floor(requestedFragments)))
    : defaults.fragment_concurrency;
  merged.python_path = typeof merged.python_path === 'string' ? merged.python_path : '';
  return merged as AppSettings;
}

export function readSettingsFromStorage(database: DatabaseSync, dataRoot: string): AppSettings {
  const settingsFile = getSettingsFilePath(dataRoot);
  if (fs.existsSync(settingsFile)) {
    try {
      const rawText = fs.readFileSync(settingsFile, 'utf-8');
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Settings file root is not a JSON object');
      }
      return hydrateSettingsObject(parsed, dataRoot);
    } catch (err) {
      const corruptPath = path.join(dataRoot, `settings.corrupt.${Date.now()}.json`);
      try {
        fs.renameSync(settingsFile, corruptPath);
      } catch {}
      console.warn(`Recovered corrupt settings file to ${corruptPath}:`, err);
      const defaults = buildDefaultSettings();
      writeSettingsToStorage(database, dataRoot, defaults);
      return defaults;
    }
  }

  const rows = database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const rawFromDb: Record<string, any> = {};
  for (const row of rows) {
    if (row.key === 'cookies_content' || row.key === 'enable_adult_sites' || row.key === 'bypass_age_gate') {
      continue;
    }
    try {
      rawFromDb[row.key] = JSON.parse(row.value);
    } catch {
      rawFromDb[row.key] = row.value;
    }
  }

  const hydrated = hydrateSettingsObject(rawFromDb, dataRoot);
  try {
    writeSettingsToStorage(database, dataRoot, hydrated);
  } catch {
    // Non-fatal if read-only on first read
  }
  return hydrated;
}

export function writeSettingsToStorage(
  database: DatabaseSync,
  dataRoot: string,
  nextSettings: AppSettings
): AppSettings {
  const normalized: any = hydrateSettingsObject(nextSettings as any, dataRoot);
  validateSettings(normalized as AppSettings);

  atomicWriteFileSync(getSettingsFilePath(dataRoot), JSON.stringify(normalized, null, 2));

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec("DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')");
    const insert = database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const remove = database.prepare('DELETE FROM settings WHERE key = ?');
    for (const [key, val] of Object.entries(normalized)) {
      if (val === undefined) {
        remove.run(key);
      } else {
        insert.run(key, JSON.stringify(val));
      }
    }
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch {}
    throw err;
  }

  return normalized as AppSettings;
}

export function resetSettingsInStorage(database: DatabaseSync, dataRoot: string): AppSettings {
  const defaults = buildDefaultSettings();
  if (!fs.existsSync(defaults.download_dir)) {
    try { fs.mkdirSync(defaults.download_dir, { recursive: true }); } catch {}
  }
  atomicWriteFileSync(getSettingsFilePath(dataRoot), JSON.stringify(defaults, null, 2));
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM settings');
    const insert = database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, val] of Object.entries(defaults)) {
      if (val !== undefined) {
        insert.run(key, JSON.stringify(val));
      }
    }
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch {}
    throw err;
  }
  return defaults;
}

const dataDir = getAppDataDir();
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
migrateLegacyWindowsDataIfNeeded(dataDir);

const dbPath = path.join(dataDir, 'vanta.db');
const db = new DatabaseSync(dbPath);
initializeDatabaseSchema(db);

// Ensure default download directory exists
const initialSettings = readSettingsFromStorage(db, dataDir);
if (initialSettings.download_dir && !fs.existsSync(initialSettings.download_dir)) {
  try {
    fs.mkdirSync(initialSettings.download_dir, { recursive: true });
  } catch {
    // non-fatal if custom path unreachable at boot
  }
}

export function hydrateTaskRow(r: any): DownloadTask {
  let logs: TaskLogEntry[] = [];
  if (typeof r.logs_json === 'string' && r.logs_json) {
    try {
      const parsed = JSON.parse(r.logs_json);
      if (Array.isArray(parsed)) logs = parsed;
    } catch {
      logs = [];
    }
  }

  let selectedItems: string[] | null = null;
  if (typeof r.selected_items_json === 'string' && r.selected_items_json) {
    try {
      const parsed = JSON.parse(r.selected_items_json);
      if (Array.isArray(parsed)) selectedItems = parsed.map((v) => String(v));
    } catch {
      selectedItems = null;
    }
  }

  return {
    id: r.id,
    url: r.url,
    title: r.title,
    uploader: r.uploader ?? undefined,
    duration: r.duration ?? undefined,
    duration_string: r.duration_string ?? undefined,
    thumbnail: r.thumbnail ?? undefined,
    album: r.album ?? undefined,
    content_type: r.content_type ?? undefined,
    engine: r.engine,
    status: r.status,
    progress_percentage: Number(r.progress_percentage || 0),
    percentage_known: r.percentage_known === undefined || r.percentage_known === null ? true : Boolean(r.percentage_known),
    speed_str: r.speed_str ?? '0 B/s',
    speed_bytes_per_sec: Number(r.speed_bytes_per_sec || 0),
    avg_speed_bytes_per_sec: Number(r.avg_speed_bytes_per_sec || 0),
    downloaded_bytes: Number(r.downloaded_bytes || 0),
    total_bytes: Number(r.total_bytes || 0),
    remaining_bytes: Number(r.remaining_bytes || 0),
    eta_str: r.eta_str ?? '--',
    eta_seconds: r.eta_seconds === null || r.eta_seconds === undefined ? null : Number(r.eta_seconds),
    elapsed_seconds: Number(r.elapsed_seconds || 0),
    active_connections: Number(r.active_connections || 0),
    last_progress_at: r.last_progress_at ?? undefined,
    current_phase: r.current_phase ?? 'Queued',
    format_id: r.format_id ?? 'best',
    format_note: r.format_note ?? undefined,
    ext: r.ext ?? 'mp4',
    video_codec: r.video_codec ?? null,
    audio_codec: r.audio_codec ?? null,
    resolution_label: r.resolution_label ?? null,
    is_audio_only: Boolean(r.is_audio_only),
    audio_format: r.audio_format ?? undefined,
    audio_bitrate: r.audio_bitrate ?? undefined,
    audio_sample_rate: r.audio_sample_rate ?? undefined,
    audio_bit_depth: r.audio_bit_depth ?? undefined,
    audio_channels: r.audio_channels ?? undefined,
    is_lossy_source: Boolean(r.is_lossy_source),
    verified_audio_info: r.verified_audio_info ?? undefined,
    output_path: r.output_path ?? '',
    custom_filename: r.custom_filename ?? null,
    playlist_mode: r.playlist_mode ?? null,
    selected_items: selectedItems ?? undefined,
    tracks_requested: r.tracks_requested ?? undefined,
    tracks_completed: r.tracks_completed ?? undefined,
    tracks_failed: r.tracks_failed ?? undefined,
    error_message: r.error_message ?? undefined,
    logs,
    priority: r.priority ?? 'normal',
    queue_order: Number(r.queue_order || 0),
    created_at: r.created_at,
    started_at: r.started_at ?? null,
    completed_at: r.completed_at ?? null,
    retries: Number(r.retries || 0),
    max_retries: Number(r.max_retries || 3),
  };
}

export function getSettings(): AppSettings {
  return readSettingsFromStorage(db, dataDir);
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const sanitizedPatch: Record<string, any> = { ...settings };
  delete sanitizedPatch.cookies_content;
  delete sanitizedPatch.enable_adult_sites;
  delete sanitizedPatch.bypass_age_gate;

  const updated: AppSettings = {
    ...current,
    ...sanitizedPatch,
    schema_version: SETTINGS_SCHEMA_VERSION,
  };
  return writeSettingsToStorage(db, dataDir, updated);
}

export function resetSettings(): AppSettings {
  return resetSettingsInStorage(db, dataDir);
}

export function getAllTasks(): DownloadTask[] {
  const stmt = db.prepare('SELECT * FROM tasks ORDER BY queue_order ASC, created_at DESC');
  const rows = stmt.all() as any[];
  return rows.map(hydrateTaskRow);
}

export function getTaskById(id: string): DownloadTask | null {
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const r = stmt.get(id) as any;
  if (!r) return null;
  return hydrateTaskRow(r);
}

const PLACEHOLDER_TASK_TITLES = new Set([
  '',
  'Loading...',
  'Inspecting...',
  'Resolving...',
  'Unknown Title',
  'Queued video URL',
  'Queued Item',
  'Queued Download',
  'Download Task',
  'Media Download',
  'Media',
  'Untitled Media',
  'Spotify Track / Album',
  'Spotify Music Track',
  'Spotify Album / Playlist',
]);

export function isPlaceholderTaskTitle(title: string | undefined | null): boolean {
  const trimmed = (title || '').trim();
  if (PLACEHOLDER_TASK_TITLES.has(trimmed)) return true;
  return (
    trimmed.startsWith('Batch Item:') ||
    trimmed.startsWith('Batch Media:') ||
    trimmed.startsWith('Inspecting ')
  );
}

/**
 * Safely merges partial progress/metadata updates into an existing DownloadTask
 * without stripping valid thumbnails, titles, uploader metadata, or logs.
 */
export function mergeTaskUpdate(
  current: DownloadTask,
  update: Partial<DownloadTask>
): DownloadTask {
  const cleanedUpdate: Record<string, any> = {};
  for (const [key, val] of Object.entries(update || {})) {
    if (val !== undefined) {
      cleanedUpdate[key] = val;
    }
  }

  // Never erase a valid thumbnail with empty/invalid values
  if ('thumbnail' in cleanedUpdate) {
    if (!isValidThumbnailUrl(cleanedUpdate.thumbnail)) {
      if (isValidThumbnailUrl(current.thumbnail)) {
        cleanedUpdate.thumbnail = current.thumbnail;
      } else {
        delete cleanedUpdate.thumbnail;
      }
    } else {
      cleanedUpdate.thumbnail = cleanedUpdate.thumbnail.trim();
    }
  } else if (isValidThumbnailUrl(current.thumbnail)) {
    cleanedUpdate.thumbnail = current.thumbnail;
  }

  // Never overwrite a meaningful user/inspected title with a placeholder or empty string
  if ('title' in cleanedUpdate) {
    const nextTitle = typeof cleanedUpdate.title === 'string' ? cleanedUpdate.title.trim() : '';
    if (!nextTitle || (!isPlaceholderTaskTitle(current.title) && isPlaceholderTaskTitle(nextTitle))) {
      cleanedUpdate.title = current.title;
    } else {
      cleanedUpdate.title = nextTitle;
    }
  }

  // Preserve non-empty descriptive metadata if incoming values are blank
  for (const field of ['uploader', 'album', 'duration_string', 'content_type'] as const) {
    if (field in cleanedUpdate) {
      const nextVal = typeof cleanedUpdate[field] === 'string' ? cleanedUpdate[field].trim() : cleanedUpdate[field];
      if (!nextVal && current[field]) {
        cleanedUpdate[field] = current[field];
      }
    }
  }

  const merged: DownloadTask = {
    ...current,
    ...cleanedUpdate,
  };

  if (Array.isArray(merged.logs)) {
    merged.logs = merged.logs.slice(-100);
  }
  return merged;
}

export function upsertTask(task: DownloadTask): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, url, title, uploader, duration, duration_string, thumbnail, album, content_type, engine, status,
      progress_percentage, percentage_known, speed_str, speed_bytes_per_sec, avg_speed_bytes_per_sec,
      downloaded_bytes, total_bytes, remaining_bytes, eta_str, eta_seconds, elapsed_seconds,
      active_connections, last_progress_at, current_phase, format_id, format_note, ext,
      video_codec, audio_codec, resolution_label, is_audio_only, audio_format,
      audio_bitrate, audio_sample_rate, audio_bit_depth, audio_channels, is_lossy_source,
      verified_audio_info, output_path, custom_filename, playlist_mode,
      selected_items_json, tracks_requested, tracks_completed, tracks_failed,
      error_message, logs_json, priority, queue_order, created_at, started_at, completed_at, retries, max_retries
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    task.id,
    task.url,
    task.title,
    task.uploader ?? null,
    task.duration ?? null,
    task.duration_string ?? null,
    task.thumbnail ?? null,
    task.album ?? null,
    task.content_type ?? null,
    task.engine,
    task.status,
    task.progress_percentage ?? 0,
    task.percentage_known === false ? 0 : 1,
    task.speed_str ?? '0 B/s',
    task.speed_bytes_per_sec ?? 0,
    task.avg_speed_bytes_per_sec ?? 0,
    task.downloaded_bytes ?? 0,
    task.total_bytes ?? 0,
    task.remaining_bytes ?? 0,
    task.eta_str ?? '--',
    task.eta_seconds ?? null,
    task.elapsed_seconds ?? 0,
    task.active_connections ?? 0,
    task.last_progress_at ?? null,
    task.current_phase ?? 'Queued',
    task.format_id ?? 'best',
    task.format_note ?? null,
    task.ext ?? 'mp4',
    task.video_codec ?? null,
    task.audio_codec ?? null,
    task.resolution_label ?? null,
    task.is_audio_only ? 1 : 0,
    task.audio_format ?? null,
    task.audio_bitrate ?? null,
    task.audio_sample_rate ?? null,
    task.audio_bit_depth ?? null,
    task.audio_channels ?? null,
    task.is_lossy_source ? 1 : 0,
    task.verified_audio_info ?? null,
    task.output_path ?? '',
    task.custom_filename ?? null,
    task.playlist_mode ?? null,
    task.selected_items && task.selected_items.length > 0 ? JSON.stringify(task.selected_items) : null,
    task.tracks_requested ?? null,
    task.tracks_completed ?? null,
    task.tracks_failed ?? null,
    task.error_message ?? null,
    JSON.stringify((task.logs || []).slice(-100)),
    task.priority ?? 'normal',
    task.queue_order ?? 0,
    task.created_at ?? new Date().toISOString(),
    task.started_at ?? null,
    task.completed_at ?? null,
    task.retries ?? 0,
    task.max_retries ?? 3
  );
}

export function appendTaskLog(
  taskId: string,
  level: 'info' | 'warn' | 'error',
  message: string
): DownloadTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  const logs = [...(task.logs || []), { timestamp: new Date().toISOString(), level, message }].slice(-100);
  task.logs = logs;
  upsertTask(task);
  return task;
}

export function removeTaskFiles(task: DownloadTask): boolean {
  let removed = false;
  try {
    if (task.output_path && fs.existsSync(task.output_path)) {
      const stat = fs.statSync(task.output_path);
      if (stat.isFile()) {
        fs.unlinkSync(task.output_path);
        removed = true;
      }
      const partPath = `${task.output_path}.part`;
      if (fs.existsSync(partPath) && fs.statSync(partPath).isFile()) {
        fs.unlinkSync(partPath);
        removed = true;
      }
    }
  } catch (err) {
    console.warn(`Failed to remove file for task ${task.id}:`, err);
  }
  return removed;
}

export function deleteTask(id: string, deleteFileFromDisk = false): void {
  if (deleteFileFromDisk) {
    const task = getTaskById(id);
    if (task) {
      removeTaskFiles(task);
    }
  }
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  stmt.run(id);
}

export function deleteDownloadedFile(id: string): boolean {
  const task = getTaskById(id);
  if (!task) return false;
  const removed = removeTaskFiles(task);
  if (removed) {
    task.output_path = '';
    task.current_phase = 'File removed from disk';
    upsertTask(task);
  }
  return removed;
}

export function clearCompletedTasks(deleteFiles = false): void {
  if (deleteFiles) {
    const tasks = getAllTasks().filter(
      (t) => t.status === 'completed' || t.status === 'cancelled'
    );
    for (const t of tasks) {
      removeTaskFiles(t);
    }
  }
  const stmt = db.prepare("DELETE FROM tasks WHERE status IN ('completed', 'cancelled')");
  stmt.run();
}

export function clearFailedTasks(): void {
  const stmt = db.prepare("DELETE FROM tasks WHERE status = 'failed'");
  stmt.run();
}

export function clearAllTasks(deleteFiles = false): void {
  if (deleteFiles) {
    const tasks = getAllTasks();
    for (const t of tasks) {
      removeTaskFiles(t);
    }
  }
  const stmt = db.prepare('DELETE FROM tasks');
  stmt.run();
}

export function moveTaskOrderInDb(taskId: string, direction: 'up' | 'down'): DownloadTask[] {
  const tasks = getAllTasks();
  const normalized = tasks.map((t, i) => ({ ...t, queue_order: i + 1 }));
  const idx = normalized.findIndex((t) => t.id === taskId);
  if (idx !== -1) {
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx >= 0 && swapIdx < normalized.length) {
      const tmp = normalized[idx];
      normalized[idx] = normalized[swapIdx];
      normalized[swapIdx] = tmp;
    }
  }
  const stmt = db.prepare('UPDATE tasks SET queue_order = ? WHERE id = ?');
  normalized.forEach((t, idx2) => {
    t.queue_order = idx2 + 1;
    stmt.run(t.queue_order, t.id);
  });
  return getAllTasks();
}

export function renameTaskFileInDb(taskId: string, newFilename: string): DownloadTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;

  const cleaned = sanitizeFilename(newFilename);
  if (!cleaned) {
    throw new Error('New filename cannot be empty.');
  }

  if (task.output_path && fs.existsSync(task.output_path) && fs.statSync(task.output_path).isFile()) {
    const dir = path.dirname(task.output_path);
    const currentExt = path.extname(task.output_path);
    const hasExt = Boolean(path.extname(cleaned));
    const targetName = hasExt ? cleaned : `${cleaned}${currentExt}`;
    const targetPath = path.join(dir, targetName);
    if (targetPath !== task.output_path) {
      if (fs.existsSync(targetPath)) {
        throw new Error(`Destination file already exists: ${targetName}`);
      }
      fs.renameSync(task.output_path, targetPath);
      task.output_path = targetPath;
      task.title = path.basename(targetName, path.extname(targetName));
    }
  } else {
    task.custom_filename = cleaned;
  }

  task.logs = [
    ...(task.logs || []),
    {
      timestamp: new Date().toISOString(),
      level: 'info' as const,
      message: `Renamed target to "${cleaned}"`,
    },
  ].slice(-100);

  upsertTask(task);
  return task;
}

export function addNotification(notification: NotificationItem): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO notifications (id, type, title, message, timestamp, task_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    notification.id,
    notification.type,
    notification.title,
    notification.message,
    notification.timestamp,
    notification.taskId || null
  );
}

export function getNotifications(): NotificationItem[] {
  const stmt = db.prepare('SELECT * FROM notifications ORDER BY timestamp DESC LIMIT 50');
  const rows = stmt.all() as any[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    message: r.message,
    timestamp: r.timestamp,
    taskId: r.task_id,
  }));
}

export function clearNotifications(): void {
  db.exec('DELETE FROM notifications');
}
