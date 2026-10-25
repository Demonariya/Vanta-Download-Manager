import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { DownloadTask, AppSettings, NotificationItem } from '../src/types';

const dataDir = path.resolve(process.cwd(), '.vanta_data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'vanta.db');
const db = new DatabaseSync(dbPath);

// Initialize schema
db.exec(`
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
    eta_str TEXT DEFAULT '--:--',
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

// Safe column migrations
try { db.exec('ALTER TABLE tasks ADD COLUMN audio_sample_rate INTEGER'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN audio_bit_depth INTEGER'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN audio_channels INTEGER'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN is_lossy_source INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN verified_audio_info TEXT'); } catch {}

const DEFAULT_SETTINGS: AppSettings = {
  download_dir: path.resolve(process.cwd(), 'downloads'),
  max_concurrent_downloads: 3,
  fragment_concurrency: 4,
  global_bandwidth_limit_kbps: 0,
  per_task_bandwidth_limit_kbps: 0,
  max_retries: 3,
  retry_delay_seconds: 5,
  default_video_format: 'best',
  default_audio_format: 'mp3',
  default_audio_bitrate: '320k',
  embed_thumbnail: true,
  embed_metadata: true,
  filename_template: '%(title)s [%(id)s].%(ext)s',
  proxy_url: '',
  floating_notifications_enabled: true,
  auto_dismiss_seconds: 5,
  theme: 'dark',
  auto_retry_failed: true,
  auto_resume_on_startup: true,
};

// Ensure download directory exists
if (!fs.existsSync(DEFAULT_SETTINGS.download_dir)) {
  fs.mkdirSync(DEFAULT_SETTINGS.download_dir, { recursive: true });
}

export function getSettings(): AppSettings {
  const stmt = db.prepare('SELECT key, value FROM settings');
  const rows = stmt.all() as { key: string; value: string }[];
  const settings: any = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }

  return settings as AppSettings;
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const updated = { ...current, ...settings };

  const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, val] of Object.entries(updated)) {
    insert.run(key, JSON.stringify(val));
  }

  return updated;
}

export function getAllTasks(): DownloadTask[] {
  const stmt = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');
  const rows = stmt.all() as any[];

  return rows.map((r) => ({
    ...r,
    is_audio_only: Boolean(r.is_audio_only),
    is_lossy_source: Boolean(r.is_lossy_source),
    progress_percentage: Number(r.progress_percentage || 0),
    speed_bytes_per_sec: Number(r.speed_bytes_per_sec || 0),
    downloaded_bytes: Number(r.downloaded_bytes || 0),
    total_bytes: Number(r.total_bytes || 0),
    retries: Number(r.retries || 0),
    max_retries: Number(r.max_retries || 3),
  }));
}

export function getTaskById(id: string): DownloadTask | null {
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const r = stmt.get(id) as any;
  if (!r) return null;

  return {
    ...r,
    is_audio_only: Boolean(r.is_audio_only),
    is_lossy_source: Boolean(r.is_lossy_source),
    progress_percentage: Number(r.progress_percentage || 0),
    speed_bytes_per_sec: Number(r.speed_bytes_per_sec || 0),
    downloaded_bytes: Number(r.downloaded_bytes || 0),
    total_bytes: Number(r.total_bytes || 0),
    retries: Number(r.retries || 0),
    max_retries: Number(r.max_retries || 3),
  };
}

export function upsertTask(task: DownloadTask): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, url, title, uploader, duration, duration_string, thumbnail, engine, status,
      progress_percentage, speed_str, speed_bytes_per_sec, downloaded_bytes, total_bytes,
      eta_str, current_phase, format_id, format_note, ext, is_audio_only, audio_format,
      audio_bitrate, audio_sample_rate, audio_bit_depth, audio_channels, is_lossy_source,
      verified_audio_info, output_path, error_message, priority, created_at, completed_at,
      retries, max_retries
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?
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
    task.engine,
    task.status,
    task.progress_percentage ?? 0,
    task.speed_str ?? '0 B/s',
    task.speed_bytes_per_sec ?? 0,
    task.downloaded_bytes ?? 0,
    task.total_bytes ?? 0,
    task.eta_str ?? '--:--',
    task.current_phase ?? 'Queued',
    task.format_id ?? 'best',
    task.format_note ?? null,
    task.ext ?? 'mp4',
    task.is_audio_only ? 1 : 0,
    task.audio_format ?? null,
    task.audio_bitrate ?? null,
    task.audio_sample_rate ?? null,
    task.audio_bit_depth ?? null,
    task.audio_channels ?? null,
    task.is_lossy_source ? 1 : 0,
    task.verified_audio_info ?? null,
    task.output_path ?? '',
    task.error_message ?? null,
    task.priority ?? 'normal',
    task.created_at ?? new Date().toISOString(),
    task.completed_at ?? null,
    task.retries ?? 0,
    task.max_retries ?? 3
  );
}

export function deleteTask(id: string): void {
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  stmt.run(id);
}

export function clearCompletedTasks(): void {
  const stmt = db.prepare("DELETE FROM tasks WHERE status IN ('completed', 'cancelled')");
  stmt.run();
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
