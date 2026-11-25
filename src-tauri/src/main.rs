#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WindowEvent};
use vanta_lib::commands::*;
use vanta_lib::logging;
use vanta_lib::AppState;
use std::time::Duration;

fn main() {
    let cli_args: Vec<String> = std::env::args().collect();
    let start_minimized = cli_args.iter().any(|arg| arg == "--background");
    if let Some(pos) = cli_args.iter().position(|arg| arg == "--engine-admin") {
        if let Some(op_path) = cli_args.get(pos + 1) {
            let code = vanta_lib::engines::EngineManager::run_engine_admin_cli(op_path);
            std::process::exit(code);
        }
        std::process::exit(2);
    }

    logging::install_panic_hook();
    logging::info("startup", "Starting VANTA Download Manager desktop runtime.");

    let startup_t0 = std::time::Instant::now();
    let state = match AppState::init() {
        Ok(state) => state,
        Err(error) => {
            logging::error("startup", &format!("Fatal initialization failure: {}", error));
            eprintln!("VANTA startup error: {}", error);
            std::process::exit(1);
        }
    };
    logging::info(
        "startup",
        &format!("AppState ready in {}ms; launching window.", startup_t0.elapsed().as_millis()),
    );

    let app = match tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .setup(move |app| {
            let show_item = MenuItem::with_id(app, "show", "Open VANTA", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit VANTA", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &exit_item])?;
            let icon = app.default_window_icon().cloned().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::Other, "VANTA tray icon is not configured")
            })?;

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("VANTA Download Manager")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "exit" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            state.safe_shutdown();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            if let Some(state) = app.try_state::<AppState>() {
                // Active statuses persisted in SQLite cannot represent live worker
                // processes after a crash or forced shutdown. Recover them before
                // scheduling so stale "Downloading" tasks do not occupy slots forever.
                let _recovered = recover_interrupted_tasks(app.handle(), &state);
                let settings = state.get_settings();
                if settings.auto_resume_on_startup {
                    schedule_next(app.handle(), &state);
                }
            }

            // Re-evaluate the scheduler window periodically so start/stop boundaries
            // are enforced even when the user leaves the application running.
            let scheduler_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    scheduler_tick(&scheduler_app);
                }
            });

            if start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app_handle = window.app_handle();
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if state.get_settings().tray_minimize_on_close {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        state.safe_shutdown();
                    }
                }
            } else if matches!(event, WindowEvent::Destroyed) {
                let app_handle = window.app_handle();
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.safe_shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_tasks, create_task, import_history, pause_task, resume_task, cancel_task, retry_task,
            delete_task, delete_downloaded_file, pause_all, resume_all, clear_completed,
            clear_failed, clear_all, move_task, get_queues, create_queue, rename_queue,
            delete_queue, start_queue, stop_queue, update_queue_limits, move_tasks_to_queue, update_task_meta,
            rename_task_file, bulk_task_action, get_settings, save_settings, reset_settings,
            validate_python_executable, browse_python_executable, get_notifications,
            clear_notifications, get_engine_status, get_managed_engine_info, install_engine,
            install_all_engines, remove_managed_engine, run_diagnostics, check_engine_updates,
            update_engine, update_all_engines, inspect_url, cancel_inspection, get_cookie_status,
            validate_cookies_text, save_cookies, remove_cookies, detect_browsers,
            test_cookie_extraction, get_diagnostic_log_info, open_logs_folder,
            open_file_or_folder, select_directory, window_minimize, window_maximize_toggle,
            window_close, app_safe_shutdown, exit_app
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            logging::error("startup", &format!("Failed building Tauri runtime: {}", error));
            eprintln!("Failed to build Tauri runtime: {}", error);
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