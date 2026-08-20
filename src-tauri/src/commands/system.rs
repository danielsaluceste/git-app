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

#[tauri::command]
pub fn set_window_theme_effect(window: tauri::WebviewWindow, theme: String) {
    #[cfg(target_os = "windows")]
    {
        if theme == "glassmorphism" {
            if window_vibrancy::apply_acrylic(&window, Some((15, 17, 20, 45))).is_err() {
                if window_vibrancy::apply_mica(&window, Some(true)).is_err() {
                    let _ = window_vibrancy::apply_blur(&window, Some((15, 17, 20, 45)));
                }
            }
        } else {
            let _ = window_vibrancy::clear_acrylic(&window);
            let _ = window_vibrancy::clear_mica(&window);
            let _ = window_vibrancy::clear_tabbed(&window);
            let _ = window_vibrancy::clear_blur(&window);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if theme == "glassmorphism" {
            let _ = window_vibrancy::apply_vibrancy(
                &window,
                window_vibrancy::NSVisualEffectMaterial::HudWindow,
                Some(window_vibrancy::NSVisualEffectState::Active),
                Some(14.0),
            );
        } else {
            let _ = window_vibrancy::clear_vibrancy(&window);
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (window, theme);
    }
}
