use crate::logging;
use crate::models::{
    AppSettings, DownloadTask, EngineStatusMap, NotificationItem, TaskLogEntry, TaskPriority,
    TaskStatus,
};
use crate::process;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
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
    pub data_dir: PathBuf,
    pub db: Mutex<Connection>,
    pub settings_file_lock: Mutex<()>,
    pub active_processes: Arc<Mutex<HashMap<String, u32>>>,
    pub active_inspections: Arc<Mutex<HashMap<String, TrackedInspection>>>,
    pub cached_engine_status: Mutex<Option<(Instant, EngineStatusMap)>>,
    pub is_shutting_down: AtomicBool,
    pub is_running_diagnostics: AtomicBool,
    pub is_scanning_engines: AtomicBool,
}

impl AppState {
    pub fn app_data_dir() -> PathBuf {
        if let Ok(override_dir) = std::env::var("VANTA_DATA_DIR") {
            let trimmed = override_dir.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                if !appdata.trim().is_empty() {
                    return PathBuf::from(appdata).join("VANTA Download Manager");
                }
            }
            if let Ok(profile) = std::env::var("USERPROFILE") {
                if !profile.trim().is_empty() {
                    return PathBuf::from(profile)
                        .join("AppData")
                        .join("Roaming")
                        .join("VANTA Download Manager");
                }
            }
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                if !local.trim().is_empty() {
                    return PathBuf::from(local).join("VANTA Download Manager");
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
                if !xdg.trim().is_empty() {
                    return PathBuf::from(xdg).join("vanta-download-manager");
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                if !home.trim().is_empty() {
                    return PathBuf::from(home)
                        .join(".local")
                        .join("share")
                        .join("vanta-download-manager");
                }
            }
        }
        PathBuf::from(".vanta_data")
    }

    fn legacy_app_data_dir() -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                if !local.trim().is_empty() {
                    return Some(PathBuf::from(local).join("com.vanta.downloadmanager"));
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
                if !xdg.trim().is_empty() {
                    return Some(PathBuf::from(xdg).join("com.vanta.downloadmanager"));
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                if !home.trim().is_empty() {
                    return Some(
                        PathBuf::from(home)
                            .join(".local")
                            .join("share")
                            .join("com.vanta.downloadmanager"),
                    );
                }
            }
        }
        None
    }

    fn migrate_legacy_user_data_if_needed(target_dir: &Path) {
        if std::env::var("VANTA_DATA_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .is_some()
        {
            return;
        }
        let Some(legacy_dir) = Self::legacy_app_data_dir() else {
            return;
        };
        if legacy_dir == target_dir || !legacy_dir.is_dir() {
            return;
        }

        let target_db = target_dir.join("vanta_native.db");
        let legacy_db = legacy_dir.join("vanta_native.db");
        if !target_db.exists() && legacy_db.is_file() {
            if let Err(e) = fs::copy(&legacy_db, &target_db) {
                logging::warn(
                    "state",
                    &format!("Legacy DB migration copy failed cleanly: {}", e),
                );
            } else {
                logging::info(
                    "state",
                    &format!(
                        "Migrated legacy user database from '{}' to '{}'",
                        legacy_db.display(),
                        target_db.display()
                    ),
                );
            }
        }

        let target_cookies = target_dir.join("cookies.txt");
        let legacy_cookies = legacy_dir.join("cookies.txt");
        if !target_cookies.exists() && legacy_cookies.is_file() {
            let _ = fs::copy(&legacy_cookies, &target_cookies);
        }
    }

    pub fn settings_file_path_for(dir: &Path) -> PathBuf {
        dir.join("settings.v1.json")
    }

    pub fn settings_file_path(&self) -> PathBuf {
        Self::settings_file_path_for(&self.data_dir)
    }

    pub fn init() -> Result<Self, String> {
        Self::init_in_dir(Self::app_data_dir())
    }

    pub fn init_in_dir(db_dir: PathBuf) -> Result<Self, String> {
        let init_start = Instant::now();
        fs::create_dir_all(&db_dir).map_err(|e| {
            format!(
                "Failed to create app data directory '{}': {}",
                db_dir.display(),
                e
            )
        })?;
        Self::migrate_legacy_user_data_if_needed(&db_dir);

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
            "ALTER TABLE tasks ADD COLUMN custom_filename TEXT",
            "ALTER TABLE tasks ADD COLUMN playlist_mode TEXT",
            "ALTER TABLE tasks ADD COLUMN selected_items_json TEXT",
            "ALTER TABLE tasks ADD COLUMN tracks_requested INTEGER",
            "ALTER TABLE tasks ADD COLUMN tracks_completed INTEGER",
            "ALTER TABLE tasks ADD COLUMN tracks_failed INTEGER",
            "ALTER TABLE tasks ADD COLUMN logs_json TEXT",
            "ALTER TABLE tasks ADD COLUMN queue_order INTEGER DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN started_at TEXT",
        ];
        for sql in migrations {
            let _ = conn.execute(sql, []);
        }

        // Preserve existing user tasks while gracefully normalizing abandoned in-flight statuses
        let _ = conn.execute(
            "DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')",
            [],
        );

        let _ = conn.execute(
            "UPDATE tasks SET status = 'queued', current_phase = 'Restored to queue', speed_str = '0 B/s', speed_bytes_per_sec = 0, active_connections = 0 WHERE status IN ('downloading', 'extracting', 'connecting', 'processing', 'muxing', 'verifying', 'resuming', 'pausing')",
            [],
        );

        let state = Self {
            data_dir: db_dir,
            db: Mutex::new(conn),
            settings_file_lock: Mutex::new(()),
            active_processes: Arc::new(Mutex::new(HashMap::new())),
            active_inspections: Arc::new(Mutex::new(HashMap::new())),
            cached_engine_status: Mutex::new(None),
            is_shutting_down: AtomicBool::new(false),
            is_running_diagnostics: AtomicBool::new(false),
            is_scanning_engines: AtomicBool::new(false),
        };

        // Ensure durable settings.v1.json exists and recovers cleanly if corrupt
        let _ = state.get_settings();

        let db_ms = db_start.elapsed().as_millis();
        logging::info(
            "state",
            &format!(
                "Initialized AppState at '{}' in {}ms (total {}ms).",
                db_path.display(),
                db_ms,
                init_start.elapsed().as_millis()
            ),
        );

        Ok(state)
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

    fn map_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadTask> {
        let status_str: String = row.get("status")?;
        let priority_str: String = row.get("priority")?;
        let is_audio_only_int: i32 = row.get("is_audio_only")?;
        let is_lossy_int: Option<i32> = row.get("is_lossy_source")?;
        let pct_known_int: Option<i32> = row.get("percentage_known").ok().flatten();
        let logs_json: Option<String> = row.get("logs_json").ok().flatten();
        let logs: Vec<TaskLogEntry> = logs_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let selected_items_json: Option<String> = row.get("selected_items_json").ok().flatten();
        let selected_items: Option<Vec<String>> = selected_items_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok());

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
            output_path: row.get("output_path")?,
            custom_filename: row.get("custom_filename").ok().flatten(),
            playlist_mode: row.get("playlist_mode").ok().flatten(),
            selected_items,
            tracks_requested: row.get("tracks_requested").ok().flatten(),
            tracks_completed: row.get("tracks_completed").ok().flatten(),
            tracks_failed: row.get("tracks_failed").ok().flatten(),
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
        let selected_items_json = task
            .selected_items
            .as_ref()
            .and_then(|items| serde_json::to_string(items).ok());

        if let Err(e) = conn.execute(
            "INSERT OR REPLACE INTO tasks (
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
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20, ?21, ?22,
                ?23, ?24, ?25, ?26, ?27, ?28,
                ?29, ?30, ?31, ?32, ?33,
                ?34, ?35, ?36, ?37, ?38,
                ?39, ?40, ?41, ?42,
                ?43, ?44, ?45, ?46,
                ?47, ?48, ?49, ?50, ?51, ?52, ?53, ?54, ?55
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
                task.output_path,
                task.custom_filename,
                task.playlist_mode,
                selected_items_json,
                task.tracks_requested,
                task.tracks_completed,
                task.tracks_failed,
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

    fn read_settings_from_sqlite_unlocked(conn: &Connection) -> Option<AppSettings> {
        let mut stmt = conn.prepare("SELECT key, value FROM settings").ok()?;
        let rows = stmt
            .query_map([], |row| {
                let k: String = row.get(0)?;
                let v: String = row.get(1)?;
                Ok((k, v))
            })
            .ok()?;

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

        if map.is_empty() {
            return None;
        }
        let mut settings: AppSettings =
            serde_json::from_value(serde_json::Value::Object(map)).unwrap_or_default();
        settings.schema_version = 1;
        Some(settings)
    }

    fn write_settings_json_atomic_locked(data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
        fs::create_dir_all(data_dir).map_err(|e| {
            format!(
                "Failed to ensure settings directory '{}': {}",
                data_dir.display(),
                e
            )
        })?;
        let target_path = Self::settings_file_path_for(data_dir);
        let temp_path = data_dir.join(format!("settings.v1.tmp.{}", uuid::Uuid::new_v4()));

        let json = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Failed serializing settings JSON: {}", e))?;

        let mut tmp_file = fs::File::create(&temp_path).map_err(|e| {
            format!(
                "Failed creating temp settings file '{}': {}",
                temp_path.display(),
                e
            )
        })?;
        tmp_file
            .write_all(json.as_bytes())
            .and_then(|_| tmp_file.sync_all())
            .map_err(|e| {
                let _ = fs::remove_file(&temp_path);
                format!(
                    "Failed writing temp settings file '{}': {}",
                    temp_path.display(),
                    e
                )
            })?;
        drop(tmp_file);

        if let Err(rename_err) = fs::rename(&temp_path, &target_path) {
            // Windows rename can fail if destination exists on older filesystems
            let backup = data_dir.join("settings.v1.prev.bak");
            let had_existing = target_path.exists();
            if had_existing {
                let _ = fs::remove_file(&backup);
                let _ = fs::rename(&target_path, &backup);
            }
            if let Err(second_err) = fs::rename(&temp_path, &target_path) {
                if had_existing && backup.exists() {
                    let _ = fs::rename(&backup, &target_path);
                }
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "Failed committing settings file '{}': {} ({})",
                    target_path.display(),
                    rename_err,
                    second_err
                ));
            }
            let _ = fs::remove_file(&backup);
        }

        Ok(())
    }

    pub fn validate_settings(settings: &AppSettings) -> Result<(), String> {
        if settings.download_dir.trim().is_empty() {
            return Err("Download destination folder cannot be empty.".to_string());
        }
        if settings.max_concurrent_downloads == 0 || settings.max_concurrent_downloads > 16 {
            return Err("Max concurrent downloads must be between 1 and 16.".to_string());
        }
        let proxy = settings.proxy_url.trim();
        if !proxy.is_empty() {
            let lower = proxy.to_ascii_lowercase();
            let valid_scheme = lower.starts_with("http://")
                || lower.starts_with("https://")
                || lower.starts_with("socks4://")
                || lower.starts_with("socks5://");
            if !valid_scheme {
                return Err(
                    "Proxy URL must start with http://, https://, socks4://, or socks5://."
                        .to_string(),
                );
            }
        }
        Ok(())
    }

    pub fn get_settings(&self) -> AppSettings {
        let _guard = self
            .settings_file_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let json_path = self.settings_file_path();

        if json_path.exists() {
            match fs::read_to_string(&json_path) {
                Ok(raw) => match serde_json::from_str::<AppSettings>(&raw) {
                    Ok(mut parsed) => {
                        parsed.schema_version = 1;
                        return parsed;
                    }
                    Err(parse_err) => {
                        let ts = chrono::Utc::now().timestamp_millis();
                        let backup_path = self
                            .data_dir
                            .join(format!("settings.v1.corrupt.{}.json", ts));
                        let _ = fs::rename(&json_path, &backup_path);
                        logging::warn(
                            "settings",
                            &format!(
                                "Detected corrupt settings file ({}); backed up to '{}' and restored defaults.",
                                parse_err,
                                backup_path.display()
                            ),
                        );
                        let defaults = AppSettings::default();
                        let _ = Self::write_settings_json_atomic_locked(&self.data_dir, &defaults);
                        return defaults;
                    }
                },
                Err(io_err) => {
                    logging::warn(
                        "settings",
                        &format!("Failed reading '{}': {}", json_path.display(), io_err),
                    );
                }
            }
        }

        let from_db = {
            let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
            Self::read_settings_from_sqlite_unlocked(&conn)
        };
        let resolved = from_db.unwrap_or_default();
        let _ = Self::write_settings_json_atomic_locked(&self.data_dir, &resolved);
        resolved
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<AppSettings, String> {
        let mut normalized = settings.clone();
        normalized.schema_version = 1;
        normalized.download_dir = normalized.download_dir.trim().to_string();
        normalized.proxy_url = normalized.proxy_url.trim().to_string();
        normalized.python_path = normalized
            .python_path
            .as_ref()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());

        Self::validate_settings(&normalized)?;

        // 1. Atomically persist versioned JSON file under per-user AppData
        {
            let _guard = self
                .settings_file_lock
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            Self::write_settings_json_atomic_locked(&self.data_dir, &normalized)?;
        }

        // 2. Sync SQLite settings table inside an atomic transaction
        {
            let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let val = serde_json::to_value(&normalized)
                .map_err(|e| format!("Failed serializing settings for SQLite: {}", e))?;
            let obj = val
                .as_object()
                .ok_or_else(|| "Settings payload must be a JSON object.".to_string())?;

            conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")
                .map_err(|e| format!("Failed starting settings transaction: {}", e))?;

            let tx_res: Result<(), String> = (|| {
                conn.execute(
                    "DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')",
                    [],
                )
                .map_err(|e| format!("Failed cleaning legacy settings keys: {}", e))?;

                if normalized.python_path.is_none() {
                    conn.execute("DELETE FROM settings WHERE key = 'python_path'", [])
                        .map_err(|e| format!("Failed clearing python_path key: {}", e))?;
                }

                for (k, v) in obj {
                    let str_val = if let Some(s) = v.as_str() {
                        s.to_string()
                    } else {
                        v.to_string()
                    };
                    conn.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                        params![k, str_val],
                    )
                    .map_err(|e| format!("Failed writing setting '{}' to SQLite: {}", k, e))?;
                }
                Ok(())
            })();

            match tx_res {
                Ok(()) => {
                    conn.execute_batch("COMMIT;")
                        .map_err(|e| format!("Failed committing settings transaction: {}", e))?;
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(e);
                }
            }
        }

        Ok(normalized)
    }

    pub fn reset_settings(&self) -> Result<AppSettings, String> {
        let defaults = AppSettings::default();
        {
            let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
            conn.execute("DELETE FROM settings", [])
                .map_err(|e| format!("Failed clearing settings table on reset: {}", e))?;
        }
        self.save_settings(&defaults)
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

        for pid in inspection_pids.into_iter().chain(task_pids.into_iter()) {
            process::kill_process_tree(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_state_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vanta_state_{}_{}", label, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_settings_atomic_save_reset_and_corrupt_recovery() {
        let dir = make_temp_state_dir("settings");
        let state = AppState::init_in_dir(dir.clone()).unwrap();

        let mut custom = state.get_settings();
        custom.max_concurrent_downloads = 7;
        custom.python_path = Some("C:\\Program Files\\Python312\\python.exe".to_string());
        custom.proxy_url = "http://127.0.0.1:8888".to_string();
        let saved = state.save_settings(&custom).unwrap();
        assert_eq!(saved.max_concurrent_downloads, 7);
        assert_eq!(
            saved.python_path.as_deref(),
            Some("C:\\Program Files\\Python312\\python.exe")
        );

        // Reload in fresh AppState instance
        let reloaded_state = AppState::init_in_dir(dir.clone()).unwrap();
        let reloaded = reloaded_state.get_settings();
        assert_eq!(reloaded.max_concurrent_downloads, 7);
        assert_eq!(
            reloaded.python_path.as_deref(),
            Some("C:\\Program Files\\Python312\\python.exe")
        );

        // Corrupt JSON recovery backs up corrupt file and restores valid defaults
        let json_path = reloaded_state.settings_file_path();
        fs::write(&json_path, "{ corrupt json :::").unwrap();
        let recovered = reloaded_state.get_settings();
        assert_eq!(recovered.schema_version, 1);
        assert_eq!(recovered.max_concurrent_downloads, 3);
        let has_backup = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains("settings.v1.corrupt."));
        assert!(has_backup, "expected corrupt backup file to be preserved");

        // Validation failure returns error and does not overwrite valid persisted settings
        let mut bad = recovered.clone();
        bad.max_concurrent_downloads = 99;
        assert!(reloaded_state.save_settings(&bad).is_err());

        // Reset to defaults works cleanly
        reloaded_state.save_settings(&custom).unwrap();
        let reset = reloaded_state.reset_settings().unwrap();
        assert_eq!(reset.max_concurrent_downloads, 3);
        assert!(reset.python_path.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_existing_tasks_preserved_without_categories_table() {
        let dir = make_temp_state_dir("legacy_tasks");
        {
            let db_path = dir.join("vanta_native.db");
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "
                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    engine TEXT NOT NULL,
                    status TEXT NOT NULL,
                    output_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    category_id TEXT
                );
                INSERT INTO tasks (id, url, title, engine, status, output_path, created_at, category_id)
                VALUES ('t_legacy', 'https://example.com/v', 'Legacy Video', 'yt-dlp', 'completed', '/tmp/v.mp4', '2026-01-01T00:00:00Z', 'cat_video');
                ",
            )
            .unwrap();
        }

        let state = AppState::init_in_dir(dir.clone()).unwrap();
        let tasks = state.get_tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "t_legacy");
        assert_eq!(tasks[0].title, "Legacy Video");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scheduler_settings_persistence_and_reset() {
        let dir = make_temp_state_dir("scheduler");
        let state = AppState::init_in_dir(dir.clone()).unwrap();

        let mut settings = state.get_settings();
        assert_eq!(settings.scheduler, SchedulerSettings::default());

        let custom_sched = SchedulerSettings {
            enabled: true,
            start_time: "02:30".to_string(),
            stop_time: "05:45".to_string(),
            pause_on_stop: false,
            days: vec![1, 3, 5],
        };
        settings.scheduler = custom_sched.clone();
        let saved = state.save_settings(&settings).unwrap();
        assert_eq!(saved.scheduler, custom_sched);

        let reloaded = AppState::init_in_dir(dir.clone()).unwrap();
        assert_eq!(reloaded.get_settings().scheduler, custom_sched);

        let reset = reloaded.reset_settings().unwrap();
        assert_eq!(reset.scheduler, SchedulerSettings::default());

        let _ = fs::remove_dir_all(&dir);
    }
}
