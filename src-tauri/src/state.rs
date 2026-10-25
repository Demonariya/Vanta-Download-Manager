use crate::models::{AppSettings, DownloadTask, NotificationItem, TaskStatus};
use rusqlite::{params, Connection};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize},
        Arc, Mutex,
    },
};
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlAction {
    None,
    Pause,
    Cancel,
}

#[derive(Clone)]
pub struct AppState {
    pub tasks: Arc<Mutex<Vec<DownloadTask>>>,
    pub settings: Arc<Mutex<AppSettings>>,
    pub notifications: Arc<Mutex<Vec<NotificationItem>>>,
    pub db: Arc<Mutex<Connection>>,
    pub controls: Arc<Mutex<HashMap<String, watch::Sender<ControlAction>>>>,
    pub active_count: Arc<AtomicUsize>,
    pub scheduler_running: Arc<AtomicBool>,
    pub data_dir: Arc<PathBuf>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Cannot create application data directory: {e}"))?;
        let db_path = data_dir.join("vanta-native.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Cannot open application database: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS native_tasks (
                id TEXT PRIMARY KEY NOT NULL,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS native_settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS native_notifications (
                id TEXT PRIMARY KEY NOT NULL,
                payload TEXT NOT NULL,
                timestamp TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS native_history (
                id TEXT PRIMARY KEY NOT NULL,
                payload TEXT NOT NULL,
                terminal_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS native_migrations (
                key TEXT PRIMARY KEY NOT NULL
             );",
        )
        .map_err(|e| format!("Cannot initialize application database: {e}"))?;

        let history_migrated: i64 = conn.query_row(
            "SELECT COUNT(*) FROM native_migrations WHERE key='history-v1'",
            [],
            |row| row.get(0),
        ).map_err(|e| format!("Cannot inspect history migration state: {e}"))?;
        if history_migrated == 0 {
            conn.execute(
                "INSERT OR IGNORE INTO native_history(id,payload,terminal_at)
                 SELECT id, payload, COALESCE(json_extract(payload, '$.completed_at'), updated_at)
                 FROM native_tasks
                 WHERE json_extract(payload, '$.status') IN ('completed', 'failed', 'cancelled')",
                [],
            ).map_err(|e| format!("Cannot migrate existing download history: {e}"))?;
            conn.execute("INSERT INTO native_migrations(key) VALUES('history-v1')", [])
                .map_err(|e| format!("Cannot record history migration: {e}"))?;
        }

        let mut stored_tasks: Vec<DownloadTask> = {
            let mut stmt = conn
                .prepare("SELECT payload FROM native_tasks ORDER BY updated_at DESC")
                .map_err(|e| format!("Cannot read saved tasks: {e}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Cannot query saved tasks: {e}"))?;
            rows.filter_map(Result::ok)
                .filter_map(|json| serde_json::from_str(&json).ok())
                .collect()
        };

        let mut settings = AppSettings::default();
        if let Ok(json) = conn.query_row(
            "SELECT value FROM native_settings WHERE key='app'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            if let Ok(saved) = serde_json::from_str::<AppSettings>(&json) {
                settings = saved;
            }
        }
        if settings.download_dir.trim().is_empty() {
            settings.download_dir = data_dir.join("Downloads").to_string_lossy().into_owned();
        }
        fs::create_dir_all(&settings.download_dir)
            .map_err(|e| format!("Cannot create download directory: {e}"))?;

        // A process cannot survive an application restart. Reconcile interrupted tasks
        // to a truthful state before the queue scheduler sees them.
        for task in &mut stored_tasks {
            if matches!(task.status, TaskStatus::Downloading | TaskStatus::Extracting | TaskStatus::Processing | TaskStatus::Retrying) {
                if settings.auto_resume_on_startup {
                    task.status = TaskStatus::Queued;
                    task.current_phase = "Recovered after application restart".into();
                } else {
                    task.status = TaskStatus::Paused;
                    task.current_phase = "Paused after application restart".into();
                }
                task.speed_bytes_per_sec = 0.0;
                task.speed_str = "0 B/s".into();
                task.eta_str = "--:--".into();
            }
        }
        for task in &stored_tasks {
            let payload = serde_json::to_string(task).map_err(|e| format!("Cannot encode recovered task: {e}"))?;
            conn.execute(
                "INSERT INTO native_tasks(id,payload,updated_at) VALUES(?1,?2,?3)
                 ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
                params![task.id, payload, chrono::Utc::now().to_rfc3339()],
            ).map_err(|e| format!("Cannot persist recovered task: {e}"))?;
        }
        conn.execute(
            "INSERT INTO native_settings(key,value) VALUES('app',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![serde_json::to_string(&settings).map_err(|e| e.to_string())?],
        )
        .map_err(|e| format!("Cannot persist default settings: {e}"))?;

        let stored_notifications: Vec<NotificationItem> = {
            let mut stmt = conn
                .prepare("SELECT payload FROM native_notifications ORDER BY timestamp DESC LIMIT 100")
                .map_err(|e| format!("Cannot read notifications: {e}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Cannot query notifications: {e}"))?;
            rows.filter_map(Result::ok)
                .filter_map(|json| serde_json::from_str(&json).ok())
                .collect()
        };

        Ok(Self {
            tasks: Arc::new(Mutex::new(stored_tasks)),
            settings: Arc::new(Mutex::new(settings)),
            notifications: Arc::new(Mutex::new(stored_notifications)),
            db: Arc::new(Mutex::new(conn)),
            controls: Arc::new(Mutex::new(HashMap::new())),
            active_count: Arc::new(AtomicUsize::new(0)),
            scheduler_running: Arc::new(AtomicBool::new(false)),
            data_dir: Arc::new(data_dir),
        })
    }

    pub fn tasks_snapshot(&self) -> Result<Vec<DownloadTask>, String> {
        self.tasks
            .lock()
            .map(|tasks| tasks.clone())
            .map_err(|_| "Task state lock is poisoned".to_string())
    }

    pub fn task_by_id(&self, id: &str) -> Result<Option<DownloadTask>, String> {
        self.tasks
            .lock()
            .map(|tasks| tasks.iter().find(|t| t.id == id).cloned())
            .map_err(|_| "Task state lock is poisoned".to_string())
    }

    pub fn settings_snapshot(&self) -> Result<AppSettings, String> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "Settings lock is poisoned".to_string())
    }

    pub fn save_task(&self, task: DownloadTask) -> Result<(), String> {
        let json = serde_json::to_string(&task).map_err(|e| format!("Cannot encode task: {e}"))?;
        let mut db = self.db.lock().map_err(|_| "Database lock is poisoned".to_string())?;
        db.execute(
            "INSERT INTO native_tasks(id,payload,updated_at) VALUES(?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
            params![task.id, json, chrono::Utc::now().to_rfc3339()],
        ).map_err(|e| format!("Cannot save task: {e}"))?;
        if matches!(task.status, TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled) {
            let terminal_at = task.completed_at.clone().unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            db.execute(
                "INSERT INTO native_history(id,payload,terminal_at) VALUES(?1,?2,?3)
                 ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, terminal_at=excluded.terminal_at",
                params![task.id, json, terminal_at],
            ).map_err(|e| format!("Cannot save download history: {e}"))?;
        }
        drop(db);
        let mut tasks = self.tasks.lock().map_err(|_| "Task state lock is poisoned".to_string())?;
        if let Some(existing) = tasks.iter_mut().find(|entry| entry.id == task.id) {
            *existing = task;
        } else {
            tasks.push(task);
        }
        Ok(())
    }

    pub fn history_snapshot(&self) -> Result<Vec<DownloadTask>, String> {
        let db = self.db.lock().map_err(|_| "Database lock is poisoned".to_string())?;
        let mut stmt = db.prepare("SELECT payload FROM native_history ORDER BY terminal_at DESC")
            .map_err(|e| format!("Cannot read download history: {e}"))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Cannot query download history: {e}"))?;
        let mut history = Vec::new();
        for row in rows {
            let json = row.map_err(|e| format!("Cannot read history record: {e}"))?;
            let task = serde_json::from_str::<DownloadTask>(&json)
                .map_err(|e| format!("Cannot decode history record: {e}"))?;
            history.push(task);
        }
        Ok(history)
    }

    pub fn delete_history_entry(&self, id: &str) -> Result<(), String> {
        self.db.lock().map_err(|_| "Database lock is poisoned".to_string())?
            .execute("DELETE FROM native_history WHERE id=?1", params![id])
            .map_err(|e| format!("Cannot delete history entry: {e}"))?;
        Ok(())
    }

    pub fn clear_download_history(&self) -> Result<(), String> {
        self.db.lock().map_err(|_| "Database lock is poisoned".to_string())?
            .execute("DELETE FROM native_history", [])
            .map_err(|e| format!("Cannot clear download history: {e}"))?;
        Ok(())
    }

    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "Database lock is poisoned".to_string())?
            .execute("DELETE FROM native_tasks WHERE id=?1", params![id])
            .map_err(|e| format!("Cannot delete task: {e}"))?;
        self.tasks
            .lock()
            .map_err(|_| "Task state lock is poisoned".to_string())?
            .retain(|task| task.id != id);
        Ok(())
    }

    pub fn clear_completed(&self) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "Database lock is poisoned".to_string())?
            .execute(
                "DELETE FROM native_tasks WHERE json_extract(payload, '$.status') IN ('completed','cancelled')",
                [],
            )
            .map_err(|e| format!("Cannot clear task records: {e}"))?;
        // Keep completed media on disk; only clear its queue/history record.
        self.tasks
            .lock()
            .map_err(|_| "Task state lock is poisoned".to_string())?
            .retain(|task| !matches!(task.status, TaskStatus::Completed | TaskStatus::Cancelled));
        for task in self.tasks_snapshot()? {
            self.save_task(task)?;
        }
        Ok(())
    }

    pub fn save_settings(&self, settings: AppSettings) -> Result<(), String> {
        if settings.max_concurrent_downloads == 0 || settings.max_concurrent_downloads > 32 {
            return Err("Simultaneous downloads must be between 1 and 32".into());
        }
        if settings.fragment_concurrency == 0 || settings.fragment_concurrency > 64 {
            return Err("Fragment concurrency must be between 1 and 64".into());
        }
        if settings.max_retries > 20 {
            return Err("Maximum retries cannot exceed 20".into());
        }
        if settings.download_dir.trim().is_empty() {
            return Err("Download directory cannot be empty".into());
        }
        let dir = Path::new(&settings.download_dir);
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create download directory: {e}"))?;
        let json = serde_json::to_string(&settings).map_err(|e| format!("Cannot encode settings: {e}"))?;
        self.db
            .lock()
            .map_err(|_| "Database lock is poisoned".to_string())?
            .execute(
                "INSERT INTO native_settings(key,value) VALUES('app',?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![json],
            )
            .map_err(|e| format!("Cannot save settings: {e}"))?;
        *self.settings.lock().map_err(|_| "Settings lock is poisoned".to_string())? = settings;
        Ok(())
    }

    pub fn add_notification(&self, kind: &str, title: &str, message: &str, task_id: Option<String>) {
        let item = NotificationItem {
            id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            message: message.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            task_id,
        };
        if let (Ok(json), Ok(mut db)) = (serde_json::to_string(&item), self.db.lock()) {
            let _ = db.execute(
                "INSERT INTO native_notifications(id,payload,timestamp) VALUES(?1,?2,?3)",
                params![item.id, json, item.timestamp],
            );
            let _ = db.execute(
                "DELETE FROM native_notifications WHERE id NOT IN (
                    SELECT id FROM native_notifications ORDER BY timestamp DESC LIMIT 100
                )",
                [],
            );
        }
        if let Ok(mut notifications) = self.notifications.lock() {
            notifications.insert(0, item);
            notifications.truncate(100);
        }
    }

    pub fn clear_notifications(&self) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "Database lock is poisoned".to_string())?
            .execute("DELETE FROM native_notifications", [])
            .map_err(|e| format!("Cannot clear notifications: {e}"))?;
        self.notifications
            .lock()
            .map_err(|_| "Notification lock is poisoned".to_string())?
            .clear();
        Ok(())
    }

    pub fn notifications_snapshot(&self) -> Result<Vec<NotificationItem>, String> {
        self.notifications
            .lock()
            .map(|items| items.clone())
            .map_err(|_| "Notification lock is poisoned".to_string())
    }
}

#[cfg(test)]
mod history_tests {
    use super::*;
    use crate::models::{EngineType, TaskPriority};

    fn terminal_task() -> DownloadTask {
        DownloadTask {
            id: "history-test-task".into(),
            url: "https://example.com/video".into(),
            title: "Test Video".into(),
            uploader: None,
            duration: Some(60),
            duration_string: Some("00:01:00".into()),
            thumbnail: None,
            engine: EngineType::YtDlp,
            status: TaskStatus::Completed,
            progress_percentage: 100.0,
            speed_str: "0 B/s".into(),
            speed_bytes_per_sec: 0.0,
            downloaded_bytes: 100,
            total_bytes: 100,
            eta_str: "00:00".into(),
            current_phase: "Completed".into(),
            format_id: "best".into(),
            format_note: None,
            ext: "mp4".into(),
            is_audio_only: false,
            audio_format: None,
            audio_bitrate: None,
            audio_sample_rate: None,
            audio_bit_depth: None,
            audio_channels: None,
            is_lossy_source: None,
            verified_audio_info: None,
            output_path: "C:/downloads/test.mp4".into(),
            error_message: None,
            priority: TaskPriority::Normal,
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: Some(chrono::Utc::now().to_rfc3339()),
            retries: 0,
            max_retries: 3,
        }
    }

    #[test]
    fn clearing_queue_items_does_not_delete_history() {
        let dir = std::env::temp_dir().join(format!("vanta-history-test-{}", Uuid::new_v4()));
        let state = AppState::new(dir.clone()).expect("temporary state should initialize");
        state.save_task(terminal_task()).expect("task should persist");
        assert_eq!(state.history_snapshot().expect("history should load").len(), 1);
        state.clear_completed().expect("queue records should clear");
        assert!(state.tasks_snapshot().expect("tasks should load").is_empty());
        assert_eq!(state.history_snapshot().expect("history should persist").len(), 1);
        state.clear_download_history().expect("history should clear");
        assert!(state.history_snapshot().expect("history should load").is_empty());
        drop(state);
        let _ = fs::remove_dir_all(dir);
    }
}
