use tauri::WebviewWindow;

/// Arrasta a janela a partir do clique atual.
///
/// No Linux o runtime CEF não consegue usar o arrasto nativo do GTK (o clique
/// acontece dentro da janela do Chromium), então o movimento é feito via X11.
/// Nas demais plataformas delega para o runtime.
#[tauri::command]
pub fn start_window_drag(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::window_x11::start_drag(window);
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        window.start_dragging().map_err(|error| error.to_string())
    }
}
