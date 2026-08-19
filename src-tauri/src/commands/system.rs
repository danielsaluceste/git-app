use tauri::{AppHandle, Manager};

/// Comando temporário usado para validar a comunicação Angular/Tauri.
#[tauri::command]
pub fn ping() -> &'static str {
    "git-app"
}

#[tauri::command]
pub fn toggle_devtools(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
}
