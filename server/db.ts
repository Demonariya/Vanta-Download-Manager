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
  cookies_browser: 'auto',
  cookies_file: path.resolve(dataDir, 'cookies.txt'),
  enable_adult_sites: true,
  bypass_age_gate: true,
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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

export function removeTaskFiles(task: DownloadTask): boolean {
  let removed = false;
  try {
    // 1. Direct output_path if pointing to a file
    if (task.output_path && fs.existsSync(task.output_path)) {
      const stat = fs.statSync(task.output_path);
      if (stat.isFile()) {
        fs.unlinkSync(task.output_path);
        removed = true;
      }
    }

    // 2. Scan downloads directory for files matching task ID or title
    const downloadDir = path.resolve(process.cwd(), 'downloads');
    if (fs.existsSync(downloadDir)) {
      const entries = fs.readdirSync(downloadDir);
      for (const entry of entries) {
        if (entry.includes(task.id) || (task.title && entry.includes(task.title.slice(0, 30)))) {
          const full = path.join(downloadDir, entry);
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            fs.unlinkSync(full);
            removed = true;
          }
        }
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
    // Update task output path
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

export function saveCookiesTxt(content: string): string {
  const cookiePath = path.resolve(dataDir, 'cookies.txt');
  fs.writeFileSync(cookiePath, content.trim(), { encoding: 'utf-8', mode: 0o600 });
  saveSettings({ cookies_file: cookiePath, cookies_content: content });
  return cookiePath;
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
