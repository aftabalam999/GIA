mod mic_capture;
mod service_manager;

use mic_capture::{MicCaptureResult, MicPermissionResult};
use service_manager::{get_service_manager, ServiceStatus};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[tauri::command]
fn check_microphone_permission() -> MicPermissionResult {
    mic_capture::check_permission_internal()
}

#[tauri::command]
fn request_microphone_permission() -> MicPermissionResult {
    mic_capture::request_permission_internal()
}

#[tauri::command]
async fn start_microphone_test_capture(duration_secs: Option<u64>) -> Result<MicCaptureResult, String> {
    let secs = duration_secs.unwrap_or(5);
    tokio::task::spawn_blocking(move || {
        mic_capture::start_test_capture_internal(secs)
    })
    .await
    .map_err(|e| format!("Capture task execution error: {}", e))?
}

#[tauri::command]
fn stop_microphone_test_capture() {
    mic_capture::stop_test_capture_internal();
}

#[tauri::command]
fn get_service_statuses() -> Vec<ServiceStatus> {
    get_service_manager().get_statuses()
}

#[tauri::command]
fn start_local_services() -> Vec<ServiceStatus> {
    let mgr = get_service_manager();
    let _ = mgr.start_python_ai_service();
    let _ = mgr.start_backend_service();
    mgr.get_statuses()
}

#[tauri::command]
fn stop_local_services() {
    get_service_manager().shutdown_all();
}

#[tauri::command]
fn restart_service(service_name: String) -> ServiceStatus {
    let mgr = get_service_manager();
    if service_name == "python_ai_service" {
        mgr.start_python_ai_service()
    } else {
        mgr.start_backend_service()
    }
}

/// Bring the main GIA window into focus, showing and unminimizing it if necessary.
fn focus_gia_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Read the global shortcut string from gia.conf.json (embedded at compile time).
fn read_shortcut_from_config() -> String {
    let raw = include_str!("../gia.conf.json");
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("globalShortcut")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "Super+G".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut_str = read_shortcut_from_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            let handle = app.handle().clone();
            let hotkey = shortcut_str.clone();

            app.global_shortcut().on_shortcut(
                hotkey.as_str(),
                move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        focus_gia_window(&handle);
                    }
                },
            )?;

            // Automatically verify or start local AI and backend services
            println!("🚀 [Tauri Setup] Initializing local service manager...");
            let mgr = get_service_manager();
            let py_status = mgr.start_python_ai_service();
            let be_status = mgr.start_backend_service();
            println!("📊 [Tauri Setup] Python AI Service: {:?} (port: {})", py_status.status, py_status.port);
            println!("📊 [Tauri Setup] Node Backend Service: {:?} (port: {})", be_status.status, be_status.port);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_microphone_permission,
            request_microphone_permission,
            start_microphone_test_capture,
            stop_microphone_test_capture,
            get_service_statuses,
            start_local_services,
            stop_local_services,
            restart_service
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                println!("🛑 [Tauri Exit] App exit requested. Cleaning up child processes...");
                get_service_manager().shutdown_all();
            }
        });
}
