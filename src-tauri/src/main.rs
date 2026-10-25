#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use vanta_lib::models::AppSettings;
use vanta_lib::AppState;

fn main() {
    let default_settings = AppSettings {
        download_dir: "./downloads".to_string(),
        max_concurrent_downloads: 3,
        fragment_concurrency: 4,
        global_bandwidth_limit_kbps: 0,
        per_task_bandwidth_limit_kbps: 0,
        max_retries: 3,
        retry_delay_seconds: 5,
        default_video_format: "best".to_string(),
        default_audio_format: "mp3".to_string(),
        default_audio_bitrate: "320k".to_string(),
        default_audio_bit_depth: Some(24),
        default_audio_sample_rate: Some(48000),
        embed_thumbnail: true,
        embed_metadata: true,
        filename_template: "%(title)s [%(id)s].%(ext)s".to_string(),
        proxy_url: "".to_string(),
        floating_notifications_enabled: true,
        auto_dismiss_seconds: 5,
        theme: "dark".to_string(),
        auto_retry_failed: true,
        auto_resume_on_startup: true,
    };

    let state = AppState {
        tasks: Mutex::new(Vec::new()),
        settings: Mutex::new(default_settings),
    };

    tauri::Builder::default()
        .manage(state)
        .run(tauri::generate_context!())
        .expect("error while running VANTA Download Manager application");
}
