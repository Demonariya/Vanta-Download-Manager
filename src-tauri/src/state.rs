use crate::models::{
    AppSettings, DownloadTask, NotificationItem, TaskPriority, TaskStatus,
};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub active_processes: Arc<Mutex<HashMap<String, u32>>>,
    pub is_shutting_down: AtomicBool,
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

    pub fn init() -> Self {
        let db_dir = Self::app_data_dir();
        let _ = fs::create_dir_all(&db_dir);
        let db_path = db_dir.join("vanta_native.db");

        let conn = Connection::open(&db_path).expect("Failed to open SQLite database");

        // Schema initialization
        conn.execute_batch(
            "
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
                max_retries INTEGER DEFAULT 3
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
        .expect("Failed to initialize database tables");

        // Restore interrupted downloads to queued/paused on startup
        let _ = conn.execute(
            "UPDATE tasks SET status = 'queued', current_phase = 'Restored to queue' WHERE status IN ('downloading', 'extracting', 'processing')",
            [],
        );

        Self {
            db: Mutex::new(conn),
            active_processes: Arc::new(Mutex::new(HashMap::new())),
            is_shutting_down: AtomicBool::new(false),
        }
    }

    pub fn get_tasks(&self) -> Vec<DownloadTask> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM tasks ORDER BY created_at DESC")
            .unwrap();

        let rows = stmt
            .query_map([], |row| {
                let status_str: String = row.get(8)?;
                let priority_str: String = row.get(29)?;
                let is_audio_only_int: i32 = row.get(19)?;
                let is_lossy_int: Option<i32> = row.get(25)?;

                Ok(DownloadTask {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    title: row.get(2)?,
                    uploader: row.get(3)?,
                    duration: row.get(4)?,
                    duration_string: row.get(5)?,
                    thumbnail: row.get(6)?,
                    engine: row.get(7)?,
                    status: TaskStatus::from_str(&status_str),
                    progress_percentage: row.get(9)?,
                    speed_str: row.get(10)?,
                    speed_bytes_per_sec: row.get(11)?,
                    downloaded_bytes: row.get(12)?,
                    total_bytes: row.get(13)?,
                    eta_str: row.get(14)?,
                    current_phase: row.get(15)?,
                    format_id: row.get(16)?,
                    format_note: row.get(17)?,
                    ext: row.get(18)?,
                    is_audio_only: is_audio_only_int == 1,
                    audio_format: row.get(20)?,
                    audio_bitrate: row.get(21)?,
                    audio_sample_rate: row.get(22)?,
                    audio_bit_depth: row.get(23)?,
                    audio_channels: row.get(24)?,
                    is_lossy_source: is_lossy_int.map(|v| v == 1),
                    verified_audio_info: row.get(26)?,
                    output_path: row.get(27)?,
                    error_message: row.get(28)?,
                    priority: TaskPriority::from_str(&priority_str),
                    created_at: row.get(30)?,
                    completed_at: row.get(31)?,
                    retries: row.get(32)?,
                    max_retries: row.get(33)?,
                })
            })
            .unwrap();

        rows.flatten().collect()
    }

    pub fn upsert_task(&self, task: &DownloadTask) {
        let conn = self.db.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO tasks (
                id, url, title, uploader, duration, duration_string, thumbnail, engine, status,
                progress_percentage, speed_str, speed_bytes_per_sec, downloaded_bytes, total_bytes,
                eta_str, current_phase, format_id, format_note, ext, is_audio_only, audio_format,
                audio_bitrate, audio_sample_rate, audio_bit_depth, audio_channels, is_lossy_source,
                verified_audio_info, output_path, error_message, priority, created_at, completed_at,
                retries, max_retries
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                ?22, ?23, ?24, ?25, ?26,
                ?27, ?28, ?29, ?30, ?31, ?32,
                ?33, ?34
            )",
            params![
                task.id,
                task.url,
                task.title,
                task.uploader,
                task.duration,
                task.duration_string,
                task.thumbnail,
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
        );
    }

    pub fn delete_task(&self, id: &str) {
        let conn = self.db.lock().unwrap();
        let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]);
    }

    pub fn clear_completed_tasks(&self) {
        let conn = self.db.lock().unwrap();
        let _ = conn.execute(
            "DELETE FROM tasks WHERE status IN ('completed', 'cancelled', 'failed')",
            [],
        );
    }

    pub fn get_settings(&self) -> AppSettings {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM settings").unwrap();
        let rows = stmt.query_map([], |row| {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            Ok((k, v))
        }).unwrap();

        let mut map = serde_json::Map::new();

        for item in rows.flatten() {
            let (k, v) = item;
            if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&v) {
                map.insert(k, json_val);
            } else {
                map.insert(k, serde_json::Value::String(v));
            }
        }

        serde_json::from_value(serde_json::Value::Object(map)).unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &AppSettings) {
        let conn = self.db.lock().unwrap();
        if let Ok(val) = serde_json::to_value(settings) {
            if let Some(obj) = val.as_object() {
                for (k, v) in obj {
                    let str_val = if v.is_string() {
                        v.as_str().unwrap().to_string()
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
        let conn = self.db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, type, title, message, timestamp, task_id FROM notifications ORDER BY timestamp DESC LIMIT 50")
            .unwrap();

        let rows = stmt
            .query_map([], |row| {
                Ok(NotificationItem {
                    id: row.get(0)?,
                    r#type: row.get(1)?,
                    title: row.get(2)?,
                    message: row.get(3)?,
                    timestamp: row.get(4)?,
                    task_id: row.get(5)?,
                })
            })
            .unwrap();

        rows.flatten().collect()
    }

    pub fn add_notification(&self, item: &NotificationItem) {
        let conn = self.db.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO notifications (id, type, title, message, timestamp, task_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![item.id, item.r#type, item.title, item.message, item.timestamp, item.task_id],
        );
    }

    pub fn clear_notifications(&self) {
        let conn = self.db.lock().unwrap();
        let _ = conn.execute("DELETE FROM notifications", []);
    }

    pub fn safe_shutdown(&self) {
        self.is_shutting_down.store(true, Ordering::SeqCst);
        let procs = self.active_processes.lock().unwrap();
        for (_task_id, pid) in procs.iter() {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output();
            }
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .output();
            }
        }
    }
}
