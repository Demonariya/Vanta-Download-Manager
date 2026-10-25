#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use vanta_lib::{commands, AppState};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::new(data_dir)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            app.manage(state.clone());
            commands::schedule_queue(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_tasks,
            commands::get_task,
            commands::inspect_url,
            commands::get_available_formats,
            commands::create_download_task,
            commands::start_download,
            commands::pause_task,
            commands::resume_task,
            commands::cancel_task,
            commands::retry_task,
            commands::delete_task,
            commands::pause_all_downloads,
            commands::resume_all_downloads,
            commands::clear_completed_tasks,
            commands::get_settings,
            commands::update_settings,
            commands::get_engine_status,
            commands::run_engine_diagnostics,
            commands::check_engine_updates,
            commands::update_engine,
            commands::update_all_engines,
            commands::get_notifications,
            commands::clear_notifications,
            commands::get_download_history,
            commands::open_downloaded_file,
            commands::reveal_download_in_folder,
            commands::choose_download_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running VANTA Download Manager application");
}
