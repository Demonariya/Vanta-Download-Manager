use crate::logging;
use crate::models::{
    AppSettings, DownloadTask, EngineStatusMap, NotificationItem, TaskPriority, TaskStatus,
};
use crate::process;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
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
                eta_str TEXT DEFAULT '--:--',
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

            CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                uploader TEXT,
                ext TEXT NOT NULL,
                engine TEXT NOT NULL,
                status TEXT NOT NULL,
                file_size INTEGER DEFAULT 0,
                output_path TEXT NOT NULL,
                verified_audio_info TEXT,
                completed_at TEXT NOT NULL
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

        // Safe column migrations for existing databases
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN album TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN content_type TEXT", []);

        // Scrub any legacy plaintext cookies_content row from SQLite settings
        let _ = conn.execute(
            "DELETE FROM settings WHERE key IN ('cookies_content', 'enable_adult_sites', 'bypass_age_gate')",
            [],
        );

        // Restore interrupted downloads cleanly on startup
        let _ = conn.execute(
            "UPDATE tasks SET status = 'queued', current_phase = 'Restored to queue', speed_str = '0 B/s', speed_bytes_per_sec = 0 WHERE status IN ('downloading', 'extracting', 'processing')",
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
            logging::info(
                "inspect",
                &format!("Cancelled active URL inspection request '{}'", request_id),
            );
            return true;
        }
        false
    }

    fn map_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadTask> {
        let status_str: String = row.get("status")?;
        let priority_str: String = row.get("priority")?;
        let is_audio_only_int: i32 = row.get("is_audio_only")?;
        let is_lossy_int: Option<i32> = row.get("is_lossy_source")?;

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
            speed_str: row.get("speed_str")?,
            speed_bytes_per_sec: row.get("speed_bytes_per_sec")?,
            downloaded_bytes: row.get("downloaded_bytes")?,
            total_bytes: row.get("total_bytes")?,
            eta_str: row.get("eta_str")?,
            current_phase: row.get("current_phase")?,
            format_id: row.get("format_id")?,
            format_note: row.get("format_note")?,
            ext: row.get("ext")?,
            is_audio_only: is_audio_only_int == 1,
            audio_format: row.get("audio_format")?,
            audio_bitrate: row.get("audio_bitrate")?,
            audio_sample_rate: row.get("audio_sample_rate")?,
            audio_bit_depth: row.get("audio_bit_depth")?,
            audio_channels: row.get("audio_channels")?,
            is_lossy_source: is_lossy_int.map(|v| v == 1),
            verified_audio_info: row.get("verified_audio_info")?,
            output_path: row.get("output_path")?,
            error_message: row.get("error_message")?,
            priority: TaskPriority::from_str(&priority_str),
            created_at: row.get("created_at")?,
            completed_at: row.get("completed_at")?,
            retries: row.get("retries")?,
            max_retries: row.get("max_retries")?,
        })
    }

    pub fn get_tasks(&self) -> Vec<DownloadTask> {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT * FROM tasks ORDER BY created_at DESC") {
            Ok(s) => s,
            Err(e) => {
                logging::error("state", &format!("Failed preparing get_tasks query: {}", e));
                return Vec::new();
            }
        };

        let rows = match stmt.query_map([], Self::map_task_row) {
            Ok(r) => r,
            Err(e) => {
                logging::error("state", &format!("Failed executing get_tasks query: {}", e));
                return Vec::new();
            }
        };

        rows.flatten().collect()
    }

    pub fn get_task_by_id(&self, id: &str) -> Option<DownloadTask> {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT * FROM tasks WHERE id = ?1") {
            Ok(s) => s,
            Err(e) => {
                logging::error("state", &format!("Failed preparing get_task_by_id query: {}", e));
                return None;
            }
        };

        stmt.query_row(params![id], Self::map_task_row).ok()
    }

    pub fn upsert_task(&self, task: &DownloadTask) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR REPLACE INTO tasks (
                id, url, title, uploader, duration, duration_string, thumbnail, album, content_type, engine, status,
                progress_percentage, speed_str, speed_bytes_per_sec, downloaded_bytes, total_bytes,
                eta_str, current_phase, format_id, format_note, ext, is_audio_only, audio_format,
                audio_bitrate, audio_sample_rate, audio_bit_depth, audio_channels, is_lossy_source,
                verified_audio_info, output_path, error_message, priority, created_at, completed_at,
                retries, max_retries
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20, ?21, ?22, ?23,
                ?24, ?25, ?26, ?27, ?28,
                ?29, ?30, ?31, ?32, ?33, ?34,
                ?35, ?36
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
                task.speed_str,
                task.speed_bytes_per_sec,
                task.downloaded_bytes,
                task.total_bytes,
                task.eta_str,
                task.current_phase,
                task.format_id,
                task.format_note,
                task.ext,
                if task.is_audio_only { 1 } else { 0 },
                task.audio_format,
                task.audio_bitrate,
                task.audio_sample_rate,
                task.audio_bit_depth,
                task.audio_channels,
                task.is_lossy_source.map(|b| if b { 1 } else { 0 }),
                task.verified_audio_info,
                task.output_path,
                task.error_message,
                task.priority.as_str(),
                task.created_at,
                task.completed_at,
                task.retries,
                task.max_retries,
            ],
        ) {
            logging::error("state", &format!("Failed upserting task '{}': {}", task.id, e));
        }
    }

    pub fn delete_task(&self, id: &str) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]);
    }

    pub fn clear_completed_tasks(&self) {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "DELETE FROM tasks WHERE status IN ('completed', 'cancelled', 'failed')",
            [],
        );
    }

    pub fn get_settings(&self) -> AppSettings {
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT key, value FROM settings") {
            Ok(s) => s,
            Err(e) => {
                logging::error("state", &format!("Failed reading settings: {}", e));
                return AppSettings::default();
            }
        };
        let rows = match stmt.query_map([], |row| {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            Ok((k, v))
        }) {
            Ok(r) => r,
            Err(e) => {
                logging::error("state", &format!("Failed mapping settings: {}", e));
                return AppSettings::default();
            }
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
            Err(e) => {
                logging::error("state", &format!("Failed querying notifications: {}", e));
                return Vec::new();
            }
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
        let first_invocation = !self.is_shutting_down.swap(true, Ordering::SeqCst);

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

        let total_killed = inspection_pids.len() + task_pids.len();
        if first_invocation || total_killed > 0 {
            logging::info(
                "shutdown",
                &format!(
                    "Safe shutdown invoked (first={}, active_downloads={}, active_inspections={}).",
                    first_invocation,
                    task_pids.len(),
                    inspection_pids.len()
                ),
            );
        }

        for pid in inspection_pids.into_iter().chain(task_pids.into_iter()) {
            process::kill_process_tree(pid);
        }
    }
}
