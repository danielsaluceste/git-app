use crate::commands::github;
use crate::models::repository::{
    BlameLine, CommitFile, ConflictFile, LocalRepositoryInfo, RepositoryCommit, RepositoryFile,
    RepositoryOperation, RepositoryReferences, RepositoryRemote, RepositoryStatus,
    RepositoryTag, UndoCandidate,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_DIFF_TIMEOUT: Duration = Duration::from_secs(45);
const GIT_BRANCH_OPERATION_TIMEOUT: Duration = Duration::from_secs(45);
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(60);

// Operações Git que alteram referências, o índice ou o working tree não podem
// executar em paralelo no mesmo repositório. Isso é especialmente importante
// porque o app faz fetch automático enquanto o usuário pode iniciar Pull/Push.
static REPOSITORY_OPERATION_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

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

#[tauri::command(async)]
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
pub async fn clone_repository(
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

    let wait_process = Arc::clone(&process);

    let wait_result = tauri::async_runtime::spawn_blocking(move || {
        wait_for_clone_process(&wait_process, stdout_thread, stderr_thread)
    })
    .await
    .map_err(|error| format!("Falha ao acompanhar o clone em segundo plano: {error}"))?;

    let was_cancelled = process.cancelled.load(Ordering::Relaxed);
    state
        .processes
        .lock()
        .ok()
        .and_then(|mut processes| processes.remove(&operation_id));

    let status = wait_result?;

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

/// Aguarda o término do clone fora da thread principal e junta as threads de
/// leitura antes de devolver o status final do processo.
fn wait_for_clone_process(
    process: &Arc<CloneProcess>,
    stdout_thread: thread::JoinHandle<()>,
    stderr_thread: thread::JoinHandle<()>,
) -> Result<std::process::ExitStatus, String> {
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

            return Err(
                "O clone demorou muito para responder. Verifique a conexão e tente novamente."
                    .to_string(),
            );
        }

        thread::sleep(Duration::from_millis(40));
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    Ok(status)
}

#[tauri::command(async)]
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

fn read_head_branch(repo_path: &Path) -> Option<String> {
    let head_file = repo_path.join(".git").join("HEAD");
    if let Ok(content) = std::fs::read_to_string(head_file) {
        let content = content.trim();
        if let Some(branch) = content.strip_prefix("ref: refs/heads/") {
            return Some(branch.to_string());
        }
    }
    None
}

fn parse_branch_header(line: &str) -> (Option<String>, usize, usize) {
    let header = line.strip_prefix("## ").unwrap_or(line).trim();
    if header.starts_with("HEAD (no branch)") || header.starts_with("No commits yet on ") {
        let branch = header.strip_prefix("No commits yet on ").map(ToString::to_string);
        return (branch, 0, 0);
    }
    if header.starts_with("Initial commit on ") {
        let branch = header.strip_prefix("Initial commit on ").map(ToString::to_string);
        return (branch, 0, 0);
    }

    let mut branch_name = None;
    let mut ahead = 0;
    let mut behind = 0;

    let (branch_part, tracking_part) = match header.find("...") {
        Some(pos) => (&header[..pos], Some(&header[pos + 3..])),
        None => match header.find(' ') {
            Some(pos) => (&header[..pos], Some(&header[pos + 1..])),
            None => (header, None),
        },
    };

    if !branch_part.is_empty() && branch_part != "HEAD" {
        branch_name = Some(branch_part.to_string());
    }

    if let Some(tracking) = tracking_part {
        if let Some(start) = tracking.find('[') {
            if let Some(end) = tracking.find(']') {
                let inside = &tracking[start + 1..end];
                for part in inside.split(',') {
                    let part = part.trim();
                    if let Some(count_str) = part.strip_prefix("ahead ") {
                        ahead = count_str.trim().parse::<usize>().unwrap_or(0);
                    } else if let Some(count_str) = part.strip_prefix("behind ") {
                        behind = count_str.trim().parse::<usize>().unwrap_or(0);
                    }
                }
            }
        }
    }

    (branch_name, behind, ahead)
}

#[tauri::command]
pub async fn get_repository_references(path: String) -> Result<RepositoryReferences, String> {
    run_blocking(move || get_repository_references_impl(path)).await
}

fn get_repository_references_impl(path: String) -> Result<RepositoryReferences, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    let current_branch = read_head_branch(&repository_path)
        .or_else(|| run_git(&path, &["symbolic-ref", "--short", "HEAD"]).ok());

    let all_refs = run_git_lines(
        &path,
        &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"],
    )
    .unwrap_or_default();

    let mut local_branches = Vec::new();
    let mut remote_branches = Vec::new();
    let mut tags = Vec::new();

    for reference in all_refs {
        if let Some(branch) = reference.strip_prefix("refs/heads/") {
            local_branches.push(branch.to_string());
        } else if let Some(remote) = reference.strip_prefix("refs/remotes/") {
            if !remote.ends_with("/HEAD") {
                remote_branches.push(remote.to_string());
            }
        } else if let Some(tag) = reference.strip_prefix("refs/tags/") {
            tags.push(tag.to_string());
        }
    }

    if let Some(branch) = current_branch.as_ref() {
        if !local_branches.iter().any(|item| item == branch) {
            local_branches.insert(0, branch.clone());
        }
    }

    let stashes = if stash_reflog_exists(&path) {
        run_git_lines(&path, &["stash", "list", "--format=%gd|%s"]).unwrap_or_default()
    } else {
        // Sem reflog de stash não existe stash para listar: evita um processo
        // Git em cada atualização de referências.
        Vec::new()
    };

    Ok(RepositoryReferences {
        current_branch,
        local_branches,
        remote_branches,
        tags,
        stashes,
    })
}

#[tauri::command(async)]
pub fn get_repository_remote(path: String) -> Result<RepositoryRemote, String> {
    ensure_repository(&path)?;
    let name = preferred_configured_remote(&path);
    let url = name
        .as_ref()
        .and_then(|remote| run_git(&path, &["remote", "get-url", remote]).ok());

    Ok(RepositoryRemote { name, url })
}

#[tauri::command(async)]
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
pub async fn get_repository_operation(path: String) -> Result<Option<RepositoryOperation>, String> {
    run_blocking(move || get_repository_operation_impl(path)).await
}

fn get_repository_operation_impl(path: String) -> Result<Option<RepositoryOperation>, String> {
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
pub async fn continue_repository_operation(path: String, operation: String) -> Result<(), String> {
    run_blocking(move || continue_repository_operation_impl(path, operation)).await
}

fn continue_repository_operation_impl(path: String, operation: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_repository_operation(&path, &operation)?;

    let args: &[&str] = match operation.as_str() {
        "merge" => &["-c", "core.editor=true", "commit", "--no-edit"],
        "rebase" => &["-c", "core.editor=true", "rebase", "--continue"],
        "cherry-pick" => &["-c", "core.editor=true", "cherry-pick", "--continue"],
        _ => return Err("A operação Git informada não é válida.".to_string()),
    };

    run_git_with_timeout(&path, args, GIT_BRANCH_OPERATION_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn abort_repository_operation(path: String, operation: String) -> Result<(), String> {
    run_blocking(move || abort_repository_operation_impl(path, operation)).await
}

fn abort_repository_operation_impl(path: String, operation: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_repository_operation(&path, &operation)?;

    let args: &[&str] = match operation.as_str() {
        "merge" => &["merge", "--abort"],
        "rebase" => &["rebase", "--abort"],
        "cherry-pick" => &["cherry-pick", "--abort"],
        _ => return Err("A operação Git informada não é válida.".to_string()),
    };

    run_git_with_timeout(&path, args, GIT_BRANCH_OPERATION_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn get_repository_status(path: String) -> Result<RepositoryStatus, String> {
    run_blocking(move || get_repository_status_impl(path)).await
}

fn get_repository_status_impl(path: String) -> Result<RepositoryStatus, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    let status_output = run_git(&path, &["status", "--porcelain=v1", "-b", "-u"])?;

    let mut current_branch = None;
    let mut ahead_count = 0;
    let mut behind_count = 0;
    let mut files = Vec::new();
    let mut staged_count = 0;
    let mut unstaged_count = 0;
    let mut untracked_count = 0;
    let mut conflicted_count = 0;

    for line in status_output.lines().filter(|line| !line.trim().is_empty()) {
        if line.starts_with("##") {
            let (branch, behind, ahead) = parse_branch_header(line);
            current_branch = branch;
            ahead_count = ahead;
            behind_count = behind;
            continue;
        }

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

        let file_path = if (index_status == 'R' || worktree_status == 'R') && line[3..].contains(" -> ") {
            let parts: Vec<&str> = line[3..].split(" -> ").collect();
            parts.last().unwrap_or(&&line[3..]).trim().to_string()
        } else {
            line[3..].trim().to_string()
        };

        files.push(RepositoryFile {
            path: file_path,
            status: status.to_string(),
            is_staged,
            is_unstaged,
            is_conflicted,
        });
    }

    if current_branch.is_none() {
        current_branch = read_head_branch(&repository_path);
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
pub async fn get_repository_conflicts(path: String) -> Result<Vec<ConflictFile>, String> {
    run_blocking(move || get_repository_conflicts_impl(path)).await
}

fn get_repository_conflicts_impl(path: String) -> Result<Vec<ConflictFile>, String> {
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn stage_repository_files(path: String, files: Vec<String>) -> Result<(), String> {
    ensure_repository(&path)?;

    if files.is_empty() {
        return Ok(());
    }

    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(files);
    run_git_strings(&path, &args).map(|_| ())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn stage_repository_hunk(
    path: String,
    file_path: String,
    hunk_index: usize,
) -> Result<(), String> {
    apply_repository_hunk(path, file_path, hunk_index, true)
}

#[tauri::command(async)]
pub fn unstage_repository_hunk(
    path: String,
    file_path: String,
    hunk_index: usize,
) -> Result<(), String> {
    apply_repository_hunk(path, file_path, hunk_index, false)
}

/// Aplica (ou reverte) um único trecho do diff no índice, sem tocar no working
/// tree. É a base do staging por hunk: o front envia o índice do trecho e o
/// patch é reconstruído aqui a partir do diff atual, evitando confiar em texto
/// de patch vindo da interface.
fn apply_repository_hunk(
    path: String,
    file_path: String,
    hunk_index: usize,
    stage: bool,
) -> Result<(), String> {
    ensure_repository(&path)?;
    let relative_path = validate_relative_file_path(&file_path)?;
    let operation_lock = repository_operation_lock(&path);
    let _operation_guard = operation_lock
        .lock()
        .map_err(|_| "Não foi possível bloquear o repositório.".to_string())?;

    let diff = if stage {
        run_git(&path, &["diff", "--no-color", "--", relative_path.as_str()])?
    } else {
        run_git(
            &path,
            &["diff", "--no-color", "--cached", "--", relative_path.as_str()],
        )?
    };

    if diff.trim().is_empty() {
        return Err(
            "Não há alterações para aplicar neste momento. Atualize a lista e tente novamente."
                .to_string(),
        );
    }

    let patch = build_hunk_patch(&diff, hunk_index)?;
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if !stage {
        args.push("--reverse");
    }

    run_git_with_input(&path, &args, &patch).map(|_| ())
}

/// Monta um patch válido contendo apenas o cabeçalho do arquivo e o trecho
/// escolhido. Os índices seguem a ordem em que os `@@` aparecem no diff, que é
/// a mesma usada pela interface.
fn build_hunk_patch(diff: &str, hunk_index: usize) -> Result<String, String> {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    let mut current: Option<String> = None;

    for line in diff.lines() {
        if line.starts_with("@@") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            current = Some(format!("{line}\n"));
        } else if let Some(hunk) = current.as_mut() {
            hunk.push_str(line);
            hunk.push('\n');
        } else {
            header.push_str(line);
            header.push('\n');
        }
    }

    if let Some(hunk) = current {
        hunks.push(hunk);
    }

    let hunk = hunks.get(hunk_index).ok_or_else(|| {
        "O trecho selecionado não está mais disponível. Atualize o diff e tente novamente."
            .to_string()
    })?;

    Ok(format!("{header}{hunk}"))
}

#[tauri::command(async)]
pub fn discard_repository_file(path: String, file_path: String) -> Result<(), String> {
    ensure_repository(&path)?;
    let relative_path = validate_repository_file_path(&file_path)?;

    let status_output = run_git(&path, &["status", "--porcelain=v1", "--", file_path.as_str()])?;
    let is_conflicted = status_output.lines().any(|line| {
        let bytes = line.as_bytes();
        bytes.len() >= 3 && is_unmerged_status(bytes[0] as char, bytes[1] as char)
    });

    if is_conflicted {
        // Em uma operação Git, descartar o conflito significa manter a
        // versão da branch atual (ours) e marcar o arquivo como resolvido.
        return resolve_repository_conflict_side(path, file_path, "ours".to_string());
    }

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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn get_last_commit_message(path: String) -> Result<String, String> {
    ensure_repository(&path)?;

    let message = run_git(&path, &["log", "-1", "--format=%B"])?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Este repositório ainda não possui commits.".to_string());
    }

    Ok(message.to_string())
}

#[tauri::command(async)]
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
pub async fn cherry_pick_commit(path: String, commit_hash: String) -> Result<(), String> {
    run_blocking(move || cherry_pick_commit_impl(path, commit_hash)).await
}

fn cherry_pick_commit_impl(path: String, commit_hash: String) -> Result<(), String> {
    ensure_repository(&path)?;

    if is_running_development_repository(&path) {
        return Err(
            "Não é possível fazer Cherry-pick no próprio repositório do GitLuna enquanto o app está rodando em modo de desenvolvimento. Use outro clone ou uma versão compilada do app.".to_string(),
        );
    }

    validate_commit_hash(&commit_hash)?;

    let status = run_git(&path, &["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err(
            "Finalize ou guarde as alterações locais antes de fazer Cherry-pick.".to_string(),
        );
    }

    let commit_info = run_git(&path, &["rev-list", "--parents", "-n", "1", &commit_hash])?;
    let parent_count = commit_info.split_whitespace().count().saturating_sub(1);
    if parent_count == 0 {
        return Err("Este commit não pode ser aplicado porque não possui parent.".to_string());
    }

    let mut args = vec!["cherry-pick".to_string(), "--no-edit".to_string()];
    if parent_count > 1 {
        args.extend(["-m".to_string(), "1".to_string()]);
    }
    args.push(commit_hash);

    run_git_with_timeout(&path, &args, GIT_BRANCH_OPERATION_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn get_undo_candidate(path: String) -> Result<Option<UndoCandidate>, String> {
    run_blocking(move || get_undo_candidate_impl(path)).await
}

/// Só sugere desfazer quando a última entrada do reflog é uma operação que
/// criou um commit. Checkout, pull e reset ficam de fora de propósito.
fn get_undo_candidate_impl(path: String) -> Result<Option<UndoCandidate>, String> {
    ensure_repository(&path)?;

    let output = run_git(
        &path,
        &["reflog", "show", "HEAD", "-n", "2", "--format=%H%x1f%gs%x1e"],
    )?;
    let entries = parse_reflog_entries(&output);

    if entries.len() < 2 {
        return Ok(None);
    }

    let (current_hash, action) = &entries[0];
    let (previous_hash, _) = &entries[1];

    if !is_undoable_action(action) {
        return Ok(None);
    }

    if run_git(
        &path,
        &["cat-file", "-e", &format!("{previous_hash}^{{commit}}")],
    )
    .is_err()
    {
        return Ok(None);
    }

    let subject = run_git(&path, &["log", "-1", "--format=%s", current_hash])?
        .trim()
        .to_string();

    Ok(Some(UndoCandidate {
        current_hash: current_hash.clone(),
        previous_hash: previous_hash.clone(),
        action: action.clone(),
        subject,
    }))
}

/// Converte a saída do reflog (`%H%x1f%gs%x1e`) em pares (hash, ação).
fn parse_reflog_entries(output: &str) -> Vec<(String, String)> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let trimmed = record.trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.split('\x1f');
            let hash = parts.next()?.trim();
            let action = parts.next()?.trim();
            if hash.is_empty() {
                return None;
            }

            Some((hash.to_string(), action.to_string()))
        })
        .collect()
}

fn is_undoable_action(action: &str) -> bool {
    ["commit", "merge", "cherry-pick", "revert"]
        .iter()
        .any(|prefix| action.starts_with(prefix))
}

#[tauri::command]
pub async fn undo_last_operation(
    path: String,
    current_hash: String,
    previous_hash: String,
) -> Result<(), String> {
    run_blocking(move || undo_last_operation_impl(path, current_hash, previous_hash)).await
}

/// Volta o ponteiro da branch para o estado anterior mantendo índice e working
/// tree (`reset --soft`). Exige árvore limpa e confere se o HEAD ainda é o
/// mesmo commit mostrado na interface, para não desfazer outra coisa.
fn undo_last_operation_impl(
    path: String,
    current_hash: String,
    previous_hash: String,
) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_commit_hash(&current_hash)?;
    validate_commit_hash(&previous_hash)?;

    let operation_lock = repository_operation_lock(&path);
    let _operation_guard = operation_lock
        .lock()
        .map_err(|_| "Não foi possível bloquear o repositório.".to_string())?;

    let head = run_git(&path, &["rev-parse", "HEAD"])?.trim().to_string();
    if head != current_hash.trim() {
        return Err(
            "O repositório mudou desde que a ação foi proposta. Atualize e tente novamente."
                .to_string(),
        );
    }

    let status = run_git(&path, &["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err("Salve ou faça stash das alterações antes de desfazer o commit.".to_string());
    }

    let reflog = run_git(&path, &["reflog", "show", "HEAD", "-n", "1", "--format=%gs"])?;
    if !is_undoable_action(reflog.trim()) {
        return Err("A última operação não pode ser desfeita com segurança.".to_string());
    }

    run_git(&path, &["reset", "--soft", previous_hash.trim()]).map(|_| ())
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
pub async fn get_repository_file_diff(
    path: String,
    file_path: String,
    staged: bool,
) -> Result<String, String> {
    run_blocking(move || get_repository_file_diff_impl(path, file_path, staged)).await
}

fn get_repository_file_diff_impl(
    path: String,
    file_path: String,
    staged: bool,
) -> Result<String, String> {
    ensure_repository(&path)?;

    if file_path.trim().is_empty() {
        return Err("O arquivo selecionado não é válido.".to_string());
    }

    let file_path = file_path.trim().to_string();
    let relative_path = validate_repository_file_path(&file_path)?;

    let mut args = vec!["diff".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    args.extend([
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--unified=3".to_string(),
        "--".to_string(),
        file_path.clone(),
    ]);

    let mut diff = run_git_with_timeout(&path, &args, GIT_DIFF_TIMEOUT)?;

    // O Git não retorna nada para um arquivo ainda não rastreado, pois ele
    // ainda não possui uma versão de comparação no índice. Nesse caso,
    // monte um diff a partir do conteúdo atual para que o usuário consiga
    // visualizar o arquivo antes de fazer o stage.
    if diff.trim().is_empty() {
        let working_path = PathBuf::from(&path).join(relative_path);
        let (content, exists, is_binary) = read_working_file(&working_path);

        if exists {
            diff = if is_binary {
                format!("Arquivo binário não pode ser exibido como texto: {file_path}")
            } else {
                build_new_file_diff(&file_path, &content)
            };
        }
    }

    let max_chars = 30_000;

    if diff.chars().count() <= max_chars {
        return Ok(diff);
    }

    let mut truncated: String = diff.chars().take(max_chars).collect();
    truncated.push_str("\n\n[Diff truncado para visualização]");
    Ok(truncated)
}

fn build_new_file_diff(file_path: &str, content: &str) -> String {
    let display_path = file_path.replace('\\', "/");
    let lines: Vec<&str> = content.lines().collect();
    let line_count = lines.len();
    let mut diff = format!(
        "diff --git a/{display_path} b/{display_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{display_path}\n"
    );

    if line_count > 0 {
        diff.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
        for line in lines {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }

        if !content.ends_with('\n') {
            diff.push_str("\\ No newline at end of file\n");
        }
    } else {
        diff.push_str("@@ -0,0 +0,0 @@\n");
    }

    diff
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn apply_stash_files(
    path: String,
    stash_ref: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;

    let selected_paths = validate_stash_file_selection(&path, &stash_ref, file_paths)?;
    for file_path in selected_paths {
        let untracked_commit = format!("{stash_ref}^3");
        if stash_contains_path(&path, &untracked_commit, &file_path) {
            let args = vec![
                "restore".to_string(),
                "--source".to_string(),
                untracked_commit,
                "--worktree".to_string(),
                "--".to_string(),
                file_path,
            ];
            run_git_strings(&path, &args)?;
        } else {
            let args = vec![
                "restore".to_string(),
                "--source".to_string(),
                stash_ref.clone(),
                "--staged".to_string(),
                "--worktree".to_string(),
                "--no-overlay".to_string(),
                "--".to_string(),
                file_path,
            ];
            run_git_strings(&path, &args)?;
        }
    }

    Ok(())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn get_stash_files(path: String, stash_ref: String) -> Result<Vec<CommitFile>, String> {
    ensure_repository(&path)?;
    validate_stash_reference(&path, &stash_ref)?;

    let mut files = Vec::new();
    let mut seen_paths = HashSet::new();

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

    for line in tracked_output.lines() {
        let Some((status_code, raw_path)) = line.split_once('\t') else {
            continue;
        };
        let file_path = raw_path.split('\t').last().unwrap_or(raw_path).trim();
        if file_path.is_empty() {
            continue;
        }

        let status = match status_code.trim().chars().next().unwrap_or('M') {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            '?' => "untracked",
            _ => "modified",
        };

        if seen_paths.insert(file_path.to_string()) {
            files.push(CommitFile {
                path: file_path.to_string(),
                status: status.to_string(),
            });
        }
    }

    let untracked_commit = format!("{stash_ref}^3");
    let untracked_output = run_git(
        &path,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-status",
            "-r",
            &untracked_commit,
        ],
    )
    .unwrap_or_default();

    for line in untracked_output.lines() {
        let Some((_, raw_path)) = line.split_once('\t') else {
            continue;
        };
        let file_path = raw_path.split('\t').last().unwrap_or(raw_path).trim();
        if file_path.is_empty() {
            continue;
        }

        if seen_paths.insert(file_path.to_string()) {
            files.push(CommitFile {
                path: file_path.to_string(),
                status: "untracked".to_string(),
            });
        }
    }

    Ok(files)
}

#[tauri::command(async)]
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
        stash_commit,
        "--".to_string(),
        file_path.clone(),
    ];
    let mut diff = run_git_strings(&path, &tracked_args)?;

    if diff.trim().is_empty() {
        let untracked_commit = format!("{stash_ref}^3");
        let untracked_args = vec![
            "diff-tree".to_string(),
            "--root".to_string(),
            "-p".to_string(),
            "--no-commit-id".to_string(),
            "--unified=3".to_string(),
            untracked_commit,
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
pub async fn get_repository_commits(
    path: String,
    all_branches: bool,
    skip: usize,
    limit: usize,
) -> Result<Vec<RepositoryCommit>, String> {
    run_blocking(move || get_repository_commits_impl(path, all_branches, skip, limit)).await
}

fn get_repository_commits_impl(
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
    // `--date-order` mantém a ordem cronológica entre branches (o
    // `--topo-order` agrupava commits antigos de uma branch antes dos recentes
    // de outra) e ainda garante que nenhum pai apareça antes dos filhos, o que
    // o desenho do grafo precisa. A data exibida é a data de commit (`%cI`),
    // que é justamente a chave usada nessa ordenação; usar a data de autoria
    // (`%aI`) fazia o horário na tela parecer fora de ordem.
    arguments.extend([
        format!("--skip={skip}"),
        format!("--max-count={safe_limit}"),
        "--date-order".to_string(),
        "--date=iso-strict".to_string(),
        "--decorate=short".to_string(),
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cI%x1f%P%x1f%D%x1e".to_string(),
    ]);
    let argument_refs = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    let log = run_git(&path, &argument_refs)?;

    Ok(parse_commit_log(&log))
}

/// Converte a saída de `git log` (campos separados por 0x1f e registros por
/// 0x1e) em estrutura. Isolado do processo Git para poder ser testado sem
/// repositório — é o ponto onde um formato inesperado some com commits da tela.
fn parse_commit_log(log: &str) -> Vec<RepositoryCommit> {
    log.split('\x1e')
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
        .collect()
}

#[tauri::command]
pub async fn get_commit_files(path: String, commit_hash: String) -> Result<Vec<CommitFile>, String> {
    run_blocking(move || get_commit_files_impl(path, commit_hash)).await
}

fn get_commit_files_impl(path: String, commit_hash: String) -> Result<Vec<CommitFile>, String> {
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
pub async fn get_commit_file_diff(
    path: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    run_blocking(move || get_commit_file_diff_impl(path, commit_hash, file_path)).await
}

#[tauri::command]
pub async fn get_file_blame(path: String, file_path: String) -> Result<Vec<BlameLine>, String> {
    run_blocking(move || get_file_blame_impl(path, file_path)).await
}

fn get_file_blame_impl(path: String, file_path: String) -> Result<Vec<BlameLine>, String> {
    ensure_repository(&path)?;
    let relative_path = validate_relative_file_path(&file_path)?;

    let output = run_git_with_timeout(
        &path,
        ["blame", "--line-porcelain", "--", relative_path.as_str()],
        GIT_DIFF_TIMEOUT,
    )?;

    Ok(parse_blame_output(&output))
}

/// Converte a saída de `git blame --line-porcelain` em linhas atribuídas.
/// O Git omite os metadados quando o mesmo commit se repete, por isso os
/// valores são mantidos até o próximo cabeçalho.
fn parse_blame_output(output: &str) -> Vec<BlameLine> {
    let mut lines = Vec::new();
    // Metadados por commit: o `--line-porcelain` repete tudo em cada linha, mas
    // guardar por hash deixa o parser correto mesmo se o Git omitir a repetição.
    let mut metadata: HashMap<String, (String, String, i64)> = HashMap::new();
    let mut hash = String::new();

    for raw in output.lines() {
        if let Some(content) = raw.strip_prefix('\t') {
            let (author, author_email, author_time) =
                metadata.get(&hash).cloned().unwrap_or_default();

            lines.push(BlameLine {
                line: lines.len() + 1,
                short_hash: hash.chars().take(7).collect(),
                hash: hash.clone(),
                author,
                author_email,
                author_time,
                content: content.to_string(),
            });
            continue;
        }

        let bytes = raw.as_bytes();
        let is_header =
            bytes.len() > 40 && bytes[..40].iter().all(u8::is_ascii_hexdigit) && bytes[40] == b' ';

        if is_header {
            hash = raw.split_whitespace().next().unwrap_or_default().to_string();
            metadata.entry(hash.clone()).or_default();
            continue;
        }

        if hash.is_empty() {
            continue;
        }

        let entry = metadata.entry(hash.clone()).or_default();
        if let Some(value) = raw.strip_prefix("author ") {
            entry.0 = value.to_string();
        } else if let Some(value) = raw.strip_prefix("author-mail ") {
            entry.1 = value
                .trim()
                .trim_matches(|character| character == '<' || character == '>')
                .to_string();
        } else if let Some(value) = raw.strip_prefix("author-time ") {
            entry.2 = value.trim().parse().unwrap_or(0);
        }
    }

    lines
}

#[tauri::command]
pub async fn get_file_history(
    path: String,
    file_path: String,
    limit: usize,
) -> Result<Vec<RepositoryCommit>, String> {
    run_blocking(move || get_file_history_impl(path, file_path, limit)).await
}

fn get_file_history_impl(
    path: String,
    file_path: String,
    limit: usize,
) -> Result<Vec<RepositoryCommit>, String> {
    ensure_repository(&path)?;
    let relative_path = validate_relative_file_path(&file_path)?;
    let safe_limit = limit.clamp(1, 200);

    let output = run_git(
        &path,
        &[
            "log",
            "--follow",
            "--date-order",
            &format!("--max-count={safe_limit}"),
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cI%x1f%P%x1f%D%x1e",
            "--",
            relative_path.as_str(),
        ],
    )?;

    Ok(parse_commit_log(&output))
}

fn get_commit_file_diff_impl(
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
    let operation_lock = repository_operation_lock(&path);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation_guard = operation_lock
            .lock()
            .map_err(|_| "Não foi possível sincronizar: o bloqueio do repositório foi interrompido.".to_string())?;

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
    let operation_lock = repository_operation_lock(&path);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation_guard = operation_lock
            .lock()
            .map_err(|_| "Não foi possível sincronizar: o bloqueio do repositório foi interrompido.".to_string())?;
        let auto_stashed = !run_git(&path, &["status", "--porcelain", "--untracked-files=all"])?
            .trim()
            .is_empty();
        let (remote, branch) = configured_pull_target(&path)?;
        let pull_args = [
            "pull",
            "--rebase",
            "--autostash",
            remote.as_str(),
            branch.as_str(),
        ];

        run_git_with_access_token(
            &path,
            &pull_args,
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
    let operation_lock = repository_operation_lock(&path);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation_guard = operation_lock
            .lock()
            .map_err(|_| "Não foi possível sincronizar: o bloqueio do repositório foi interrompido.".to_string())?;
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
            return run_git_with_access_token(
                &path,
                &["push"],
                GIT_NETWORK_TIMEOUT,
                access_token.as_deref(),
            )
            .map(|_| ());
        }

        let remote = preferred_push_remote(&path)?;
        let push_args = ["push", "--set-upstream", remote.as_str(), current_branch.trim()];
        run_git_with_access_token(
            &path,
            &push_args,
            GIT_NETWORK_TIMEOUT,
            access_token.as_deref(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| format!("Falha ao executar o Push em segundo plano: {error}"))?;

    result
}

fn repository_operation_lock(path: &str) -> Arc<Mutex<()>> {
    let key = std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    let locks = REPOSITORY_OPERATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn configured_pull_target(path: &str) -> Result<(String, String), String> {
    let current_branch = run_git(&path, &["symbolic-ref", "--short", "HEAD"])
        .map_err(|_| "Não é possível fazer Pull enquanto o repositório estiver em detached HEAD.".to_string())?;
    let current_branch = current_branch.trim();
    let remote_key = format!("branch.{current_branch}.remote");
    let merge_key = format!("branch.{current_branch}.merge");
    // `git config --get-all` retorna código 1 quando a chave não existe. Isso
    // é normal em uma branch sem upstream, então deixamos o fallback abaixo
    // produzir a mensagem apropriada para o usuário.
    let configured_remotes = run_git_lines(path, &["config", "--get-all", &remote_key])
        .unwrap_or_default();
    let configured_merges = run_git_lines(path, &["config", "--get-all", &merge_key])
        .unwrap_or_default();

    if let (Some(remote), Some(merge)) = (configured_remotes.first(), configured_merges.first()) {
        let branch = merge
            .strip_prefix("refs/heads/")
            .unwrap_or(merge)
            .to_string();
        if !remote.trim().is_empty() && !branch.trim().is_empty() {
            return Ok((remote.clone(), branch));
        }
    }

    let upstream = run_git(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )?;
    let (remote, branch) = upstream
        .trim()
        .split_once('/')
        .ok_or_else(|| "A branch atual não possui uma branch remota configurada para Pull.".to_string())?;

    Ok((remote.to_string(), branch.to_string()))
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

#[tauri::command(async)]
pub fn checkout_branch(path: String, branch: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &branch)?;
    run_git_with_timeout(&path, &["checkout", &branch], GIT_COMMAND_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn merge_branch(
    path: String,
    source_branch: String,
    target_branch: String,
) -> Result<(), String> {
    run_blocking(move || merge_branch_impl(path, source_branch, target_branch)).await
}

fn merge_branch_impl(
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
pub async fn rebase_branch(
    path: String,
    source_branch: String,
    target_branch: String,
) -> Result<(), String> {
    run_blocking(move || rebase_branch_impl(path, source_branch, target_branch)).await
}

fn rebase_branch_impl(
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

#[tauri::command(async)]
pub fn checkout_commit(path: String, commit_hash: String) -> Result<(), String> {
    ensure_repository(&path)?;

    if is_running_development_repository(&path) {
        return Err(
            "Não é possível fazer checkout no próprio repositório do GitLuna enquanto o app está rodando em modo de desenvolvimento. Use outro clone ou uma versão compilada do app.".to_string(),
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn delete_branch(path: String, branch: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &branch)?;
    run_git_with_timeout(&path, &["branch", "--delete", &branch], GIT_COMMAND_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn delete_remote_branch(path: String, remote_branch: String) -> Result<(), String> {
    run_blocking(move || delete_remote_branch_impl(path, remote_branch)).await
}

fn delete_remote_branch_impl(path: String, remote_branch: String) -> Result<(), String> {
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

#[tauri::command(async)]
pub fn get_repository_tags(path: String) -> Result<Vec<RepositoryTag>, String> {
    ensure_repository(&path)?;

    let output = run_git_with_timeout(
        &path,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)%x1f%(*objectname)%(objectname)%x1f%(contents:subject)%x1f%(taggername)%(authorname)%x1f%(taggeremail)%(authoremail)%x1f%(creatordate:iso-strict)%x1f%(objecttype)%x1e",
            "refs/tags",
        ],
        GIT_COMMAND_TIMEOUT,
    )?;

    let tags = output
        .split('\x1e')
        .filter_map(|record| {
            let fields: Vec<&str> = record.trim().split('\x1f').collect();
            if fields.len() < 7 || fields[0].is_empty() {
                return None;
            }

            let name = fields[0].to_string();
            let commit_hash = fields[1].to_string();
            let short_hash = if commit_hash.len() >= 7 {
                commit_hash[..7].to_string()
            } else {
                commit_hash.clone()
            };
            let message = fields[2].to_string();
            let tagger_name = fields[3].to_string();
            let tagger_email = fields[4].to_string();
            let date = fields[5].to_string();
            let obj_type = fields[6];
            let is_annotated = obj_type == "tag" || !message.is_empty();

            Some(RepositoryTag {
                name,
                commit_hash,
                short_hash,
                message,
                tagger_name,
                tagger_email,
                date,
                is_annotated,
            })
        })
        .collect();

    Ok(tags)
}

#[tauri::command]
pub async fn create_repository_tag(
    path: String,
    name: String,
    commit_hash: Option<String>,
    message: Option<String>,
    push: bool,
) -> Result<(), String> {
    run_blocking(move || create_repository_tag_impl(path, name, commit_hash, message, push)).await
}

fn create_repository_tag_impl(
    path: String,
    name: String,
    commit_hash: Option<String>,
    message: Option<String>,
    push: bool,
) -> Result<(), String> {
    ensure_repository(&path)?;

    let tag_name = name.trim();
    if tag_name.is_empty()
        || tag_name.contains(' ')
        || tag_name.contains('~')
        || tag_name.contains('^')
        || tag_name.contains(':')
    {
        return Err("O nome da tag é inválido.".to_string());
    }

    let mut args = vec!["tag".to_string()];
    let has_message = message.as_ref().map(|m| !m.trim().is_empty()).unwrap_or(false);

    if has_message {
        args.push("-a".to_string());
        args.push(tag_name.to_string());
        args.push("-m".to_string());
        args.push(message.unwrap_or_default());
    } else {
        args.push(tag_name.to_string());
    }

    if let Some(hash) = commit_hash.as_ref().filter(|h| !h.trim().is_empty()) {
        validate_commit_hash(hash)?;
        args.push(hash.clone());
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_with_timeout(&path, &arg_refs, GIT_COMMAND_TIMEOUT)?;

    if push {
        let remote = preferred_push_remote(&path)?;
        run_git_with_timeout(
            &path,
            &["push", &remote, tag_name],
            GIT_NETWORK_TIMEOUT,
        )?;
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_repository_tag(
    path: String,
    name: String,
    delete_remote: bool,
) -> Result<(), String> {
    run_blocking(move || delete_repository_tag_impl(path, name, delete_remote)).await
}

fn delete_repository_tag_impl(
    path: String,
    name: String,
    delete_remote: bool,
) -> Result<(), String> {
    ensure_repository(&path)?;

    let tag_name = name.trim();
    if tag_name.is_empty() {
        return Err("Nome da tag não informado.".to_string());
    }

    run_git_with_timeout(&path, &["tag", "-d", tag_name], GIT_COMMAND_TIMEOUT)?;

    if delete_remote {
        let remote = preferred_push_remote(&path)?;
        run_git_with_timeout(
            &path,
            &["push", &remote, "--delete", tag_name],
            GIT_NETWORK_TIMEOUT,
        )?;
    }

    Ok(())
}

#[tauri::command]
pub async fn push_repository_tags(path: String) -> Result<(), String> {
    run_blocking(move || push_repository_tags_impl(path)).await
}

fn push_repository_tags_impl(path: String) -> Result<(), String> {
    ensure_repository(&path)?;
    let remote = preferred_push_remote(&path)?;
    run_git_with_timeout(
        &path,
        &["push", &remote, "--tags"],
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub async fn push_repository_tag(path: String, name: String) -> Result<(), String> {
    run_blocking(move || push_repository_tag_impl(path, name)).await
}

fn push_repository_tag_impl(path: String, name: String) -> Result<(), String> {
    ensure_repository(&path)?;
    let tag_name = name.trim();
    if tag_name.is_empty() {
        return Err("Nome da tag não informado.".to_string());
    }
    let remote = preferred_push_remote(&path)?;
    run_git_with_timeout(
        &path,
        &["push", &remote, tag_name],
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

/// Caminho relativo seguro para comandos Git que recebem `<path>` (sempre com
/// barras normais). Rejeita caminhos absolutos, com `..` ou com `:` para não
/// permitir escapar do repositório.
fn validate_relative_file_path(file_path: &str) -> Result<String, String> {
    let normalized = file_path.trim().replace('\\', "/");
    let is_safe = !normalized.is_empty()
        && !normalized.chars().any(char::is_control)
        && !normalized.starts_with('/')
        && !normalized.contains(':')
        && normalized
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");

    if !is_safe {
        return Err("O arquivo selecionado não é válido.".to_string());
    }

    Ok(normalized)
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

    let status = get_repository_status_impl(path.to_string())?;
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



fn stash_reflog_exists(path: &str) -> bool {
    let Some(git_dir) = resolve_git_dir(path) else {
        return true;
    };

    git_dir.join("logs").join("refs").join("stash").exists()
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
    if git_path_exists(path, "CHERRY_PICK_HEAD") {
        return Some("cherry-pick");
    }

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
        .ok_or_else(|| "Não existe uma operação Merge, Rebase ou Cherry-pick em andamento.".to_string())?;

    if current_operation != operation {
        return Err(format!(
            "A operação em andamento é {current_operation}, não {operation}."
        ));
    }

    Ok(())
}

fn git_path_exists(path: &str, git_path: &str) -> bool {
    let Some(git_dir) = resolve_git_dir(path) else {
        return false;
    };

    git_dir.join(git_path).exists()
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
            "gitluna-git-askpass-{}-{unique_id}.{extension}",
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

/// Executa uma tarefa bloqueante (Git, leitura de arquivos, rede) no pool de
/// threads bloqueantes do runtime, longe da thread principal da janela.
/// Comandos `#[tauri::command(async)]` executam o trecho síncrono do corpo na
/// thread principal, por isso todo trabalho pesado precisa passar por aqui.
fn run_blocking<T, F>(task: F) -> impl std::future::Future<Output = Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    async move {
        tauri::async_runtime::spawn_blocking(task)
            .await
            .map_err(|error| format!("Falha ao executar a operação em segundo plano: {error}"))?
    }
}

/// Caminho real do diretório `.git`, cobrindo worktrees e submódulos, onde
/// `.git` é um arquivo com a linha `gitdir: ...`.
fn resolve_git_dir(path: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(path).join(".git");

    if candidate.is_dir() {
        return Some(candidate);
    }

    if candidate.is_file() {
        let content = std::fs::read_to_string(&candidate).ok()?;
        let target = content
            .lines()
            .find_map(|line| line.trim().strip_prefix("gitdir:"))?
            .trim();
        let target_path = PathBuf::from(target);

        return Some(if target_path.is_absolute() {
            target_path
        } else {
            PathBuf::from(path).join(target_path)
        });
    }

    // Repositório bare (quando a pasta apontada já é o próprio diretório Git).
    let bare_candidate = PathBuf::from(path);
    bare_candidate.join("HEAD").exists().then_some(bare_candidate)
}

/// Arquivos do `.git` que mudam quando o usuário executa um comando Git.
/// A assinatura permite pular `git status`/`git log` quando nada mudou.
const SIGNATURE_FILES: [&str; 13] = [
    "HEAD",
    "index",
    "packed-refs",
    "FETCH_HEAD",
    "ORIG_HEAD",
    "MERGE_HEAD",
    "MERGE_MSG",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "COMMIT_EDITMSG",
    "config",
    "shallow",
];

const SIGNATURE_DIRECTORIES: [&str; 3] = ["refs", "rebase-merge", "rebase-apply"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySignature {
    pub signature: String,
    pub head_hash: Option<String>,
}

fn push_entry_fingerprint(target: &Path, relative: &str, parts: &mut Vec<String>) {
    match std::fs::metadata(target) {
        Ok(metadata) => {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis())
                .unwrap_or(0);

            parts.push(format!("{relative}:{}:{modified}", metadata.len()));
        }
        Err(_) => parts.push(format!("{relative}:-")),
    }
}

fn collect_directory_fingerprint(
    root: &Path,
    relative: &Path,
    depth: usize,
    parts: &mut Vec<String>,
) {
    if depth > 4 || parts.len() > 4000 {
        return;
    }

    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let child_relative = relative.join(entry.file_name());
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            collect_directory_fingerprint(&entry.path(), &child_relative, depth + 1, parts);
        } else {
            push_entry_fingerprint(&entry.path(), &child_relative.to_string_lossy(), parts);
        }
    }
}

fn read_head_hash(git_dir: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();

    let Some(reference) = head.strip_prefix("ref:") else {
        return (!head.is_empty()).then(|| head.to_string());
    };
    let reference = reference.trim();

    if let Ok(content) = std::fs::read_to_string(git_dir.join(reference)) {
        let hash = content.trim();
        if !hash.is_empty() {
            return Some(hash.to_string());
        }
    }

    let packed = std::fs::read_to_string(git_dir.join("packed-refs")).ok()?;

    packed.lines().find_map(|line| {
        if line.starts_with('#') {
            return None;
        }

        let mut fields = line.split_whitespace();
        let hash = fields.next()?;
        let name = fields.next()?;

        (name == reference).then(|| hash.to_string())
    })
}

fn fingerprint_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;

    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }

    format!("{hash:016x}")
}

/// Lê apenas metadados do disco (sem criar processos Git) para responder se o
/// estado do repositório mudou desde a última verificação da interface.
fn repository_signature(path: &str) -> Result<RepositorySignature, String> {
    let repository_path = PathBuf::from(path);

    if !repository_path.is_dir() {
        return Err("A pasta do repositório não está disponível.".to_string());
    }

    let git_dir = resolve_git_dir(path)
        .ok_or_else(|| "O repositório Git não está disponível.".to_string())?;

    let mut parts: Vec<String> = Vec::with_capacity(32);

    for name in SIGNATURE_FILES {
        push_entry_fingerprint(&git_dir.join(name), name, &mut parts);
    }

    for name in SIGNATURE_DIRECTORIES {
        collect_directory_fingerprint(&git_dir.join(name), Path::new(name), 0, &mut parts);
    }

    parts.sort();

    Ok(RepositorySignature {
        signature: fingerprint_hash(&parts.join("|")),
        head_hash: read_head_hash(&git_dir),
    })
}

#[tauri::command]
pub async fn get_repository_signature(path: String) -> Result<RepositorySignature, String> {
    run_blocking(move || repository_signature(&path)).await
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
    let child = command
        .spawn()
        .map_err(|error| format!("Não foi possível executar o Git: {error}"))?;

    collect_git_output(child, timeout)
}

/// Executa o Git enviando um patch pelo stdin (usado por `git apply`).
fn run_git_with_input(path: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Não foi possível executar o Git: {error}"))?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Não foi possível enviar o patch para o Git.".to_string())?;
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| format!("Não foi possível enviar o patch para o Git: {error}"))?;
    }

    collect_git_output(child, GIT_COMMAND_TIMEOUT)
}

fn collect_git_output(mut child: Child, timeout: Duration) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn log_record(fields: &[&str]) -> String {
        format!("{}\x1e", fields.join("\x1f"))
    }

    #[test]
    fn parse_commit_log_le_campos_e_referencias() {
        let log = log_record(&[
            "abc1234",
            "abc1234",
            "Ajusta a timeline",
            "Daniel",
            "daniel@example.com",
            "2026-10-29T13:30:00-03:00",
            "def5678 ghi9012",
            "HEAD -> main, origin/main",
        ]);

        let commits = parse_commit_log(&log);

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc1234");
        assert_eq!(commits[0].subject, "Ajusta a timeline");
        assert_eq!(commits[0].date, "2026-10-29T13:30:00-03:00");
        assert_eq!(commits[0].parents, vec!["def5678", "ghi9012"]);
        assert_eq!(commits[0].references, vec!["HEAD -> main", "origin/main"]);
    }

    #[test]
    fn parse_commit_log_aceita_commit_sem_pais_nem_referencias() {
        let log = log_record(&[
            "abc1234", "abc1234", "initial", "Daniel", "d@e.com", "2026-01-01T00:00:00+00:00", "", "",
        ]);

        let commits = parse_commit_log(&log);

        assert_eq!(commits.len(), 1);
        assert!(commits[0].parents.is_empty());
        assert!(commits[0].references.is_empty());
    }

    #[test]
    fn parse_commit_log_descarta_registros_incompletos_sem_perder_os_validos() {
        let log = format!(
            "{}{}{}",
            log_record(&["1111111", "1111111", "ok", "D", "d@e.com", "2026-01-01T00:00:00+00:00", "", ""]),
            "lixo\x1fquebrado\x1e",
            log_record(&["2222222", "2222222", "ok2", "D", "d@e.com", "2026-01-02T00:00:00+00:00", "", ""]),
        );

        let commits = parse_commit_log(&log);

        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "1111111");
        assert_eq!(commits[1].hash, "2222222");
    }

    #[test]
    fn validate_commit_hash_aceita_hex_de_7_a_64() {
        assert!(validate_commit_hash("abc1234").is_ok());
        assert!(validate_commit_hash(&"a".repeat(40)).is_ok());
        assert!(validate_commit_hash(&"f".repeat(64)).is_ok());
    }

    #[test]
    fn validate_commit_hash_rejeita_entrada_invalida() {
        assert!(validate_commit_hash("").is_err());
        assert!(validate_commit_hash("abc123").is_err());
        assert!(validate_commit_hash(&"a".repeat(65)).is_err());
        assert!(validate_commit_hash("HEAD~1").is_err());
        assert!(validate_commit_hash("abc1234; rm -rf /").is_err());
    }

    #[test]
    fn parse_stash_index_le_o_indice() {
        assert_eq!(parse_stash_index("stash@{0}").unwrap(), 0);
        assert_eq!(parse_stash_index("stash@{12}").unwrap(), 12);
    }

    #[test]
    fn parse_stash_index_rejeita_referencia_invalida() {
        assert!(parse_stash_index("stash@{a}").is_err());
        assert!(parse_stash_index("stash@{1").is_err());
        assert!(parse_stash_index("main").is_err());
    }

    #[test]
    fn is_unmerged_status_detecta_conflitos() {
        assert!(is_unmerged_status('U', 'U'));
        assert!(is_unmerged_status('U', 'M'));
        assert!(is_unmerged_status('A', 'A'));
        assert!(is_unmerged_status('D', 'D'));
        assert!(!is_unmerged_status('M', 'M'));
        assert!(!is_unmerged_status('?', '?'));
        assert!(!is_unmerged_status(' ', 'M'));
    }

    #[test]
    fn parse_branch_header_le_ahead_e_behind() {
        assert_eq!(
            parse_branch_header("## main...origin/main [ahead 2, behind 1]"),
            (Some("main".to_string()), 1, 2)
        );
        assert_eq!(
            parse_branch_header("## main...origin/main"),
            (Some("main".to_string()), 0, 0)
        );
    }

    #[test]
    fn parse_branch_header_lida_com_head_destacado_e_repo_novo() {
        assert_eq!(parse_branch_header("## HEAD (no branch)"), (None, 0, 0));
        assert_eq!(
            parse_branch_header("## No commits yet on main"),
            (Some("main".to_string()), 0, 0)
        );
        assert_eq!(
            parse_branch_header("## Initial commit on trunk"),
            (Some("trunk".to_string()), 0, 0)
        );
    }

    #[test]
    fn clone_progress_from_line_extrai_a_porcentagem() {
        assert_eq!(clone_progress_from_line("Receiving objects:  42% (42/100)"), Some(42));
        assert_eq!(clone_progress_from_line("Resolving deltas: 100% (10/10), done."), Some(100));
        assert_eq!(clone_progress_from_line("Cloning into 'repo'..."), None);
    }

    #[test]
    fn build_new_file_diff_monta_cabecalho_e_linhas() {
        let diff = build_new_file_diff("src/app.ts", "linha 1\nlinha 2\n");

        assert!(diff.starts_with("diff --git a/src/app.ts b/src/app.ts\nnew file mode 100644\n"));
        assert!(diff.contains("@@ -0,0 +1,2 @@"));
        assert!(diff.contains("+linha 1\n+linha 2\n"));
        assert!(!diff.contains("\\ No newline at end of file"));
    }

    #[test]
    fn build_new_file_diff_marca_arquivo_sem_newline_final() {
        let diff = build_new_file_diff("README.md", "sem quebra");

        assert!(diff.contains("\\ No newline at end of file"));
    }
}

#[cfg(test)]
mod hunk_tests {
    use super::*;

    const DIFF: &str = "diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 linha 1
+linha nova
 linha 2
 linha 3
@@ -10,3 +11,3 @@
 linha 10
-linha 11
+linha onze
 linha 12
";

    #[test]
    fn build_hunk_patch_pega_apenas_o_trecho_escolhido() {
        let patch = build_hunk_patch(DIFF, 1).unwrap();

        assert!(patch.starts_with("diff --git a/src/app.ts b/src/app.ts\n"));
        assert!(patch.contains("--- a/src/app.ts\n+++ b/src/app.ts\n"));
        assert!(!patch.contains("@@ -1,3 +1,4 @@"));
        assert!(patch.contains("@@ -10,3 +11,3 @@"));
        assert!(patch.contains("-linha 11\n+linha onze\n"));
    }

    #[test]
    fn build_hunk_patch_inclui_os_dois_trechos_quando_pedido() {
        let patch = build_hunk_patch(DIFF, 0).unwrap();

        assert!(patch.contains("@@ -1,3 +1,4 @@"));
        assert!(patch.contains("+linha nova"));
        assert!(!patch.contains("@@ -10,3 +11,3 @@"));
    }

    #[test]
    fn build_hunk_patch_rejeita_indice_fora_da_faixa() {
        assert!(build_hunk_patch(DIFF, 2).is_err());
        assert!(build_hunk_patch("", 0).is_err());
    }

    #[test]
    fn validate_relative_file_path_aceita_caminho_do_git() {
        assert_eq!(
            validate_relative_file_path("src/app/features/changes.ts").unwrap(),
            "src/app/features/changes.ts"
        );
        assert_eq!(
            validate_relative_file_path("src\\app\\file.ts").unwrap(),
            "src/app/file.ts"
        );
    }

    #[test]
    fn validate_relative_file_path_rejeita_escapar_do_repositorio() {
        assert!(validate_relative_file_path("../segredo.txt").is_err());
        assert!(validate_relative_file_path("/etc/passwd").is_err());
        assert!(validate_relative_file_path("C:/Windows/system32").is_err());
        assert!(validate_relative_file_path("").is_err());
        assert!(validate_relative_file_path("src/./app.ts").is_err());
    }
}

#[cfg(test)]
mod blame_tests {
    use super::*;

    const BLAME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
author Daniel
author-mail <daniel@example.com>
author-time 1761742200
author-tz -0300
committer Daniel
committer-mail <daniel@example.com>
committer-time 1761742200
committer-tz -0300
summary Primeiro commit

	linha um
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2
author Juan
author-mail <juan@example.com>
author-time 1761745800
author-tz -0300
summary Segundo commit

	linha dois
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 3
	linha três
";

    #[test]
    fn parse_blame_output_atribui_cada_linha() {
        let lines = parse_blame_output(BLAME);

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].line, 1);
        assert_eq!(lines[0].hash, "a".repeat(40));
        assert_eq!(lines[0].short_hash, "aaaaaaa");
        assert_eq!(lines[0].author, "Daniel");
        assert_eq!(lines[0].author_email, "daniel@example.com");
        assert_eq!(lines[0].author_time, 1761742200);
        assert_eq!(lines[0].content, "linha um");
    }

    #[test]
    fn parse_blame_output_reaproveita_metadados_do_commit_repetido() {
        let lines = parse_blame_output(BLAME);

        // A terceira linha repete o commit da primeira, e o Git omite os metadados.
        assert_eq!(lines[2].hash, "a".repeat(40));
        assert_eq!(lines[2].author, "Daniel");
        assert_eq!(lines[2].author_time, 1761742200);
        assert_eq!(lines[2].content, "linha três");
        assert_eq!(lines[1].author, "Juan");
    }

    #[test]
    fn parse_blame_output_aceita_saida_vazia() {
        assert!(parse_blame_output("").is_empty());
    }
}

#[cfg(test)]
mod undo_tests {
    use super::*;

    const REFLOG: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1fcommit: Ajusta a timeline\x1ebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1fcommit (initial): Base\x1e";

    #[test]
    fn parse_reflog_entries_le_hash_e_acao() {
        let entries = parse_reflog_entries(REFLOG);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "a".repeat(40));
        assert_eq!(entries[0].1, "commit: Ajusta a timeline");
        assert_eq!(entries[1].1, "commit (initial): Base");
    }

    #[test]
    fn parse_reflog_entries_ignora_registros_vazios() {
        assert!(parse_reflog_entries("").is_empty());
        assert!(parse_reflog_entries("\x1e\x1e").is_empty());
    }

    #[test]
    fn is_undoable_action_aceita_apenas_criacao_de_commit() {
        assert!(is_undoable_action("commit: mensagem"));
        assert!(is_undoable_action("commit (amend): mensagem"));
        assert!(is_undoable_action("merge feature: Merge made by the 'ort' strategy."));
        assert!(is_undoable_action("cherry-pick: mensagem"));
        assert!(is_undoable_action("revert: Revert \"mensagem\""));
        assert!(!is_undoable_action("checkout: moving from main to feature"));
        assert!(!is_undoable_action("pull: Fast-forward"));
        assert!(!is_undoable_action("reset: moving to HEAD~1"));
    }
}
