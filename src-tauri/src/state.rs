use crate::logging;
use crate::models::{
    AppSettings, CategoryItem, DownloadTask, EngineStatusMap, NotificationItem, TaskLogEntry,
    TaskPriority, TaskStatus,
};
use crate::process;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct TrackedInspection {
    pub pid: Arc<AtomicU32>,
    pub cancelled: Arc<AtomicBool>,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub active_processes: Arc<Mutex<HashMap<String, u32>>>,
    pub active_direct_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub active_inspections: Arc<Mutex<HashMap<String, TrackedInspection>>>,
    pub cached_engine_status: Mutex<Option<(Instant, EngineStatusMap)>>,
    pub is_shutting_down: AtomicBool,
    pub is_running_diagnostics: AtomicBool,
    pub is_scanning_engines: AtomicBool,
}

impl AppState {
    pub fn app_data_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                if !local.trim().is_empty() {
                    return PathBuf::from(local).join("com.vanta.downloadmanager");
                }
            }
            if let Ok(profile) = std::env::var("USERPROFILE") {
                if !profile.trim().is_empty() {
                    return PathBuf::from(profile)
                        .join("AppData")
                        .join("Local")
                        .join("com.vanta.downloadmanager");
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
                if !xdg.trim().is_empty() {
                    return PathBuf::from(xdg).join("com.vanta.downloadmanager");
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                if !home.trim().is_empty() {
                    return PathBuf::from(home)
                        .join(".local")
                        .join("share")
                        .join("com.vanta.downloadmanager");
                }
            }
        }
        PathBuf::from(".vanta_data")
    }

    pub fn init() -> Result<Self, String> {
        let init_start = Instant::now();
        let db_dir = Self::app_data_dir();
        fs::create_dir_all(&db_dir).map_err(|e| {
            format!(
                "Failed to create app data directory '{}': {}",
                db_dir.display(),
                e
            )
        })?;
        let db_path = db_dir.join("vanta_native.db");

        let db_start = Instant::now();
        let conn = Connection::open(&db_path).map_err(|e| {
            format!(
                "Failed to open SQLite database '{}': {}",
                db_path.display(),
                e
            )
        })?;

        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;

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
                current_phase TEXT DEFAULT 'Queued',
                format_id TEXT DEFAULT 'best',
                format_note TEXT,
                ext TEXT DEFAULT 'mp4',
                is_audio_only INTEGER DEFAULT 0,
                audio_format TEXT,
                audio_bitrate TEXT,
                audio_sample_rate INTEGER,
                audio_bit_depth INTEGER,
                audio_channels INTEGER,
                is_lossy_source INTEGER DEFAULT 0,
                verified_audio_info TEXT,
                output_path TEXT NOT NULL,
                error_message TEXT,
                priority TEXT DEFAULT 'normal',
                created_at TEXT NOT NULL,
                completed_at TEXT,
                retries INTEGER DEFAULT 0,
                max_retries INTEGER DEFAULT 3,
                album TEXT,
                content_type TEXT
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
            ",
        )
        .map_err(|e| format!("Failed to initialize SQLite tables: {}", e))?;

        let migrations = [
            "ALTER TABLE tasks ADD COLUMN album TEXT",
            "ALTER TABLE tasks ADD COLUMN content_type TEXT",
            "ALTER TABLE tasks ADD COLUMN remaining_bytes INTEGER DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN percentage_known INTEGER DEFAULT 1",
            "ALTER TABLE tasks ADD COLUMN avg_speed_bytes_per_sec REAL DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN eta_seconds INTEGER",
            "ALTER TABLE tasks ADD COLUMN elapsed_seconds INTEGER DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN active_connections INTEGER DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN last_progress_at TEXT",
            "ALTER TABLE tasks ADD COLUMN video_codec TEXT",
            "ALTER TABLE tasks ADD COLUMN audio_codec TEXT",
            "ALTER TABLE tasks ADD COLUMN resolution_label TEXT",
            "ALTER TABLE tasks ADD COLUMN verified_sha256 TEXT",
            "ALTER TABLE tasks ADD COLUMN expected_sha256 TEXT",
            "ALTER TABLE tasks ADD COLUMN checksum_verified INTEGER",
            "ALTER TABLE tasks ADD COLUMN custom_filename TEXT",
            "ALTER TABLE tasks ADD COLUMN category_id TEXT",
            "ALTER TABLE tasks ADD COLUMN playlist_mode TEXT",
            "ALTER TABLE tasks ADD COLUMN logs_json TEXT",
            "ALTER TABLE tasks ADD COLUMN queue_order INTEGER DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN started_at TEXT",
        ];
        for sql in migrations {
            let _ = conn.execute(sql, []);
        }

        // Seed default categories if empty
        let cat_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))
            .unwrap_or(0);
        if cat_count == 0 {
            let defaults = vec![
                ("cat_video", "Video", "#58a6ff", vec!["mp4", "mkv", "webm", "mov", "avi", "flv", "m4v"]),
                ("cat_music", "Music & Audio", "#3fb950", vec!["mp3", "flac", "wav", "m4a", "aac", "opus", "ogg"]),
                ("cat_documents", "Documents", "#d29922", vec!["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "epub"]),
                ("cat_archives", "Archives", "#a371f7", vec!["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst"]),
                ("cat_software", "Software & Disk Images", "#f0883e", vec!["exe", "msi", "msix", "dmg", "iso", "img", "deb", "rpm", "apk", "appimage"]),
            ];
            for (id, name, color, exts) in defaults {
                let exts_json = serde_json::to_string(&exts).unwrap_or_else(|_| "[]".to_string());
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO categories (id, name, color, extensions_json, destination_dir, created_at) VALUES (?1, ?2, ?3, ?4, NULL, '2026-01-01T00:00:00.000Z')",
                    params![id, name, color, exts_json],
                );
            }
        }

        let _ = conn.execute(
            "DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')",
            [],
        );

        let _ = conn.execute(
            "UPDATE tasks SET status = 'queued', current_phase = 'Restored to queue', speed_str = '0 B/s', speed_bytes_per_sec = 0, active_connections = 0 WHERE status IN ('downloading', 'extracting', 'connecting', 'processing', 'muxing', 'verifying', 'resuming', 'pausing')",
            [],
        );

        let db_ms = db_start.elapsed().as_millis();
        logging::info(
            "state",
            &format!(
                "Initialized SQLite state at '{}' in {}ms (total AppState::init {}ms).",
                db_path.display(),
                db_ms,
                init_start.elapsed().as_millis()
            ),
        );

        Ok(Self {
            db: Mutex::new(conn),
            active_processes: Arc::new(Mutex::new(HashMap::new())),
            active_direct_cancels: Arc::new(Mutex::new(HashMap::new())),
            active_inspections: Arc::new(Mutex::new(HashMap::new())),
            cached_engine_status: Mutex::new(None),
            is_shutting_down: AtomicBool::new(false),
            is_running_diagnostics: AtomicBool::new(false),
            is_scanning_engines: AtomicBool::new(false),
        })
    }

    pub fn register_inspection(&self, request_id: &str) -> TrackedInspection {
        let tracked = TrackedInspection {
            pid: Arc::new(AtomicU32::new(0)),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let mut map = self
            .active_inspections
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.insert(request_id.to_string(), tracked.clone());
        tracked
    }

    pub fn remove_inspection(&self, request_id: &str) {
        let mut map = self
            .active_inspections
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(request_id);
    }

    pub fn cancel_inspection(&self, request_id: &str) -> bool {
        let tracked_opt = {
            let map = self
                .active_inspections
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.get(request_id).cloned()
        };

        if let Some(tracked) = tracked_opt {
            tracked.cancelled.store(true, Ordering::SeqCst);
            let pid = tracked.pid.load(Ordering::SeqCst);
            if pid != 0 {
                process::kill_process_tree(pid);
            }
            return true;
        }
        false
    }

    pub fn register_direct_cancel(&self, task_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut map = self
            .active_direct_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.insert(task_id.to_string(), Arc::clone(&flag));
        flag
    }

    pub fn trigger_direct_cancel(&self, task_id: &str) {
        let mut map = self
            .active_direct_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(flag) = map.remove(task_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn remove_direct_cancel(&self, task_id: &str) {
        let mut map = self
            .active_direct_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(task_id);
    }

    fn map_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadTask> {
        let status_str: String = row.get("status")?;
        let priority_str: String = row.get("priority")?;
        let is_audio_only_int: i32 = row.get("is_audio_only")?;
        let is_lossy_int: Option<i32> = row.get("is_lossy_source")?;
        let pct_known_int: Option<i32> = row.get("percentage_known").ok().flatten();
        let checksum_verified_int: Option<i32> = row.get("checksum_verified").ok().flatten();
        let logs_json: Option<String> = row.get("logs_json").ok().flatten();
        let logs: Vec<TaskLogEntry> = logs_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        Ok(DownloadTask {
            id: row.get("id")?,
            url: row.get("url")?,
            title: row.get("title")?,
            uploader: row.get("uploader")?,
            duration: row.get("duration")?,
            duration_string: row.get("duration_string")?,
            thumbnail: row.get("thumbnail")?,
            album: row.get("album").ok().flatten(),
            content_type: row.get("content_type").ok().flatten(),
            engine: row.get("engine")?,
            status: TaskStatus::from_str(&status_str),
            progress_percentage: row.get("progress_percentage")?,
            percentage_known: pct_known_int.map(|v| v != 0).unwrap_or(true),
            speed_str: row.get("speed_str")?,
            speed_bytes_per_sec: row.get("speed_bytes_per_sec")?,
            avg_speed_bytes_per_sec: row.get("avg_speed_bytes_per_sec").unwrap_or(0.0),
            downloaded_bytes: row.get("downloaded_bytes")?,
            total_bytes: row.get("total_bytes")?,
            remaining_bytes: row.get("remaining_bytes").unwrap_or(0),
            eta_str: row.get("eta_str")?,
            eta_seconds: row.get("eta_seconds").ok().flatten(),
            elapsed_seconds: row.get("elapsed_seconds").unwrap_or(0),
            active_connections: row.get("active_connections").unwrap_or(0),
            last_progress_at: row.get("last_progress_at").ok().flatten(),
            current_phase: row.get("current_phase")?,
            format_id: row.get("format_id")?,
            format_note: row.get("format_note")?,
            ext: row.get("ext")?,
            video_codec: row.get("video_codec").ok().flatten(),
            audio_codec: row.get("audio_codec").ok().flatten(),
            resolution_label: row.get("resolution_label").ok().flatten(),
            is_audio_only: is_audio_only_int == 1,
            audio_format: row.get("audio_format")?,
            audio_bitrate: row.get("audio_bitrate")?,
            audio_sample_rate: row.get("audio_sample_rate")?,
            audio_bit_depth: row.get("audio_bit_depth")?,
            audio_channels: row.get("audio_channels")?,
            is_lossy_source: is_lossy_int.map(|v| v == 1),
            verified_audio_info: row.get("verified_audio_info")?,
            verified_sha256: row.get("verified_sha256").ok().flatten(),
            expected_sha256: row.get("expected_sha256").ok().flatten(),
            checksum_verified: checksum_verified_int.map(|v| v != 0),
            output_path: row.get("output_path")?,
            custom_filename: row.get("custom_filename").ok().flatten(),
            category_id: row.get("category_id").ok().flatten(),
            playlist_mode: row.get("playlist_mode").ok().flatten(),
            error_message: row.get("error_message")?,
            logs,
            priority: TaskPriority::from_str(&priority_str),
            queue_order: row.get("queue_order").unwrap_or(0),
            created_at: row.get("created_at")?,
            started_at: row.get("started_at").ok().flatten(),
            completed_at: row.get("completed_at")?,
            retries: row.get("retries")?,
            max_retries: row.get("max_retries")?,
        })
    }

    pub fn get_tasks(&self) -> Vec<DownloadTask> {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT * FROM tasks ORDER BY queue_order ASC, created_at DESC") {
            Ok(s) => s,
            Err(e) => {
                logging::error("state", &format!("Failed preparing get_tasks query: {}", e));
                return Vec::new();
            }
        };

        let rows = match stmt.query_map([], Self::map_task_row) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        rows.flatten().collect()
    }

    pub fn get_task_by_id(&self, id: &str) -> Option<DownloadTask> {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare("SELECT * FROM tasks WHERE id = ?1").ok()?;
        stmt.query_row(params![id], Self::map_task_row).ok()
    }

    pub fn upsert_task(&self, task: &DownloadTask) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let logs_tail: Vec<&TaskLogEntry> = if task.logs.len() > 100 {
            task.logs[task.logs.len() - 100..].iter().collect()
        } else {
            task.logs.iter().collect()
        };
        let logs_json = serde_json::to_string(&logs_tail).unwrap_or_else(|_| "[]".to_string());

        if let Err(e) = conn.execute(
            "INSERT OR REPLACE INTO tasks (
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
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20, ?21, ?22,
                ?23, ?24, ?25, ?26, ?27, ?28,
                ?29, ?30, ?31, ?32, ?33,
                ?34, ?35, ?36, ?37, ?38,
                ?39, ?40, ?41, ?42,
                ?43, ?44, ?45, ?46, ?47, ?48,
                ?49, ?50, ?51, ?52, ?53, ?54, ?55
            )",
            params![
                task.id,
                task.url,
                task.title,
                task.uploader,
                task.duration,
                task.duration_string,
                task.thumbnail,
                task.album,
                task.content_type,
                task.engine,
                task.status.as_str(),
                task.progress_percentage,
                if task.percentage_known { 1 } else { 0 },
                task.speed_str,
                task.speed_bytes_per_sec,
                task.avg_speed_bytes_per_sec,
                task.downloaded_bytes,
                task.total_bytes,
                task.remaining_bytes,
                task.eta_str,
                task.eta_seconds,
                task.elapsed_seconds,
                task.active_connections,
                task.last_progress_at,
                task.current_phase,
                task.format_id,
                task.format_note,
                task.ext,
                task.video_codec,
                task.audio_codec,
                task.resolution_label,
                if task.is_audio_only { 1 } else { 0 },
                task.audio_format,
                task.audio_bitrate,
                task.audio_sample_rate,
                task.audio_bit_depth,
                task.audio_channels,
                task.is_lossy_source.map(|b| if b { 1 } else { 0 }),
                task.verified_audio_info,
                task.verified_sha256,
                task.expected_sha256,
                task.checksum_verified.map(|b| if b { 1 } else { 0 }),
                task.output_path,
                task.custom_filename,
                task.category_id,
                task.playlist_mode,
                task.error_message,
                logs_json,
                task.priority.as_str(),
                task.queue_order,
                task.created_at,
                task.started_at,
                task.completed_at,
                task.retries,
                task.max_retries,
            ],
        ) {
            logging::error("state", &format!("Failed upserting task '{}': {}", task.id, e));
        }
    }

    pub fn remove_task_files(task: &DownloadTask) -> bool {
        let mut removed = false;
        if !task.output_path.trim().is_empty() {
            let p = Path::new(&task.output_path);
            if p.is_file() && fs::remove_file(p).is_ok() {
                removed = true;
            }
            let part_p = PathBuf::from(format!("{}.part", task.output_path));
            if part_p.is_file() && fs::remove_file(&part_p).is_ok() {
                removed = true;
            }
        }
        removed
    }

    pub fn delete_task_with_options(&self, id: &str, delete_file_from_disk: bool) {
        if delete_file_from_disk {
            if let Some(task) = self.get_task_by_id(id) {
                Self::remove_task_files(&task);
            }
        }
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]);
    }

    pub fn delete_downloaded_file(&self, id: &str) -> bool {
        if let Some(mut task) = self.get_task_by_id(id) {
            let removed = Self::remove_task_files(&task);
            if removed {
                task.output_path = String::new();
                task.current_phase = "File removed from disk".to_string();
                self.upsert_task(&task);
            }
            return removed;
        }
        false
    }

    pub fn clear_completed_tasks_with_options(&self, delete_files: bool) {
        if delete_files {
            for t in self.get_tasks() {
                if matches!(t.status, TaskStatus::Completed | TaskStatus::Cancelled) {
                    Self::remove_task_files(&t);
                }
            }
        }
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "DELETE FROM tasks WHERE status IN ('completed', 'cancelled')",
            [],
        );
    }

    pub fn clear_failed_tasks(&self) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute("DELETE FROM tasks WHERE status = 'failed'", []);
    }

    pub fn clear_all_tasks(&self, delete_files: bool) {
        if delete_files {
            for t in self.get_tasks() {
                Self::remove_task_files(&t);
            }
        }
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute("DELETE FROM tasks", []);
    }

    pub fn move_task_order(&self, task_id: &str, direction: &str) -> Vec<DownloadTask> {
        let mut tasks = self.get_tasks();
        if let Some(idx) = tasks.iter().position(|t| t.id == task_id) {
            let swap_idx = if direction == "down" {
                idx.saturating_add(1)
            } else {
                idx.saturating_sub(1)
            };
            if swap_idx < tasks.len() && swap_idx != idx {
                tasks.swap(idx, swap_idx);
            }
        }
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        for (i, t) in tasks.iter().enumerate() {
            let _ = conn.execute(
                "UPDATE tasks SET queue_order = ?1 WHERE id = ?2",
                params![(i + 1) as i64, t.id],
            );
        }
        drop(conn);
        self.get_tasks()
    }

    pub fn rename_task_file(&self, task_id: &str, new_filename: &str) -> Result<DownloadTask, String> {
        let mut task = self
            .get_task_by_id(task_id)
            .ok_or_else(|| "Task not found.".to_string())?;
        let cleaned = crate::sanitize_filename(new_filename.trim());
        if cleaned.is_empty() {
            return Err("Filename cannot be empty.".to_string());
        }

        let current_path = Path::new(&task.output_path);
        if !task.output_path.is_empty() && current_path.is_file() {
            let dir = current_path.parent().unwrap_or_else(|| Path::new("."));
            let target_name = if Path::new(&cleaned).extension().is_some() {
                cleaned.clone()
            } else if let Some(ext) = current_path.extension().and_then(|s| s.to_str()) {
                format!("{}.{}", cleaned, ext)
            } else {
                cleaned.clone()
            };
            let target_path = dir.join(&target_name);
            if target_path != current_path {
                if target_path.exists() {
                    return Err(format!("Destination already exists: {}", target_name));
                }
                fs::rename(current_path, &target_path)
                    .map_err(|e| format!("Failed renaming file: {}", e))?;
                task.output_path = target_path.to_string_lossy().to_string();
                task.title = target_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&cleaned)
                    .to_string();
            }
        } else {
            task.custom_filename = Some(cleaned);
        }

        self.upsert_task(&task);
        Ok(task)
    }

    pub fn verify_task_checksum(
        &self,
        task_id: &str,
        expected_sha256: Option<String>,
    ) -> Result<(DownloadTask, String, Option<bool>), String> {
        let mut task = self
            .get_task_by_id(task_id)
            .ok_or_else(|| "Task not found.".to_string())?;
        let path = Path::new(&task.output_path);
        if task.output_path.is_empty() || !path.is_file() {
            return Err("Output file does not exist on disk yet.".to_string());
        }

        let mut file = fs::File::open(path).map_err(|e| format!("Failed opening file: {}", e))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let digest = hex::encode(hasher.finalize());

        let expected_clean = expected_sha256
            .or_else(|| task.expected_sha256.clone())
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());

        let matches = expected_clean.as_ref().map(|exp| exp == &digest);
        task.verified_sha256 = Some(digest.clone());
        if let Some(exp) = expected_clean {
            task.expected_sha256 = Some(exp);
        }
        task.checksum_verified = matches;
        self.upsert_task(&task);

        Ok((task, digest, matches))
    }

    pub fn get_categories(&self) -> Vec<CategoryItem> {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT id, name, color, extensions_json, destination_dir, created_at FROM categories ORDER BY created_at ASC") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([], |row| {
            let exts_raw: String = row.get(3)?;
            let extensions: Vec<String> = serde_json::from_str(&exts_raw).unwrap_or_default();
            Ok(CategoryItem {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                extensions,
                destination_dir: row.get(4)?,
                created_at: row.get(5)?,
            })
        }) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.flatten().collect()
    }

    pub fn save_category(&self, cat: CategoryItem) -> CategoryItem {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let id = if cat.id.trim().is_empty() {
            format!("cat_{}", chrono::Utc::now().timestamp_millis())
        } else {
            cat.id.clone()
        };
        let exts_json = serde_json::to_string(&cat.extensions).unwrap_or_else(|_| "[]".to_string());
        let created_at = if cat.created_at.trim().is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            cat.created_at.clone()
        };
        let _ = conn.execute(
            "INSERT OR REPLACE INTO categories (id, name, color, extensions_json, destination_dir, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, cat.name, cat.color, exts_json, cat.destination_dir, created_at],
        );
        CategoryItem {
            id,
            name: cat.name,
            color: cat.color,
            extensions: cat.extensions,
            destination_dir: cat.destination_dir,
            created_at,
        }
    }

    pub fn delete_category(&self, id: &str) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute("DELETE FROM categories WHERE id = ?1", params![id]);
    }

    pub fn get_settings(&self) -> AppSettings {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT key, value FROM settings") {
            Ok(s) => s,
            Err(_) => return AppSettings::default(),
        };
        let rows = match stmt.query_map([], |row| {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            Ok((k, v))
        }) {
            Ok(r) => r,
            Err(_) => return AppSettings::default(),
        };

        let mut map = serde_json::Map::new();
        for item in rows.flatten() {
            let (k, v) = item;
            if k == "cookies_content" || k == "enable_adult_sites" || k == "bypass_age_gate" {
                continue;
            }
            if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&v) {
                map.insert(k, json_val);
            } else {
                map.insert(k, serde_json::Value::String(v));
            }
        }

        serde_json::from_value(serde_json::Value::Object(map)).unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &AppSettings) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')",
            [],
        );
        if let Ok(val) = serde_json::to_value(settings) {
            if let Some(obj) = val.as_object() {
                for (k, v) in obj {
                    let str_val = if let Some(s) = v.as_str() {
                        s.to_string()
                    } else {
                        v.to_string()
                    };
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                        params![k, str_val],
                    );
                }
            }
        }
    }

    pub fn get_notifications(&self) -> Vec<NotificationItem> {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id, type, title, message, timestamp, task_id FROM notifications ORDER BY timestamp DESC LIMIT 50",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let rows = match stmt.query_map([], |row| {
            Ok(NotificationItem {
                id: row.get(0)?,
                r#type: row.get(1)?,
                title: row.get(2)?,
                message: row.get(3)?,
                timestamp: row.get(4)?,
                task_id: row.get(5)?,
            })
        }) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        rows.flatten().collect()
    }

    pub fn add_notification(&self, item: &NotificationItem) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "INSERT OR REPLACE INTO notifications (id, type, title, message, timestamp, task_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![item.id, item.r#type, item.title, item.message, item.timestamp, item.task_id],
        );
    }

    pub fn clear_notifications(&self) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute("DELETE FROM notifications", []);
    }

    pub fn safe_shutdown(&self) {
        let _ = self.is_shutting_down.swap(true, Ordering::SeqCst);

        let inspection_pids: Vec<u32> = {
            let mut inspections = self
                .active_inspections
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let mut pids = Vec::new();
            for (_id, tracked) in inspections.drain() {
                tracked.cancelled.store(true, Ordering::SeqCst);
                let pid = tracked.pid.load(Ordering::SeqCst);
                if pid != 0 {
                    pids.push(pid);
                }
            }
            pids
        };

        let task_pids: Vec<u32> = {
            let mut procs = self
                .active_processes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            procs.drain().map(|(_id, pid)| pid).collect()
        };

        {
            let mut directs = self
                .active_direct_cancels
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            for (_id, flag) in directs.drain() {
                flag.store(true, Ordering::SeqCst);
            }
        }

        for pid in inspection_pids.into_iter().chain(task_pids.into_iter()) {
            process::kill_process_tree(pid);
        }
    }
}
