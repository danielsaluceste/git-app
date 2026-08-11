use crate::commands::github;
use crate::models::repository::{
    CommitFile, ConflictFile, LocalRepositoryInfo, RepositoryCommit, RepositoryFile,
    RepositoryOperation, RepositoryReferences, RepositoryRemote, RepositoryStatus,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_DIFF_TIMEOUT: Duration = Duration::from_secs(45);
const GIT_BRANCH_OPERATION_TIMEOUT: Duration = Duration::from_secs(45);
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct CloneProcessState {
    processes: Mutex<HashMap<String, Arc<CloneProcess>>>,
}

struct CloneProcess {
    child: Mutex<std::process::Child>,
    cancelled: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneProgressPayload {
    operation_id: String,
    progress: u8,
    stage: String,
    detail: String,
    finished: bool,
    cancelled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    auto_stashed: bool,
}

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

#[tauri::command]
pub fn clone_repository(
    app: AppHandle,
    state: State<'_, CloneProcessState>,
    github_state: State<'_, github::GithubCredentialState>,
    url: String,
    destination: String,
    operation_id: String,
    workspace_id: Option<String>,
    github_user_id: Option<u64>,
) -> Result<LocalRepositoryInfo, String> {
    let remote_url = url.trim();
    if remote_url.is_empty() || remote_url.chars().any(char::is_control) {
        return Err("Informe uma URL válida para o repositório.".to_string());
    }

    let destination_path = PathBuf::from(destination.trim());
    if destination_path.as_os_str().is_empty() {
        return Err("Escolha uma pasta de destino para o repositório.".to_string());
    }

    if destination_path.exists() {
        if !destination_path.is_dir() {
            return Err("O local escolhido não é uma pasta válida.".to_string());
        }

        let has_entries = std::fs::read_dir(&destination_path)
            .map_err(|error| format!("Não foi possível acessar a pasta de destino: {error}"))?
            .next()
            .is_some();
        if has_entries {
            return Err("Escolha uma pasta vazia para clonar o repositório.".to_string());
        }
    }

    let parent = destination_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err("A pasta onde o repositório será criado não existe.".to_string());
    }

    let folder_name = destination_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Escolha um nome de pasta válido para o repositório.".to_string())?;
    let parent_path = parent.to_string_lossy().to_string();
    let args = vec![
        "clone".to_string(),
        "--progress".to_string(),
        remote_url.to_string(),
        folder_name.to_string(),
    ];

    let github_access_token = match (workspace_id.as_deref(), github_user_id) {
        (Some(workspace_id), Some(user_id)) => Some(github::get_access_token(
            &github_state,
            workspace_id,
            user_id,
        )?),
        (_, None) => None,
        _ => return Err("A conta do GitHub selecionada está incompleta.".to_string()),
    };
    let askpass = github_access_token
        .as_deref()
        .map(AskpassGuard::new)
        .transpose()?;

    emit_clone_progress(
        &app,
        &operation_id,
        0,
        "Preparando clonagem",
        "Conectando ao repositório remoto...",
        false,
        false,
    );

    let mut command = Command::new("git");
    if askpass.is_some() {
        command.arg("-c").arg("credential.helper=");
    }
    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(&parent_path)
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let (Some(askpass), Some(access_token)) = (askpass.as_ref(), github_access_token.as_deref())
    {
        command
            .env("GIT_ASKPASS", askpass.path())
            .env("ORANGIT_GITHUB_ASKPASS_TOKEN", access_token);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("Não foi possível iniciar o clone: {error}"))?;
    let process = Arc::new(CloneProcess {
        child: Mutex::new(child),
        cancelled: AtomicBool::new(false),
    });

    state
        .processes
        .lock()
        .map_err(|_| "Não foi possível controlar a operação de clone.".to_string())?
        .insert(operation_id.clone(), Arc::clone(&process));

    let (stdout, stderr) = {
        let mut child = process
            .child
            .lock()
            .map_err(|_| "Não foi possível ler a saída do clone.".to_string())?;
        (child.stdout.take(), child.stderr.take())
    };
    let stdout_thread = thread::spawn(move || drain_output(stdout));
    let stderr_output = Arc::new(Mutex::new(String::new()));
    let stderr_thread = spawn_clone_progress_reader(
        app.clone(),
        operation_id.clone(),
        stderr,
        Arc::clone(&stderr_output),
    );

    let started_at = Instant::now();
    let status = loop {
        let process_status = process
            .child
            .lock()
            .map_err(|_| "Não foi possível acompanhar o clone.".to_string())?
            .try_wait()
            .map_err(|error| format!("Não foi possível acompanhar o clone: {error}"))?;

        if let Some(status) = process_status {
            break status;
        }

        if started_at.elapsed() >= GIT_NETWORK_TIMEOUT {
            let _ = process.child.lock().map(|mut child| child.kill());
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            state
                .processes
                .lock()
                .ok()
                .and_then(|mut processes| processes.remove(&operation_id));
            return Err(
                "O clone demorou muito para responder. Verifique a conexão e tente novamente."
                    .to_string(),
            );
        }

        thread::sleep(Duration::from_millis(40));
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    let was_cancelled = process.cancelled.load(Ordering::Relaxed);
    state
        .processes
        .lock()
        .ok()
        .and_then(|mut processes| processes.remove(&operation_id));

    if was_cancelled {
        emit_clone_progress(
            &app,
            &operation_id,
            0,
            "Clonagem cancelada",
            "A operação foi interrompida.",
            true,
            true,
        );
        return Err("A clonagem foi cancelada.".to_string());
    }

    if !status.success() {
        let error = stderr_output
            .lock()
            .map(|output| output.trim().to_string())
            .unwrap_or_default();
        emit_clone_progress(
            &app,
            &operation_id,
            0,
            "Falha na clonagem",
            "Não foi possível concluir o clone.",
            true,
            false,
        );
        return Err(if error.is_empty() {
            "O Git não conseguiu clonar o repositório.".to_string()
        } else {
            error
        });
    }

    emit_clone_progress(
        &app,
        &operation_id,
        100,
        "Clone concluído",
        "Finalizando e verificando o repositório...",
        true,
        false,
    );
    inspect_repository(destination_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cancel_clone(
    state: State<'_, CloneProcessState>,
    operation_id: String,
) -> Result<(), String> {
    let process = state
        .processes
        .lock()
        .map_err(|_| "Não foi possível cancelar a clonagem.".to_string())?
        .get(&operation_id)
        .cloned()
        .ok_or_else(|| "A clonagem já foi finalizada.".to_string())?;

    process.cancelled.store(true, Ordering::Relaxed);
    if let Ok(mut child) = process.child.lock() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn get_repository_references(path: String) -> Result<RepositoryReferences, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    let current_branch = run_git(&path, &["symbolic-ref", "--short", "HEAD"]).ok();
    let mut local_branches = run_git_lines(
        &path,
        &["for-each-ref", "--format=%(refname)", "refs/heads"],
    )?
    .into_iter()
    .filter_map(|reference| reference.strip_prefix("refs/heads/").map(ToOwned::to_owned))
    .collect::<Vec<_>>();
    if let Some(branch) = current_branch.as_ref() {
        if !local_branches.iter().any(|item| item == branch) {
            local_branches.insert(0, branch.clone());
        }
    }
    let remote_branches = run_git_lines(
        &path,
        &["for-each-ref", "--format=%(refname)", "refs/remotes"],
    )?
    .into_iter()
    .filter_map(|reference| {
        reference
            .strip_prefix("refs/remotes/")
            .map(ToOwned::to_owned)
    })
    .filter(|branch| !branch.ends_with("/HEAD"))
    .collect();
    let tags = run_git_lines(
        &path,
        &["for-each-ref", "--format=%(refname:short)", "refs/tags"],
    )?;
    let stashes = run_git_lines(&path, &["stash", "list", "--format=%gd|%s"])?;

    Ok(RepositoryReferences {
        current_branch,
        local_branches,
        remote_branches,
        tags,
        stashes,
    })
}

#[tauri::command]
pub fn get_repository_remote(path: String) -> Result<RepositoryRemote, String> {
    ensure_repository(&path)?;
    let name = preferred_configured_remote(&path);
    let url = name
        .as_ref()
        .and_then(|remote| run_git(&path, &["remote", "get-url", remote]).ok());

    Ok(RepositoryRemote { name, url })
}

#[tauri::command]
pub fn set_repository_remote_url(path: String, url: String) -> Result<RepositoryRemote, String> {
    ensure_repository(&path)?;
    let normalized_url = url.trim();

    if normalized_url.is_empty() || normalized_url.chars().any(char::is_control) {
        return Err("Informe uma URL Git valida para o repositorio remoto.".to_string());
    }

    let remote = preferred_configured_remote(&path).unwrap_or_else(|| "origin".to_string());
    if preferred_configured_remote(&path).is_some() {
        run_git_with_timeout(
            &path,
            &["remote", "set-url", &remote, normalized_url],
            GIT_COMMAND_TIMEOUT,
        )?;
    } else {
        run_git_with_timeout(
            &path,
            &["remote", "add", &remote, normalized_url],
            GIT_COMMAND_TIMEOUT,
        )?;
    }

    Ok(RepositoryRemote {
        name: Some(remote),
        url: Some(normalized_url.to_string()),
    })
}

#[tauri::command]
pub fn get_repository_operation(path: String) -> Result<Option<RepositoryOperation>, String> {
    ensure_repository(&path)?;
    let Some(kind) = detect_repository_operation(&path) else {
        return Ok(None);
    };

    Ok(Some(RepositoryOperation {
        kind: kind.to_string(),
        current_branch: run_git(&path, &["symbolic-ref", "--short", "HEAD"]).ok(),
    }))
}

#[tauri::command]
pub fn continue_repository_operation(path: String, operation: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_repository_operation(&path, &operation)?;

    let args: &[&str] = match operation.as_str() {
        "merge" => &["-c", "core.editor=true", "commit", "--no-edit"],
        "rebase" => &["-c", "core.editor=true", "rebase", "--continue"],
        _ => return Err("A operação Git informada não é válida.".to_string()),
    };

    run_git_with_timeout(&path, args, GIT_BRANCH_OPERATION_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub fn abort_repository_operation(path: String, operation: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_repository_operation(&path, &operation)?;

    let args: &[&str] = match operation.as_str() {
        "merge" => &["merge", "--abort"],
        "rebase" => &["rebase", "--abort"],
        _ => return Err("A operação Git informada não é válida.".to_string()),
    };

    run_git_with_timeout(&path, args, GIT_BRANCH_OPERATION_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub fn get_repository_status(path: String) -> Result<RepositoryStatus, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    let current_branch = run_git(&path, &["symbolic-ref", "--short", "HEAD"]).ok();
    let (behind_count, ahead_count) = get_ahead_behind(&path);
    let status_output = run_git(&path, &["status", "--porcelain=v1", "--untracked-files=no"])?;
    let mut files = Vec::new();
    let mut staged_count = 0;
    let mut unstaged_count = 0;
    let mut untracked_count = 0;
    let mut conflicted_count = 0;

    for line in status_output.lines().filter(|line| !line.trim().is_empty()) {
        let bytes = line.as_bytes();
        if bytes.len() < 3 {
            continue;
        }

        let index_status = bytes[0] as char;
        let worktree_status = bytes[1] as char;
        let is_untracked = index_status == '?' && worktree_status == '?';
        let is_conflicted = is_unmerged_status(index_status, worktree_status);
        let is_staged = !is_conflicted && index_status != ' ' && index_status != '?';
        let is_unstaged = is_conflicted || (worktree_status != ' ' && worktree_status != '?');

        if is_untracked {
            untracked_count += 1;
        }
        if is_staged {
            staged_count += 1;
        }
        if is_unstaged {
            unstaged_count += 1;
        }
        if is_conflicted {
            conflicted_count += 1;
        }

        let status = if is_conflicted {
            "conflicted"
        } else if is_untracked {
            "untracked"
        } else if index_status == 'R' || worktree_status == 'R' {
            "renamed"
        } else if index_status == 'D' || worktree_status == 'D' {
            "deleted"
        } else if index_status == 'A' || worktree_status == 'A' {
            "added"
        } else {
            "modified"
        };

        files.push(RepositoryFile {
            path: line[3..].trim().to_string(),
            status: status.to_string(),
            is_staged,
            is_conflicted,
        });
    }

    let untracked_output = run_git_with_timeout(
        &path,
        &["ls-files", "--others", "--exclude-standard"],
        Duration::from_secs(2),
    )
    .unwrap_or_default();

    for path in untracked_output
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        untracked_count += 1;
        files.push(RepositoryFile {
            path: path.to_string(),
            status: "untracked".to_string(),
            is_staged: false,
            is_conflicted: false,
        });
    }

    Ok(RepositoryStatus {
        current_branch,
        is_dirty: !files.is_empty(),
        staged_count,
        unstaged_count,
        untracked_count,
        ahead_count,
        behind_count,
        conflicted_count,
        files,
    })
}

#[tauri::command]
pub fn get_repository_conflicts(path: String) -> Result<Vec<ConflictFile>, String> {
    ensure_repository(&path)?;
    let status_output = run_git(&path, &["status", "--porcelain=v1", "--untracked-files=no"])?;
    let mut conflicts = Vec::new();

    for line in status_output.lines().filter(|line| !line.trim().is_empty()) {
        let bytes = line.as_bytes();
        if bytes.len() < 3 || !is_unmerged_status(bytes[0] as char, bytes[1] as char) {
            continue;
        }

        let file_path = line[3..].trim().to_string();
        let relative_path = validate_repository_file_path(&file_path)?;
        let (base, base_exists) = read_conflict_stage(&path, &file_path, 1);
        let (ours, ours_exists) = read_conflict_stage(&path, &file_path, 2);
        let (theirs, theirs_exists) = read_conflict_stage(&path, &file_path, 3);
        let working_path = PathBuf::from(&path).join(relative_path);
        let (result, result_exists, result_is_binary) = read_working_file(&working_path);

        conflicts.push(ConflictFile {
            path: file_path,
            base: base.clone(),
            ours: ours.clone(),
            theirs: theirs.clone(),
            result,
            base_exists,
            ours_exists,
            theirs_exists,
            result_exists,
            is_binary: result_is_binary
                || base.as_bytes().contains(&0)
                || ours.as_bytes().contains(&0)
                || theirs.as_bytes().contains(&0),
        });
    }

    Ok(conflicts)
}

#[tauri::command]
pub fn resolve_repository_conflict(
    path: String,
    file_path: String,
    content: String,
    keep_file: bool,
) -> Result<(), String> {
    ensure_repository(&path)?;
    let relative_path = validate_repository_file_path(&file_path)?;
    let working_path = PathBuf::from(&path).join(relative_path);

    if keep_file {
        if content.contains('\0') {
            return Err(
                "O resultado contém dados binários inválidos para edição de texto.".to_string(),
            );
        }

        if let Some(parent) = working_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("Não foi possível preparar a pasta do arquivo: {error}")
            })?;
        }
        std::fs::write(&working_path, content.as_bytes())
            .map_err(|error| format!("Não foi possível salvar o resultado do conflito: {error}"))?;
    } else if working_path.exists() {
        std::fs::remove_file(&working_path)
            .map_err(|error| format!("Não foi possível remover o arquivo: {error}"))?;
    }

    let add_args = vec![
        "add".to_string(),
        "-u".to_string(),
        "--".to_string(),
        file_path,
    ];
    run_git_strings(&path, &add_args).map(|_| ())
}

#[tauri::command]
pub fn resolve_repository_conflict_side(
    path: String,
    file_path: String,
    side: String,
) -> Result<(), String> {
    ensure_repository(&path)?;
    let relative_path = validate_repository_file_path(&file_path)?;
    let normalized_side = side.trim().to_ascii_lowercase();
    if normalized_side != "ours" && normalized_side != "theirs" {
        return Err("Escolha uma versão válida para resolver o conflito.".to_string());
    }

    let stage = if normalized_side == "ours" { 2 } else { 3 };
    let stage_exists = read_conflict_stage(&path, &file_path, stage).1;
    if stage_exists {
        let checkout_flag = format!("--{normalized_side}");
        let checkout_args = vec![
            "checkout".to_string(),
            checkout_flag,
            "--".to_string(),
            file_path.clone(),
        ];
        run_git_strings(&path, &checkout_args).map(|_| ())?;
    } else {
        let working_path = PathBuf::from(&path).join(relative_path);
        if working_path.exists() {
            std::fs::remove_file(&working_path).map_err(|error| {
                format!("Não foi possível manter a exclusão do arquivo: {error}")
            })?;
        }
    }

    let add_args = vec![
        "add".to_string(),
        "-u".to_string(),
        "--".to_string(),
        file_path,
    ];
    run_git_strings(&path, &add_args).map(|_| ())
}

#[tauri::command]
pub fn stage_repository_files(path: String, files: Vec<String>) -> Result<(), String> {
    ensure_repository(&path)?;

    if files.is_empty() {
        return Ok(());
    }

    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(files);
    run_git_strings(&path, &args).map(|_| ())
}

#[tauri::command]
pub fn unstage_repository_files(path: String, files: Vec<String>) -> Result<(), String> {
    ensure_repository(&path)?;

    if files.is_empty() {
        return Ok(());
    }

    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(files);
    run_git_strings(&path, &args).map(|_| ())
}

#[tauri::command]
pub fn discard_repository_file(path: String, file_path: String) -> Result<(), String> {
    ensure_repository(&path)?;
    let relative_path = validate_repository_file_path(&file_path)?;

    let is_tracked = run_git_with_timeout(
        &path,
        ["ls-files", "--error-unmatch", "--", file_path.as_str()],
        GIT_COMMAND_TIMEOUT,
    )
    .is_ok();

    if is_tracked {
        let args = vec![
            "restore".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
            file_path,
        ];
        run_git_strings(&path, &args).map(|_| ())
    } else {
        let args = vec![
            "clean".to_string(),
            "-f".to_string(),
            "-d".to_string(),
            "--".to_string(),
            file_path,
        ];
        run_git_strings(&path, &args)?;

        let working_path = PathBuf::from(&path).join(relative_path);
        if working_path.exists() {
            return Err("O arquivo não rastreado não pôde ser removido.".to_string());
        }

        Ok(())
    }
}

#[tauri::command]
pub fn commit_repository(path: String, message: String, amend: bool) -> Result<(), String> {
    ensure_repository(&path)?;

    if !amend && message.trim().is_empty() {
        return Err("Digite uma mensagem para criar o commit.".to_string());
    }

    let mut args = vec!["commit".to_string()];
    if amend {
        args.push("--amend".to_string());
        if message.trim().is_empty() {
            args.push("--no-edit".to_string());
        } else {
            args.extend(["-m".to_string(), message.trim().to_string()]);
        }
    } else {
        args.extend(["-m".to_string(), message.trim().to_string()]);
    }

    run_git_strings(&path, &args).map(|_| ())
}

#[tauri::command]
pub fn get_last_commit_message(path: String) -> Result<String, String> {
    ensure_repository(&path)?;

    let message = run_git(&path, &["log", "-1", "--format=%B"])?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Este repositório ainda não possui commits.".to_string());
    }

    Ok(message.to_string())
}

#[tauri::command]
pub fn revert_commit(path: String, commit_hash: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_commit_hash(&commit_hash)?;

    let status = run_git(&path, &["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err(
            "Finalize ou guarde as alterações locais antes de desfazer um commit.".to_string(),
        );
    }

    let commit_info = run_git(&path, &["rev-list", "--parents", "-n", "1", &commit_hash])?;
    let parent_count = commit_info.split_whitespace().count().saturating_sub(1);
    if parent_count == 0 {
        return Err("Este commit não pode ser desfeito porque não possui parent.".to_string());
    }

    let mut args = vec!["revert".to_string(), "--no-edit".to_string()];
    if parent_count > 1 {
        args.extend(["-m".to_string(), "1".to_string()]);
    }
    args.push(commit_hash);

    run_git_strings(&path, &args).map(|_| ())
}

#[tauri::command]
pub async fn get_repository_staged_diff(path: String) -> Result<String, String> {
    ensure_repository(&path)?;
    let result = tauri::async_runtime::spawn_blocking(move || {

    let changed_files = run_git_with_timeout(
        &path,
        &["diff", "--cached", "--name-status"],
        GIT_DIFF_TIMEOUT,
    )?;
    let staged_file_count = changed_files
        .lines()
        .filter(|line| !line.is_empty())
        .count();
    let context = if staged_file_count > 8 {
        let summary = run_git_with_timeout(
            &path,
            &["diff", "--cached", "--stat", "--no-renames"],
            GIT_DIFF_TIMEOUT,
        )?;
        let areas = summarize_changed_areas(&changed_files);
        format!(
            "ALTERACAO AMPLA: {staged_file_count} arquivos staged.\nAREAS AFETADAS: {areas}\n\nLista completa de arquivos e status:\n{changed_files}\n\nResumo das alteracoes por arquivo:\n{summary}\n\nPara esta alteracao ampla, considere todas as areas e nao um arquivo individual."
        )
    } else {
        let diff = run_git_with_timeout(
            &path,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=0",
            ],
            GIT_DIFF_TIMEOUT,
        )?;
        format!(
            "Arquivos staged e seus status:\n{changed_files}\n\nDetalhes das alteracoes:\n{diff}"
        )
    };
    // O modelo local e pequeno. Manter o contexto compacto evita exceder a
    // janela de tokens quando muitos arquivos sao preparados de uma vez.
    let max_chars = 10_000;

    if context.chars().count() <= max_chars {
        return Ok(context);
    }

    let mut truncated: String = context.chars().take(max_chars).collect();
    truncated.push_str("\n\n[Diff truncado para gerar a mensagem do commit]");
    Ok(truncated)
    })
    .await
    .map_err(|error| format!("Falha ao preparar as alterações para a IA: {error}"))?;

    result
}

#[tauri::command]
pub fn get_repository_file_diff(
    path: String,
    file_path: String,
    staged: bool,
) -> Result<String, String> {
    ensure_repository(&path)?;

    if file_path.trim().is_empty() {
        return Err("O arquivo selecionado não é válido.".to_string());
    }

    let mut args = vec!["diff".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    args.extend([
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--unified=3".to_string(),
        "--".to_string(),
        file_path,
    ]);

    let diff = run_git_with_timeout(&path, &args, GIT_DIFF_TIMEOUT)?;
    let max_chars = 30_000;

    if diff.chars().count() <= max_chars {
        return Ok(diff);
    }

    let mut truncated: String = diff.chars().take(max_chars).collect();
    truncated.push_str("\n\n[Diff truncado para visualização]");
    Ok(truncated)
}

#[tauri::command]
pub fn stash_repository(
    path: String,
    message: Option<String>,
    file_paths: Option<Vec<String>>,
) -> Result<(), String> {
    ensure_repository(&path)?;

    let status_output = run_git(&path, &["status", "--porcelain", "--untracked-files=all"])?;
    if status_output.trim().is_empty() {
        return Err("Não há alterações para guardar no stash.".to_string());
    }

    let mut args = vec![
        "stash".to_string(),
        "push".to_string(),
        "--include-untracked".to_string(),
    ];
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        args.push("--message".to_string());
        args.push(message);
    }

    if let Some(file_paths) = file_paths {
        let selected_paths = validate_worktree_file_selection(&path, file_paths)?;
        args.push("--".to_string());
        args.extend(selected_paths);
    }

    run_git_strings(&path, &args).map(|_| ())
}

#[tauri::command]
pub fn apply_stash(path: String, stash_ref: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;
    run_git_with_timeout(
        &path,
        &["stash", "apply", "--index", &stash_ref],
        GIT_COMMAND_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn apply_stash_files(
    path: String,
    stash_ref: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;

    let selected_paths = validate_stash_file_selection(&path, &stash_ref, file_paths)?;
    for file_path in selected_paths {
        let source = if stash_contains_path(&path, &stash_ref, &file_path) {
            stash_ref.clone()
        } else {
            let untracked_parent = format!("{stash_ref}^3");
            if stash_contains_path(&path, &untracked_parent, &file_path) {
                untracked_parent
            } else {
                stash_ref.clone()
            }
        };

        let args = vec![
            "restore".to_string(),
            "--source".to_string(),
            source,
            "--staged".to_string(),
            "--worktree".to_string(),
            "--no-overlay".to_string(),
            "--".to_string(),
            file_path,
        ];
        run_git_strings(&path, &args)?;
    }

    Ok(())
}

#[tauri::command]
pub fn rename_stash(path: String, stash_ref: String, message: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;

    let message = message.trim();
    if message.is_empty() {
        return Err("A mensagem do stash não pode ficar vazia.".to_string());
    }

    let stash_index = parse_stash_index(&stash_ref)?;
    let stash_hash = run_git(&path, &["rev-parse", &stash_ref])?;
    let stash_hash = stash_hash.trim();
    if stash_hash.is_empty() {
        return Err("Não foi possível identificar o stash selecionado.".to_string());
    }

    let store_args = vec![
        "stash".to_string(),
        "store".to_string(),
        "--message".to_string(),
        message.to_string(),
        stash_hash.to_string(),
    ];
    run_git_strings(&path, &store_args)?;

    let previous_stash_ref = format!("stash@{{{}}}", stash_index + 1);
    run_git_with_timeout(
        &path,
        ["stash", "drop", "--quiet", previous_stash_ref.as_str()],
        GIT_COMMAND_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn drop_stash(path: String, stash_ref: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;
    run_git_with_timeout(
        &path,
        &["stash", "drop", "--quiet", &stash_ref],
        GIT_COMMAND_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn get_stash_files(path: String, stash_ref: String) -> Result<Vec<CommitFile>, String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;

    let base_commit = format!("{stash_ref}^1");
    let tracked_output = run_git(
        &path,
        &[
            "diff",
            "--name-status",
            "--find-renames",
            &base_commit,
            &stash_ref,
        ],
    )?;
    let untracked_parent = format!("{stash_ref}^3");
    let untracked_output = run_git(
        &path,
        &[
            "diff",
            "--name-status",
            "--find-renames",
            &untracked_parent,
            &stash_ref,
        ],
    )
    .unwrap_or_default();
    let output = format!("{tracked_output}\n{untracked_output}");

    let files = output
        .lines()
        .filter_map(|line| {
            let (status_code, path) = line.split_once('\t')?;
            if path.trim().is_empty() {
                return None;
            }

            let status = match status_code.trim().chars().next()? {
                'A' => "added",
                'D' => "deleted",
                'R' => "renamed",
                '?' => "untracked",
                _ => "modified",
            };

            Some(CommitFile {
                path: path.trim().to_string(),
                status: status.to_string(),
            })
        })
        .collect();

    Ok(files)
}

#[tauri::command]
pub fn get_stash_file_diff(
    path: String,
    stash_ref: String,
    file_path: String,
) -> Result<String, String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;

    if file_path.trim().is_empty() {
        return Err("O arquivo selecionado não é válido.".to_string());
    }

    let stash_commit = stash_ref.clone();
    let base_commit = format!("{stash_ref}^1");
    let tracked_args = vec![
        "diff".to_string(),
        "--patch".to_string(),
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--unified=3".to_string(),
        base_commit,
        stash_commit.clone(),
        "--".to_string(),
        file_path.clone(),
    ];
    let mut diff = run_git_strings(&path, &tracked_args)?;

    if diff.trim().is_empty() {
        let untracked_parent = format!("{stash_ref}^3");
        let untracked_args = vec![
            "diff".to_string(),
            "--patch".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--unified=3".to_string(),
            untracked_parent,
            stash_commit,
            "--".to_string(),
            file_path,
        ];
        diff = run_git_strings(&path, &untracked_args).unwrap_or_default();
    }

    let max_chars = 30_000;

    if diff.chars().count() <= max_chars {
        return Ok(diff);
    }

    let mut truncated: String = diff.chars().take(max_chars).collect();
    truncated.push_str("\n\n[Diff truncado para visualização]");
    Ok(truncated)
}

fn summarize_changed_areas(changed_files: &str) -> String {
    const GENERIC_DIRECTORIES: [&str; 18] = [
        "src",
        "app",
        "lib",
        "libs",
        "source",
        "core",
        "shared",
        "common",
        "components",
        "pages",
        "services",
        "models",
        "utils",
        "features",
        "test",
        "tests",
        "spec",
        "__tests__",
    ];
    let mut areas = Vec::new();

    for line in changed_files.lines() {
        let path = line
            .split_once('\t')
            .map(|(_, path)| path)
            .unwrap_or(line)
            .replace('\\', "/")
            .to_ascii_lowercase();

        let is_root_config = !path.contains('/')
            && (path.ends_with(".json") || path.ends_with(".lock") || path.ends_with(".toml"));
        let area = if is_root_config {
            "configuracao".to_string()
        } else {
            let candidate = path
                .split('/')
                .find(|part| !GENERIC_DIRECTORIES.contains(part))
                .unwrap_or("aplicacao");
            let candidate = candidate
                .split('.')
                .next()
                .unwrap_or(candidate)
                .replace(['-', '_'], " ");
            candidate.trim().to_string()
        };

        if !area.is_empty() && !areas.contains(&area) {
            areas.push(area);
        }
    }

    areas.join(", ")
}

#[tauri::command]
pub fn get_repository_commits(
    path: String,
    all_branches: bool,
    skip: usize,
    limit: usize,
) -> Result<Vec<RepositoryCommit>, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    let safe_limit = limit.clamp(1, 500);
    let mut arguments = vec!["log".to_string()];
    if all_branches {
        arguments.push("--all".to_string());
    }
    arguments.extend([
        format!("--skip={skip}"),
        format!("--max-count={safe_limit}"),
        "--date=iso-strict".to_string(),
        "--decorate=short".to_string(),
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%D%x1e".to_string(),
    ]);
    let argument_refs = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    let log = run_git(&path, &argument_refs)?;

    let commits = log
        .split('\x1e')
        .filter_map(|record| {
            let fields: Vec<&str> = record.trim().split('\x1f').collect();
            if fields.len() < 8 || fields[0].is_empty() {
                return None;
            }

            Some(RepositoryCommit {
                hash: fields[0].to_string(),
                short_hash: fields[1].to_string(),
                subject: fields[2].to_string(),
                author_name: fields[3].to_string(),
                author_email: fields[4].to_string(),
                date: fields[5].to_string(),
                parents: fields[6]
                    .split_whitespace()
                    .map(ToOwned::to_owned)
                    .collect(),
                references: fields[7]
                    .split(',')
                    .map(str::trim)
                    .filter(|reference| !reference.is_empty())
                    .map(ToOwned::to_owned)
                    .collect(),
            })
        })
        .collect();

    Ok(commits)
}

#[tauri::command]
pub fn get_commit_files(path: String, commit_hash: String) -> Result<Vec<CommitFile>, String> {
    ensure_repository(&path)?;
    validate_commit_hash(&commit_hash)?;

    let output = if let Some(parent) = get_commit_first_parent(&path, &commit_hash)? {
        let args = [
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "--find-renames",
            "-r",
            parent.as_str(),
            commit_hash.as_str(),
        ];
        run_git_with_timeout(&path, args, GIT_COMMAND_TIMEOUT)?
    } else {
        run_git_with_timeout(
            &path,
            [
                "show",
                "--format=",
                "--name-status",
                "--find-renames",
                commit_hash.as_str(),
            ],
            GIT_COMMAND_TIMEOUT,
        )?
    };

    let files = output
        .lines()
        .filter_map(|line| {
            let (status_code, path) = line.split_once('\t')?;
            if path.trim().is_empty() {
                return None;
            }

            let status = match status_code.chars().next()? {
                'A' => "added",
                'D' => "deleted",
                'R' => "renamed",
                _ => "modified",
            };

            Some(CommitFile {
                path: path.trim().to_string(),
                status: status.to_string(),
            })
        })
        .collect();

    Ok(files)
}

#[tauri::command]
pub fn get_commit_file_diff(
    path: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    ensure_repository(&path)?;
    validate_commit_hash(&commit_hash)?;

    if file_path.trim().is_empty() {
        return Err("O arquivo selecionado não é válido.".to_string());
    }

    let args = if let Some(parent) = get_commit_first_parent(&path, &commit_hash)? {
        vec![
            "diff".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--unified=3".to_string(),
            parent,
            commit_hash,
            "--".to_string(),
            file_path,
        ]
    } else {
        vec![
            "show".to_string(),
            "--format=".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--unified=3".to_string(),
            commit_hash,
            "--".to_string(),
            file_path,
        ]
    };
    let diff = run_git_with_timeout(&path, &args, GIT_DIFF_TIMEOUT)?;
    let max_chars = 30_000;

    if diff.chars().count() <= max_chars {
        return Ok(diff);
    }

    let mut truncated: String = diff.chars().take(max_chars).collect();
    truncated.push_str("\n\n[Diff truncado para visualização]");
    Ok(truncated)
}

#[tauri::command]
pub async fn fetch_repository(
    path: String,
    github_state: State<'_, github::GithubCredentialState>,
    workspace_id: Option<String>,
    github_user_id: Option<u64>,
) -> Result<(), String> {
    ensure_repository(&path)?;
    let access_token = sync_access_token(&github_state, workspace_id, github_user_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_git_with_access_token(
            &path,
            &["fetch", "--all", "--prune"],
            GIT_NETWORK_TIMEOUT,
            access_token.as_deref(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| format!("Falha ao executar o Fetch em segundo plano: {error}"))?;

    result
}

#[tauri::command]
pub async fn pull_repository(
    path: String,
    github_state: State<'_, github::GithubCredentialState>,
    workspace_id: Option<String>,
    github_user_id: Option<u64>,
) -> Result<PullResult, String> {
    ensure_repository(&path)?;
    let access_token = sync_access_token(&github_state, workspace_id, github_user_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let auto_stashed = !run_git(&path, &["status", "--porcelain", "--untracked-files=all"])?
            .trim()
            .is_empty();

        run_git_with_access_token(
            &path,
            &["pull", "--rebase", "--autostash"],
            GIT_NETWORK_TIMEOUT,
            access_token.as_deref(),
        )
        .map(|_| PullResult { auto_stashed })
    })
    .await
    .map_err(|error| format!("Falha ao executar o Pull em segundo plano: {error}"))?;

    result
}

#[tauri::command]
pub async fn push_repository(
    path: String,
    github_state: State<'_, github::GithubCredentialState>,
    workspace_id: Option<String>,
    github_user_id: Option<u64>,
) -> Result<(), String> {
    ensure_repository(&path)?;
    let access_token = sync_access_token(&github_state, workspace_id, github_user_id)?;

    let current_branch = run_git(&path, &["symbolic-ref", "--short", "HEAD"]).map_err(|_| {
        "Não é possível fazer push enquanto o repositório estiver em detached HEAD.".to_string()
    })?;

    if run_git(
        &path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .is_ok()
    {
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_git_with_access_token(
                &path,
                &["push"],
                GIT_NETWORK_TIMEOUT,
                access_token.as_deref(),
            )
            .map(|_| ())
        })
        .await
        .map_err(|error| format!("Falha ao executar o Push em segundo plano: {error}"))?;

        return result;
    }

    let remote = preferred_push_remote(&path)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_git_with_access_token(
            &path,
            &["push", "--set-upstream", &remote, &current_branch],
            GIT_NETWORK_TIMEOUT,
            access_token.as_deref(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| format!("Falha ao executar o Push em segundo plano: {error}"))?;

    result
}

fn sync_access_token(
    state: &github::GithubCredentialState,
    workspace_id: Option<String>,
    github_user_id: Option<u64>,
) -> Result<Option<String>, String> {
    match (workspace_id, github_user_id) {
        (Some(workspace_id), Some(user_id)) => {
            github::get_access_token(state, &workspace_id, user_id).map(Some)
        }
        (None, None) => Ok(None),
        _ => Err("A autenticação GitHub deste repositório está incompleta.".to_string()),
    }
}

#[tauri::command]
pub fn checkout_branch(path: String, branch: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &branch)?;
    run_git_with_timeout(&path, &["checkout", &branch], GIT_COMMAND_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub fn merge_branch(
    path: String,
    source_branch: String,
    target_branch: String,
) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &source_branch)?;
    validate_branch_name(&path, &target_branch)?;

    if source_branch == target_branch {
        return Err(
            "A branch de origem e a branch de destino precisam ser diferentes.".to_string(),
        );
    }

    run_git_with_timeout(
        &path,
        &["checkout", &target_branch],
        GIT_BRANCH_OPERATION_TIMEOUT,
    )?;
    run_git_with_timeout(
        &path,
        &["merge", "--no-edit", &source_branch],
        GIT_BRANCH_OPERATION_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn rebase_branch(
    path: String,
    source_branch: String,
    target_branch: String,
) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &source_branch)?;
    validate_branch_name(&path, &target_branch)?;

    if source_branch == target_branch {
        return Err(
            "A branch de origem e a branch de destino precisam ser diferentes.".to_string(),
        );
    }

    run_git_with_timeout(
        &path,
        &["checkout", &source_branch],
        GIT_BRANCH_OPERATION_TIMEOUT,
    )?;
    run_git_with_timeout(
        &path,
        &["rebase", &target_branch],
        GIT_BRANCH_OPERATION_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn checkout_commit(path: String, commit_hash: String) -> Result<(), String> {
    ensure_repository(&path)?;

    if is_running_development_repository(&path) {
        return Err(
            "Não é possível fazer checkout no próprio repositório do OranGIT enquanto o app está rodando em modo de desenvolvimento. Use outro clone ou uma versão compilada do app.".to_string(),
        );
    }

    validate_commit_hash(&commit_hash)?;
    run_git_with_timeout(
        &path,
        &["checkout", "--detach", &commit_hash],
        GIT_COMMAND_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn create_branch(
    path: String,
    branch: String,
    start_point: Option<String>,
) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &branch)?;

    let start_point = start_point.filter(|value| !value.trim().is_empty());
    let is_remote_branch = start_point.as_ref().is_some_and(|value| {
        let remote_reference = format!("refs/remotes/{value}");
        run_git(
            &path,
            &["show-ref", "--verify", "--quiet", &remote_reference],
        )
        .is_ok()
    });

    let mut args = vec!["checkout".to_string()];
    if is_remote_branch {
        args.push("--track".to_string());
    }
    args.push("-b".to_string());
    args.push(branch);

    if let Some(start_point) = start_point {
        validate_start_point(&path, &start_point)?;
        args.push(start_point);
    }

    run_git_with_timeout(&path, &args, GIT_COMMAND_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub fn rename_branch(path: String, current_name: String, new_name: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &current_name)?;
    validate_branch_name(&path, &new_name)?;
    run_git_with_timeout(
        &path,
        &["branch", "--move", &current_name, &new_name],
        GIT_COMMAND_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn delete_branch(path: String, branch: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &branch)?;
    run_git_with_timeout(&path, &["branch", "--delete", &branch], GIT_COMMAND_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub fn delete_remote_branch(path: String, remote_branch: String) -> Result<(), String> {
    ensure_repository(&path)?;

    let (remote, branch) = remote_branch.split_once('/').ok_or_else(|| {
        "A referência remota selecionada não possui um remoto válido.".to_string()
    })?;

    if remote.trim().is_empty() || branch.trim().is_empty() {
        return Err("A referência remota selecionada não é válida.".to_string());
    }

    validate_branch_name(&path, branch)?;
    run_git(&path, &["remote", "get-url", remote])
        .map_err(|_| format!("O remoto '{remote}' não está configurado neste repositório."))?;

    run_git_with_timeout(
        &path,
        &["push", remote, "--delete", branch],
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| ())
}

fn ensure_repository(path: &str) -> Result<(), String> {
    let repository_path = PathBuf::from(path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    Ok(())
}

fn is_unmerged_status(index_status: char, worktree_status: char) -> bool {
    index_status == 'U'
        || worktree_status == 'U'
        || matches!((index_status, worktree_status), ('A', 'A') | ('D', 'D'))
}

fn is_running_development_repository(path: &str) -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }

    let Ok(executable_path) = std::env::current_exe() else {
        return false;
    };

    let Some(app_repository) = executable_path
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
    else {
        return false;
    };

    let Ok(requested_repository) = PathBuf::from(path).canonicalize() else {
        return false;
    };
    let Ok(running_repository) = app_repository.canonicalize() else {
        return false;
    };

    requested_repository == running_repository
}

fn validate_repository_file_path(file_path: &str) -> Result<PathBuf, String> {
    let trimmed = file_path.trim();
    let relative_path = Path::new(trimmed);
    if trimmed.is_empty()
        || trimmed.chars().any(char::is_control)
        || relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("O caminho do arquivo em conflito não é válido.".to_string());
    }

    Ok(relative_path.to_path_buf())
}

fn read_conflict_stage(path: &str, file_path: &str, stage: u8) -> (String, bool) {
    let spec = format!(":{stage}:{file_path}");
    let args = vec!["show".to_string(), spec];
    match run_git_strings(path, &args) {
        Ok(content) => (content, true),
        Err(_) => (String::new(), false),
    }
}

fn read_working_file(path: &Path) -> (String, bool, bool) {
    match std::fs::read(path) {
        Ok(content) => {
            let is_binary = content.contains(&0);
            (
                String::from_utf8_lossy(&content).to_string(),
                true,
                is_binary,
            )
        }
        Err(_) => (String::new(), false, false),
    }
}

fn validate_commit_hash(commit_hash: &str) -> Result<(), String> {
    let valid_length = (7..=64).contains(&commit_hash.len());
    let valid_characters = commit_hash
        .chars()
        .all(|character| character.is_ascii_hexdigit());

    if !valid_length || !valid_characters {
        return Err("O commit selecionado não é válido.".to_string());
    }

    Ok(())
}

fn get_commit_first_parent(path: &str, commit_hash: &str) -> Result<Option<String>, String> {
    let output = run_git(path, &["rev-list", "--parents", "-n", "1", commit_hash])?;
    Ok(output.split_whitespace().nth(1).map(ToOwned::to_owned))
}

fn validate_stash_reference(path: &str, stash_ref: &str) -> Result<(), String> {
    if !stash_ref.starts_with("stash@{") || !stash_ref.ends_with('}') {
        return Err("A referência do stash selecionado não é válida.".to_string());
    }

    let commit_reference = format!("{stash_ref}^{{commit}}");
    run_git(
        path,
        &["rev-parse", "--verify", "--quiet", &commit_reference],
    )
    .map(|_| ())
    .map_err(|_| "O stash selecionado não está mais disponível.".to_string())
}

fn parse_stash_index(stash_ref: &str) -> Result<usize, String> {
    stash_ref
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'))
        .ok_or_else(|| "A referência do stash selecionado não é válida.".to_string())?
        .parse::<usize>()
        .map_err(|_| "A referência do stash selecionado não é válida.".to_string())
}

fn validate_stash_file_selection(
    path: &str,
    stash_ref: &str,
    file_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if file_paths.is_empty() {
        return Err("Selecione pelo menos um arquivo para aplicar.".to_string());
    }

    let available_files = get_stash_files(path.to_string(), stash_ref.to_string())?;
    let available_paths: HashSet<String> =
        available_files.into_iter().map(|file| file.path).collect();
    let mut selected_paths = Vec::new();
    let mut seen_paths = HashSet::new();

    for file_path in file_paths {
        let validated_path = validate_repository_file_path(&file_path)
            .map_err(|_| "Um dos arquivos selecionados não possui um caminho válido.".to_string())?
            .to_string_lossy()
            .to_string();

        if !available_paths.contains(&validated_path) {
            return Err("Um dos arquivos selecionados não pertence ao stash atual.".to_string());
        }

        if seen_paths.insert(validated_path.clone()) {
            selected_paths.push(validated_path);
        }
    }

    Ok(selected_paths)
}

fn stash_contains_path(path: &str, tree_reference: &str, file_path: &str) -> bool {
    let object_reference = format!("{tree_reference}:{file_path}");
    let args = vec!["cat-file".to_string(), "-e".to_string(), object_reference];
    run_git_strings(path, &args).is_ok()
}

fn validate_worktree_file_selection(
    path: &str,
    file_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if file_paths.is_empty() {
        return Err("Selecione pelo menos um arquivo para guardar no stash.".to_string());
    }

    let status = get_repository_status(path.to_string())?;
    let available_paths: HashSet<String> = status.files.into_iter().map(|file| file.path).collect();
    let mut selected_paths = Vec::new();
    let mut seen_paths = HashSet::new();

    for file_path in file_paths {
        let validated_path = validate_repository_file_path(&file_path)
            .map_err(|_| "Um dos arquivos selecionados não possui um caminho válido.".to_string())?
            .to_string_lossy()
            .to_string();

        if !available_paths.contains(&validated_path) {
            return Err(
                "Um dos arquivos selecionados não possui alterações disponíveis.".to_string(),
            );
        }

        if seen_paths.insert(validated_path.clone()) {
            selected_paths.push(validated_path);
        }
    }

    Ok(selected_paths)
}

fn validate_start_point(path: &str, start_point: &str) -> Result<(), String> {
    if start_point.trim().is_empty() {
        return Err("O ponto inicial da branch não pode ficar vazio.".to_string());
    }

    if start_point.len() >= 7
        && start_point.len() <= 64
        && start_point
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return validate_commit_hash(start_point);
    }

    let commit_reference = format!("{start_point}^{{commit}}");
    run_git(
        path,
        &["rev-parse", "--verify", "--quiet", &commit_reference],
    )
    .map(|_| ())
    .map_err(|_| format!("A referência '{start_point}' não aponta para um commit válido."))
}

fn validate_branch_name(path: &str, branch: &str) -> Result<(), String> {
    if branch.trim().is_empty() {
        return Err("Informe um nome para a branch.".to_string());
    }

    run_git_with_timeout(
        path,
        &["check-ref-format", "--branch", branch],
        GIT_COMMAND_TIMEOUT,
    )
    .map(|_| ())
    .map_err(|error| format!("Nome de branch inválido: {error}"))
}

fn get_ahead_behind(path: &str) -> (usize, usize) {
    let output = run_git_with_timeout(
        path,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        GIT_COMMAND_TIMEOUT,
    )
    .unwrap_or_default();
    let mut counts = output
        .split_whitespace()
        .filter_map(|value| value.parse::<usize>().ok());

    (counts.next().unwrap_or(0), counts.next().unwrap_or(0))
}

fn preferred_configured_remote(path: &str) -> Option<String> {
    let remotes = run_git_lines(path, &["remote"]).ok()?;

    remotes
        .iter()
        .find(|remote| remote.as_str() == "origin")
        .cloned()
        .or_else(|| remotes.first().cloned())
}

fn detect_repository_operation(path: &str) -> Option<&'static str> {
    if git_path_exists(path, "MERGE_HEAD") {
        return Some("merge");
    }

    if git_path_exists(path, "rebase-merge") || git_path_exists(path, "rebase-apply") {
        return Some("rebase");
    }

    None
}

fn validate_repository_operation(path: &str, operation: &str) -> Result<(), String> {
    let current_operation = detect_repository_operation(path)
        .ok_or_else(|| "Não existe uma operação Merge ou Rebase em andamento.".to_string())?;

    if current_operation != operation {
        return Err(format!(
            "A operação em andamento é {current_operation}, não {operation}."
        ));
    }

    Ok(())
}

fn git_path_exists(path: &str, git_path: &str) -> bool {
    let Ok(resolved_path) = run_git(path, &["rev-parse", "--git-path", git_path]) else {
        return false;
    };

    let resolved_path = PathBuf::from(resolved_path.trim());
    if resolved_path.is_absolute() {
        resolved_path.exists()
    } else {
        PathBuf::from(path).join(resolved_path).exists()
    }
}

fn preferred_push_remote(path: &str) -> Result<String, String> {
    let remotes = run_git_lines(path, &["remote"])?;

    remotes
        .iter()
        .find(|remote| remote.as_str() == "origin")
        .cloned()
        .or_else(|| remotes.first().cloned())
        .ok_or_else(|| "Nenhum repositório remoto foi configurado para este projeto.".to_string())
}

fn drain_output<R: Read>(stream: Option<R>) {
    let Some(mut stream) = stream else {
        return;
    };

    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

fn spawn_clone_progress_reader<R: Read + Send + 'static>(
    app: AppHandle,
    operation_id: String,
    stream: Option<R>,
    output: Arc<Mutex<String>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let Some(mut stream) = stream else {
            return;
        };

        let mut buffer = [0u8; 1024];
        let mut pending = String::new();
        let mut last_progress = 0;

        loop {
            let read = match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let chunk = String::from_utf8_lossy(&buffer[..read]);
            if let Ok(mut current_output) = output.lock() {
                current_output.push_str(&chunk);
            }
            pending.push_str(&chunk);

            let mut segments: Vec<String> =
                pending.split(['\r', '\n']).map(ToOwned::to_owned).collect();
            pending = segments.pop().unwrap_or_default();
            for segment in segments {
                emit_clone_progress_line(&app, &operation_id, &segment, &mut last_progress);
            }
        }

        if !pending.trim().is_empty() {
            emit_clone_progress_line(&app, &operation_id, &pending, &mut last_progress);
        }
    })
}

fn emit_clone_progress_line(
    app: &AppHandle,
    operation_id: &str,
    line: &str,
    last_progress: &mut u8,
) {
    let detail = line.trim();
    if detail.is_empty() {
        return;
    }

    if let Some(progress) = clone_progress_from_line(detail) {
        *last_progress = (*last_progress).max(progress);
    }

    let stage = if detail.contains("Receiving objects") {
        "Baixando objetos"
    } else if detail.contains("Resolving deltas") {
        "Resolvendo alterações"
    } else if detail.contains("Updating files") {
        "Atualizando arquivos"
    } else if detail.contains("Cloning into") {
        "Criando repositório"
    } else {
        "Clonando repositório"
    };

    emit_clone_progress(
        app,
        operation_id,
        *last_progress,
        stage,
        detail,
        false,
        false,
    );
}

fn clone_progress_from_line(line: &str) -> Option<u8> {
    line.split_whitespace().find_map(|part| {
        part.strip_suffix('%')
            .and_then(|value| value.parse::<u8>().ok())
    })
}

fn emit_clone_progress(
    app: &AppHandle,
    operation_id: &str,
    progress: u8,
    stage: &str,
    detail: &str,
    finished: bool,
    cancelled: bool,
) {
    let _ = app.emit(
        "clone-progress",
        CloneProgressPayload {
            operation_id: operation_id.to_string(),
            progress,
            stage: stage.to_string(),
            detail: detail.to_string(),
            finished,
            cancelled,
        },
    );
}

struct AskpassGuard {
    path: PathBuf,
}

impl AskpassGuard {
    fn new(_access_token: &str) -> Result<Self, String> {
        let extension = if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "sh"
        };
        let unique_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "orangit-git-askpass-{}-{unique_id}.{extension}",
            std::process::id()
        ));
        let contents = if cfg!(target_os = "windows") {
            "@echo off\r\necho %~1 | findstr /I \"username\" >nul\r\nif not errorlevel 1 (\r\n  echo x-access-token\r\n) else (\r\n  echo %ORANGIT_GITHUB_ASKPASS_TOKEN%\r\n)\r\n"
        } else {
            "#!/bin/sh\ncase \"$1\" in\n  *[Uu]sername*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' \"$ORANGIT_GITHUB_ASKPASS_TOKEN\" ;;\nesac\n"
        };

        std::fs::write(&path, contents)
            .map_err(|error| format!("Não foi possível preparar a autenticação do Git: {error}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&path)
                .map_err(|error| {
                    format!("Não foi possível preparar a autenticação do Git: {error}")
                })?
                .permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&path, permissions).map_err(|error| {
                format!("Não foi possível proteger a autenticação do Git: {error}")
            })?;
        }

        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for AskpassGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_timeout(path, args, GIT_COMMAND_TIMEOUT)
}

fn run_git_strings(path: &str, args: &[String]) -> Result<String, String> {
    run_git_with_timeout(path, args, GIT_COMMAND_TIMEOUT)
}

fn run_git_with_timeout<I, S>(path: &str, args: I, timeout: Duration) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    run_git_process(command, timeout)
}

fn run_git_with_access_token<I, S>(
    path: &str,
    args: I,
    timeout: Duration,
    access_token: Option<&str>,
) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let askpass = access_token.map(AskpassGuard::new).transpose()?;
    let mut command = Command::new("git");

    if askpass.is_some() {
        command.arg("-c").arg("credential.helper=");
    }

    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let (Some(askpass), Some(access_token)) = (askpass.as_ref(), access_token) {
        command
            .env("GIT_ASKPASS", askpass.path())
            .env("ORANGIT_GITHUB_ASKPASS_TOKEN", access_token);
    }

    run_git_process(command, timeout)
}

fn run_git_process(mut command: Command, timeout: Duration) -> Result<String, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("Não foi possível executar o Git: {error}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Não foi possível ler a saída do Git.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Não foi possível ler o erro do Git.".to_string())?;

    // Leia stdout e stderr enquanto o Git executa. Se esperarmos o processo
    // terminar para ler os pipes, um diff grande pode preencher o buffer do
    // Windows e bloquear o próprio Git até o timeout.
    let stdout_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let result = stdout.read_to_end(&mut buffer);
        (buffer, result)
    });
    let stderr_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let result = stderr.read_to_end(&mut buffer);
        (buffer, result)
    });

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(
                    "O Git demorou muito para responder. Verifique se o repositório não está em uma pasta muito grande ou indisponível."
                        .to_string(),
                );
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "Não foi possível verificar o processo do Git: {error}"
                ));
            }
        }
    }

    let status = child
        .try_wait()
        .map_err(|error| format!("Não foi possível finalizar o Git: {error}"))?
        .ok_or_else(|| "O Git encerrou sem informar o resultado.".to_string())?;
    let (stdout, stdout_result) = stdout_reader
        .join()
        .map_err(|_| "Não foi possível ler a saída do Git.".to_string())?;
    let (stderr, stderr_result) = stderr_reader
        .join()
        .map_err(|_| "Não foi possível ler o erro do Git.".to_string())?;

    stdout_result.map_err(|error| format!("Não foi possível ler a saída do Git: {error}"))?;
    stderr_result.map_err(|error| format!("Não foi possível ler o erro do Git: {error}"))?;

    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_string());
    }

    // O status --porcelain usa os dois primeiros caracteres para indicar o
    // estado do arquivo. O primeiro pode ser um espaco; por isso nao podemos
    // usar `trim()`, que removeria esse caractere e quebraria o caminho do
    // primeiro arquivo (por exemplo, `angular.json` viraria `ngular.json`).
    Ok(String::from_utf8_lossy(&stdout).trim_end().to_string())
}

fn run_git_lines(path: &str, args: &[&str]) -> Result<Vec<String>, String> {
    let output = run_git(path, args)?;

    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}
