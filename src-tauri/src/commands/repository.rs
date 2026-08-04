use crate::models::repository::{
    LocalRepositoryInfo, RepositoryCommit, RepositoryFile, RepositoryReferences, RepositoryStatus,
};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_DIFF_TIMEOUT: Duration = Duration::from_secs(45);

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

fn ensure_repository(path: &str) -> Result<(), String> {
    let repository_path = PathBuf::from(path);

    if !repository_path.is_dir() || !repository_path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    Ok(())
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
