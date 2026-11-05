mod commands;
mod config;
mod git;
mod models;

use std::path::Path;
use tauri::Manager;

/// Indica se o app consegue gravar dentro do diretório (criando-o se preciso).
fn is_writable(directory: &Path) -> bool {
    if std::fs::create_dir_all(directory).is_err() {
        return false;
    }

    let probe = directory.join(".gitluna-write-probe");
    let writable = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);

    writable
}

/// Cria a janela principal.
///
/// A janela é criada em código (e não pelo `tauri.conf.json`) para controlar o
/// diretório de dados do WebView2. Por padrão ele fica em `%LOCALAPPDATA%`, mas
/// em ambientes com escrita restrita (sandbox de agentes, CI, containers) esse
/// acesso é negado, o WebView2 falha com `HRESULT(0x8000FFFF)` e **nenhuma
/// janela aparece**. Nesse caso — e somente nele — o perfil de desenvolvimento
/// passa a ficar em `target/webview-profile`, que acompanha o build.
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("GitLuna")
    .inner_size(1600.0, 900.0)
    .min_inner_size(960.0, 600.0)
    .center()
    .decorations(false)
    .shadow(true)
    .resizable(true);

    if cfg!(debug_assertions) {
        let default_is_writable = app
            .path()
            .app_local_data_dir()
            .map(|directory| is_writable(&directory))
            .unwrap_or(false);

        if !default_is_writable {
            let data_directory = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("webview-profile");
            builder = builder.data_directory(data_directory);
        }
    }

    builder.build()?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            create_main_window(app.handle())?;
            Ok(())
        })
        .manage(commands::repository::CloneProcessState::default())
        .manage(commands::github::GithubCredentialState::default())
        .manage(commands::watcher::WatcherState::default())
        .manage(commands::terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            commands::repository::inspect_repository,
            commands::repository::clone_repository,
            commands::repository::cancel_clone,
            commands::repository::get_repository_references,
            commands::repository::get_repository_remote,
            commands::repository::set_repository_remote_url,
            commands::repository::get_repository_operation,
            commands::repository::continue_repository_operation,
            commands::repository::abort_repository_operation,
            commands::repository::get_repository_signature,
            commands::repository::get_repository_status,
            commands::repository::get_repository_conflicts,
            commands::repository::resolve_repository_conflict,
            commands::repository::resolve_repository_conflict_side,
            commands::repository::stage_repository_files,
            commands::repository::unstage_repository_files,
            commands::repository::stage_repository_hunk,
            commands::repository::unstage_repository_hunk,
            commands::repository::discard_repository_file,
            commands::repository::commit_repository,
            commands::repository::get_last_commit_message,
            commands::repository::revert_commit,
            commands::repository::cherry_pick_commit,
            commands::repository::get_undo_candidate,
            commands::repository::undo_last_operation,
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
            commands::repository::get_file_blame,
            commands::repository::get_file_history,
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
            commands::github_ssh::list_ssh_keys,
            commands::github_ssh::generate_ssh_key,
            commands::github_ssh::probe_github_ssh,
            commands::github_ssh::delete_ssh_key,
            commands::watcher::watch_repository,
            commands::watcher::unwatch_repository,
            commands::system::ping,
            commands::system::toggle_devtools
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
