mod commands;
mod config;
mod git;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::codex::CodexProcessState::default())
        .manage(commands::repository::CloneProcessState::default())
        .manage(commands::github::GithubCredentialState::default())
        .manage(commands::watcher::WatcherState::default())
        .manage(commands::terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            commands::codex::check_codex_cli,
            commands::codex::get_codex_models,
            commands::codex::get_codex_usage,
            commands::codex::run_codex,
            commands::codex::cancel_codex,
            commands::repository::inspect_repository,
            commands::repository::clone_repository,
            commands::repository::cancel_clone,
            commands::repository::get_repository_references,
            commands::repository::get_repository_remote,
            commands::repository::set_repository_remote_url,
            commands::repository::get_repository_operation,
            commands::repository::continue_repository_operation,
            commands::repository::abort_repository_operation,
            commands::repository::get_repository_status,
            commands::repository::get_repository_conflicts,
            commands::repository::resolve_repository_conflict,
            commands::repository::resolve_repository_conflict_side,
            commands::repository::stage_repository_files,
            commands::repository::unstage_repository_files,
            commands::repository::discard_repository_file,
            commands::repository::commit_repository,
            commands::repository::get_last_commit_message,
            commands::repository::revert_commit,
            commands::repository::get_repository_staged_diff,
            commands::repository::get_repository_file_diff,
            commands::repository::stash_repository,
            commands::repository::apply_stash,
            commands::repository::apply_stash_files,
            commands::repository::rename_stash,
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
            commands::repository::merge_branch,
            commands::repository::rebase_branch,
            commands::repository::checkout_commit,
            commands::repository::create_branch,
            commands::repository::rename_branch,
            commands::repository::delete_branch,
            commands::repository::delete_remote_branch,
            commands::repository::get_repository_tags,
            commands::repository::create_repository_tag,
            commands::repository::delete_repository_tag,
            commands::repository::push_repository_tags,
            commands::repository::push_repository_tag,
            commands::terminal::get_available_shells,
            commands::terminal::create_terminal_session,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::github::start_device_flow,
            commands::github::poll_device_flow,
            commands::github::list_repositories,
            commands::github::disconnect_account,
            commands::watcher::watch_repository,
            commands::watcher::unwatch_repository,
            commands::system::ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
