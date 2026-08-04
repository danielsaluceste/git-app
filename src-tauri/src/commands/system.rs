/// Comando temporário usado para validar a comunicação Angular/Tauri.
#[tauri::command]
pub fn ping() -> &'static str {
    "git-app"
}
