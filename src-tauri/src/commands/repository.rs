use crate::models::repository::LocalRepositoryInfo;
use std::path::PathBuf;

#[tauri::command]
pub fn inspect_repository(path: String) -> Result<LocalRepositoryInfo, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() {
        return Err("A pasta selecionada não existe ou não está acessível.".to_string());
    }

    if !repository_path.join(".git").exists() {
        return Err("A pasta selecionada não é um repositório Git válido.".to_string());
    }

    let name = repository_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Repositório local")
        .to_string();

    Ok(LocalRepositoryInfo { name, path })
}
