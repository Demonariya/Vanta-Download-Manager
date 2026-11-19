#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, RunEvent, WindowEvent};
use vanta_lib::commands::*;
use vanta_lib::logging;
use vanta_lib::AppState;

fn main() {
    logging::install_panic_hook();
    logging::info("startup", "Starting VANTA Download Manager desktop runtime.");

    let startup_t0 = std::time::Instant::now();
    let state = match AppState::init() {
        Ok(s) => s,
        Err(err) => {
            logging::error("startup", &format!("Fatal initialization failure: {}", err));
            eprintln!("VANTA startup error: {}", err);
            std::process::exit(1);
        }
    };
    logging::info(
        "startup",
        &format!(
            "AppState ready in {}ms; launching window.",
            startup_t0.elapsed().as_millis()
        ),
    );

    let app = match tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                let app_handle = window.app_handle();
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.safe_shutdown();
                }
            }
        })
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
            cancel_inspection,
            get_cookie_status,
            validate_cookies_text,
            save_cookies,
            remove_cookies,
            detect_browsers,
            test_cookie_extraction,
            get_diagnostic_log_info,
            open_logs_folder,
            open_file_or_folder,
            select_directory,
            window_minimize,
            window_maximize_toggle,
            window_close,
            app_safe_shutdown
        ])
        .build(tauri::generate_context!())
    {
        Ok(a) => a,
        Err(err) => {
            logging::error("startup", &format!("Failed building Tauri runtime: {}", err));
            eprintln!("Failed to build Tauri runtime: {}", err);
            std::process::exit(1);
        }
    };

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.safe_shutdown();
            }
        }
    });
}
