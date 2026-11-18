#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use vanta_lib::commands::*;
use vanta_lib::AppState;

fn main() {
    let state = AppState::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_tasks,
            create_task,
            pause_task,
            resume_task,
            cancel_task,
            retry_task,
            delete_task,
            pause_all,
            resume_all,
            clear_completed,
            get_settings,
            save_settings,
            get_notifications,
            clear_notifications,
            get_engine_status,
            get_managed_engine_info,
            install_engine,
            install_all_engines,
            run_diagnostics,
            check_engine_updates,
            update_engine,
            update_all_engines,
            inspect_url,
            save_cookies,
            open_file_or_folder,
            select_directory,
            window_minimize,
            window_maximize_toggle,
            window_close,
            app_safe_shutdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running VANTA Download Manager application");
}
