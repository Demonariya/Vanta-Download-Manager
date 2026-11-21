import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppSettings,
  CategoryItem,
  DownloadTask,
  NotificationItem,
  TaskLogEntry,
} from '../src/types';
import { DEFAULT_CATEGORIES } from '../src/utils/categories';
import { sanitizeFilename } from '../src/utils/engine-parser';
import { DEFAULT_SCHEDULER_SETTINGS } from '../src/utils/scheduler';

const dataDir = path.resolve(process.cwd(), '.vanta_data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'vanta.db');
const db = new DatabaseSync(dbPath);

// Initialize core schema
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

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    extensions_json TEXT NOT NULL,
    destination_dir TEXT,
    created_at TEXT NOT NULL
  );
`);

// Safe column migrations for extended telemetry & lifecycle metadata
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
  'ALTER TABLE tasks ADD COLUMN verified_sha256 TEXT',
  'ALTER TABLE tasks ADD COLUMN expected_sha256 TEXT',
  'ALTER TABLE tasks ADD COLUMN checksum_verified INTEGER',
  'ALTER TABLE tasks ADD COLUMN custom_filename TEXT',
  'ALTER TABLE tasks ADD COLUMN category_id TEXT',
  'ALTER TABLE tasks ADD COLUMN playlist_mode TEXT',
  'ALTER TABLE tasks ADD COLUMN logs_json TEXT',
  'ALTER TABLE tasks ADD COLUMN queue_order INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN started_at TEXT',
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch {
    // column already exists
  }
}

// Seed default categories once when table is empty
const categoryCountRow = db.prepare('SELECT COUNT(*) as cnt FROM categories').get() as { cnt: number };
if (!categoryCountRow || categoryCountRow.cnt === 0) {
  const insertCat = db.prepare(`
    INSERT OR IGNORE INTO categories (id, name, color, extensions_json, destination_dir, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const cat of DEFAULT_CATEGORIES) {
    insertCat.run(
      cat.id,
      cat.name,
      cat.color,
      JSON.stringify(cat.extensions),
      cat.destination_dir ?? null,
      cat.created_at
    );
  }
}

// Remove legacy plaintext cookie/circumvention settings from DB
try {
  db.exec("DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')");
} catch {}

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
  default_audio_sample_rate: undefined,
  default_audio_bit_depth: undefined,
  embed_thumbnail: true,
  embed_metadata: true,
  filename_template: '%(title)s [%(id)s].%(ext)s',
  proxy_url: '',
  floating_notifications_enabled: true,
  floating_widget_enabled: true,
  auto_dismiss_seconds: 5,
  theme: 'dark',
  auto_retry_failed: true,
  auto_resume_on_startup: true,
  clipboard_monitoring: false,
  conflict_strategy: 'rename',
  verify_media_on_complete: true,
  tray_minimize_on_close: true,
  scheduler: DEFAULT_SCHEDULER_SETTINGS,
  cookies_browser: 'auto',
  cookies_profile: undefined,
  cookies_file: undefined,
  user_agent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

if (!fs.existsSync(DEFAULT_SETTINGS.download_dir)) {
  fs.mkdirSync(DEFAULT_SETTINGS.download_dir, { recursive: true });
}

function hydrateTaskRow(r: any): DownloadTask {
  let logs: TaskLogEntry[] = [];
  if (typeof r.logs_json === 'string' && r.logs_json) {
    try {
      const parsed = JSON.parse(r.logs_json);
      if (Array.isArray(parsed)) logs = parsed;
    } catch {
      logs = [];
    }
  }

  return {
    ...r,
    is_audio_only: Boolean(r.is_audio_only),
    is_lossy_source: Boolean(r.is_lossy_source),
    percentage_known: r.percentage_known === undefined || r.percentage_known === null ? true : Boolean(r.percentage_known),
    checksum_verified:
      r.checksum_verified === null || r.checksum_verified === undefined
        ? null
        : Boolean(r.checksum_verified),
    progress_percentage: Number(r.progress_percentage || 0),
    speed_bytes_per_sec: Number(r.speed_bytes_per_sec || 0),
    avg_speed_bytes_per_sec: Number(r.avg_speed_bytes_per_sec || 0),
    downloaded_bytes: Number(r.downloaded_bytes || 0),
    total_bytes: Number(r.total_bytes || 0),
    remaining_bytes: Number(r.remaining_bytes || 0),
    eta_seconds: r.eta_seconds === null || r.eta_seconds === undefined ? null : Number(r.eta_seconds),
    elapsed_seconds: Number(r.elapsed_seconds || 0),
    active_connections: Number(r.active_connections || 0),
    queue_order: Number(r.queue_order || 0),
    retries: Number(r.retries || 0),
    max_retries: Number(r.max_retries || 3),
    logs,
  };
}

export function getSettings(): AppSettings {
  const stmt = db.prepare('SELECT key, value FROM settings');
  const rows = stmt.all() as { key: string; value: string }[];
  const settings: any = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    if (
      row.key === 'cookies_content' ||
      row.key === 'enable_adult_sites' ||
      row.key === 'bypass_age_gate'
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse(row.value);
      if (row.key === 'cookies_file' && parsed && typeof parsed === 'string' && !fs.existsSync(parsed)) {
        if (parsed === path.resolve(dataDir, 'cookies.txt')) {
          continue;
        }
      }
      settings[row.key] = parsed;
    } catch {
      settings[row.key] = row.value;
    }
  }

  return settings as AppSettings;
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const sanitizedPatch: Record<string, any> = { ...settings };
  delete sanitizedPatch.cookies_content;
  delete sanitizedPatch.enable_adult_sites;
  delete sanitizedPatch.bypass_age_gate;

  const updated: any = { ...current, ...sanitizedPatch };
  delete updated.cookies_content;
  delete updated.enable_adult_sites;
  delete updated.bypass_age_gate;

  db.exec("DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')");
  const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');

  for (const [key, val] of Object.entries(updated)) {
    if (val === undefined) {
      remove.run(key);
    } else {
      insert.run(key, JSON.stringify(val));
    }
  }

  return updated as AppSettings;
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

export function upsertTask(task: DownloadTask): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, url, title, uploader, duration, duration_string, thumbnail, album, content_type, engine, status,
      progress_percentage, percentage_known, speed_str, speed_bytes_per_sec, avg_speed_bytes_per_sec,
      downloaded_bytes, total_bytes, remaining_bytes, eta_str, eta_seconds, elapsed_seconds,
      active_connections, last_progress_at, current_phase, format_id, format_note, ext,
      video_codec, audio_codec, resolution_label, is_audio_only, audio_format,
      audio_bitrate, audio_sample_rate, audio_bit_depth, audio_channels, is_lossy_source,
      verified_audio_info, verified_sha256, expected_sha256, checksum_verified,
      output_path, custom_filename, category_id, playlist_mode, error_message, logs_json,
      priority, queue_order, created_at, started_at, completed_at, retries, max_retries
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
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
    task.verified_sha256 ?? null,
    task.expected_sha256 ?? null,
    task.checksum_verified === null || task.checksum_verified === undefined
      ? null
      : task.checksum_verified
      ? 1
      : 0,
    task.output_path ?? '',
    task.custom_filename ?? null,
    task.category_id ?? null,
    task.playlist_mode ?? null,
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

export async function verifyTaskChecksumInDb(
  taskId: string,
  expectedSha256?: string
): Promise<{ task: DownloadTask; sha256: string; matches: boolean | null }> {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error('Task not found.');
  }
  if (!task.output_path || !fs.existsSync(task.output_path) || !fs.statSync(task.output_path).isFile()) {
    throw new Error('Output file does not exist on disk yet.');
  }

  const sha256 = await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(task.output_path);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });

  const normalizedExpected = (expectedSha256 ?? task.expected_sha256 ?? '').trim().toLowerCase();
  const matches = normalizedExpected ? normalizedExpected === sha256.toLowerCase() : null;

  task.verified_sha256 = sha256;
  if (expectedSha256 !== undefined) {
    task.expected_sha256 = normalizedExpected || null;
  }
  task.checksum_verified = matches;
  task.logs = [
    ...(task.logs || []),
    {
      timestamp: new Date().toISOString(),
      level: matches === false ? ('error' as const) : ('info' as const),
      message:
        matches === null
          ? `Computed SHA-256: ${sha256}`
          : matches
          ? `SHA-256 verified OK (${sha256.slice(0, 12)}...)`
          : `SHA-256 mismatch! Expected ${normalizedExpected.slice(0, 12)}..., got ${sha256.slice(0, 12)}...`,
    },
  ].slice(-100);

  upsertTask(task);
  return { task, sha256, matches };
}

export function getCategories(): CategoryItem[] {
  const rows = db.prepare('SELECT * FROM categories ORDER BY created_at ASC').all() as any[];
  return rows.map((r) => {
    let extensions: string[] = [];
    try {
      const parsed = JSON.parse(r.extensions_json);
      if (Array.isArray(parsed)) extensions = parsed;
    } catch {
      extensions = [];
    }
    return {
      id: r.id,
      name: r.name,
      color: r.color,
      extensions,
      destination_dir: r.destination_dir || undefined,
      created_at: r.created_at,
    };
  });
}

export function saveCategory(category: Partial<CategoryItem> & { name: string }): CategoryItem {
  const id = category.id?.trim() || `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = category.created_at || new Date().toISOString();
  const color = category.color || '#58a6ff';
  const extensions = Array.isArray(category.extensions) ? category.extensions : [];
  const destDir = category.destination_dir?.trim() || null;

  db.prepare(`
    INSERT OR REPLACE INTO categories (id, name, color, extensions_json, destination_dir, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, category.name.trim(), color, JSON.stringify(extensions), destDir, createdAt);

  return {
    id,
    name: category.name.trim(),
    color,
    extensions,
    destination_dir: destDir || undefined,
    created_at: createdAt,
  };
}

export function deleteCategory(id: string): void {
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
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
