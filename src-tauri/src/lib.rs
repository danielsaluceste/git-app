mod commands;
mod config;
mod git;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::repository::inspect_repository,
            commands::repository::get_repository_references,
            commands::repository::get_repository_status,
            commands::repository::stage_repository_files,
            commands::repository::unstage_repository_files,
            commands::repository::commit_repository,
            commands::repository::get_repository_staged_diff,
            commands::repository::get_repository_file_diff,
            commands::repository::stash_repository,
            commands::repository::apply_stash,
            commands::repository::drop_stash,
            commands::repository::get_stash_files,
            commands::repository::get_stash_file_diff,
            commands::repository::get_repository_commits,
            commands::repository::get_commit_files,
            commands::repository::get_commit_file_diff,
            commands::repository::fetch_repository,
            commands::repository::pull_repository,
            commands::repository::push_repository,
            commands::repository::checkout_branch,
            commands::repository::checkout_commit,
            commands::repository::create_branch,
            commands::repository::rename_branch,
            commands::repository::delete_branch,
            commands::repository::delete_remote_branch,
            commands::system::ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
