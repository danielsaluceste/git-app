use crate::models::repository::{
    CommitFile, LocalRepositoryInfo, RepositoryCommit, RepositoryFile, RepositoryReferences,
    RepositoryStatus,
};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_DIFF_TIMEOUT: Duration = Duration::from_secs(45);
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(60);

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
pub fn get_repository_references(path: String) -> Result<RepositoryReferences, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    let current_branch = run_git(&path, &["symbolic-ref", "--short", "HEAD"]).ok();
    let mut local_branches = run_git_lines(
        &path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?;
    if let Some(branch) = current_branch.as_ref() {
        if !local_branches.iter().any(|item| item == branch) {
            local_branches.insert(0, branch.clone());
        }
    }
    let remote_branches = run_git_lines(
        &path,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    )?
    .into_iter()
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

    for line in status_output.lines().filter(|line| !line.trim().is_empty()) {
        let bytes = line.as_bytes();
        if bytes.len() < 3 {
            continue;
        }

        let index_status = bytes[0] as char;
        let worktree_status = bytes[1] as char;
        let is_untracked = index_status == '?' && worktree_status == '?';
        let is_staged = index_status != ' ' && index_status != '?';
        let is_unstaged = worktree_status != ' ' && worktree_status != '?';

        if is_untracked {
            untracked_count += 1;
        }
        if is_staged {
            staged_count += 1;
        }
        if is_unstaged {
            unstaged_count += 1;
        }

        let status = if is_untracked {
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
        files,
    })
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
pub fn commit_repository(path: String, message: String) -> Result<(), String> {
    ensure_repository(&path)?;

    if message.trim().is_empty() {
        return Err("Digite uma mensagem para criar o commit.".to_string());
    }

    let args = vec![
        "commit".to_string(),
        "-m".to_string(),
        message.trim().to_string(),
    ];
    run_git_strings(&path, &args).map(|_| ())
}

#[tauri::command]
pub fn get_repository_staged_diff(path: String) -> Result<String, String> {
    ensure_repository(&path)?;

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
pub fn get_repository_commits(path: String) -> Result<Vec<RepositoryCommit>, String> {
    let repository_path = PathBuf::from(&path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    let log = run_git(
        &path,
        &[
            "log",
            "--max-count=100",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P%x1e",
        ],
    )?;

    let commits = log
        .split('\x1e')
        .filter_map(|record| {
            let fields: Vec<&str> = record.trim().split('\x1f').collect();
            if fields.len() < 7 || fields[0].is_empty() {
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
            })
        })
        .collect();

    Ok(commits)
}

#[tauri::command]
pub fn get_commit_files(path: String, commit_hash: String) -> Result<Vec<CommitFile>, String> {
    ensure_repository(&path)?;
    validate_commit_hash(&commit_hash)?;

    let output = run_git_with_timeout(
        &path,
        &[
            "show",
            "--format=",
            "--name-status",
            "--find-renames",
            &commit_hash,
        ],
        GIT_COMMAND_TIMEOUT,
    )?;

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

    let args = vec![
        "show".to_string(),
        "--format=".to_string(),
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--unified=3".to_string(),
        commit_hash,
        "--".to_string(),
        file_path,
    ];
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
pub fn fetch_repository(path: String) -> Result<(), String> {
    ensure_repository(&path)?;
    run_git_with_timeout(&path, &["fetch", "--all", "--prune"], GIT_NETWORK_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub fn pull_repository(path: String) -> Result<(), String> {
    ensure_repository(&path)?;
    run_git_with_timeout(&path, &["pull", "--ff-only"], GIT_NETWORK_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub fn push_repository(path: String) -> Result<(), String> {
    ensure_repository(&path)?;

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
        return run_git_with_timeout(&path, &["push"], GIT_NETWORK_TIMEOUT).map(|_| ());
    }

    let remote = preferred_push_remote(&path)?;
    run_git_with_timeout(
        &path,
        &["push", "--set-upstream", &remote, &current_branch],
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| ())
}

#[tauri::command]
pub fn checkout_branch(path: String, branch: String) -> Result<(), String> {
    ensure_repository(&path)?;
    validate_branch_name(&path, &branch)?;
    run_git_with_timeout(&path, &["checkout", &branch], GIT_COMMAND_TIMEOUT).map(|_| ())
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

fn preferred_push_remote(path: &str) -> Result<String, String> {
    let remotes = run_git_lines(path, &["remote"])?;

    remotes
        .iter()
        .find(|remote| remote.as_str() == "origin")
        .cloned()
        .or_else(|| remotes.first().cloned())
        .ok_or_else(|| "Nenhum repositório remoto foi configurado para este projeto.".to_string())
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
    let mut child = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
