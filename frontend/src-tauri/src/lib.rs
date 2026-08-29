use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Bring the main GIA window into focus, showing and unminimizing it if necessary.
fn focus_gia_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Show if hidden
        let _ = window.show();
        // Unminimize if minimized
        let _ = window.unminimize();
        // Bring to front and grab focus
        let _ = window.set_focus();
    }
}

/// Read the global shortcut string from gia.conf.json (embedded at compile time).
/// Falls back to "Super+G" if the file is missing or the key is not set.
fn read_shortcut_from_config() -> String {
    // Embed the config file at compile time so it ships with the binary.
    // The user can still override the setting by editing gia.conf.json and rebuilding.
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
                    // Only act on key press, not release — avoid double-fire
                    if event.state() == ShortcutState::Pressed {
                        focus_gia_window(&handle);
                    }
                },
            )?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
