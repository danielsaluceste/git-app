use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, fs::File};
use tauri::State;

const CODEX_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_OUTPUT_LENGTH: usize = 40_000;

#[derive(Clone, Default)]
pub struct CodexProcessState {
    process: Arc<Mutex<Option<Arc<CodexProcess>>>>,
}

struct CodexProcess {
    child: Mutex<Child>,
    cancelled: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub command: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRunResult {
    pub output: String,
}

#[tauri::command]
pub fn check_codex_cli() -> CodexCliStatus {
    let mut last_error = None;

    for command in codex_commands() {
        match Command::new(&command).arg("--version").output() {
            Ok(output) if output.status.success() => {
                let version = output_text(&output.stdout).or_else(|| output_text(&output.stderr));

                return CodexCliStatus {
                    installed: true,
                    version,
                    command: Some(command.display().to_string()),
                    error: None,
                };
            }
            Ok(output) => {
                last_error = output_text(&output.stderr).or_else(|| output_text(&output.stdout));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    CodexCliStatus {
        installed: false,
        version: None,
        command: None,
        error: last_error,
    }
}

#[tauri::command]
pub async fn run_codex(
    state: State<'_, CodexProcessState>,
    repository_path: String,
    prompt: String,
    context: Option<String>,
    allow_edits: bool,
) -> Result<CodexRunResult, String> {
    let state = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        run_codex_blocking(state, repository_path, prompt, context, allow_edits)
    })
    .await
    .map_err(|error| format!("Não foi possível acompanhar o Codex CLI: {error}"))?
}

fn run_codex_blocking(
    state: CodexProcessState,
    repository_path: String,
    prompt: String,
    context: Option<String>,
    allow_edits: bool,
) -> Result<CodexRunResult, String> {
    let repository_path = PathBuf::from(repository_path.trim());
    ensure_repository(&repository_path)?;

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Digite uma solicitação para o Codex.".to_string());
    }

    let command = codex_commands()
        .iter()
        .find(|candidate| {
            Command::new(candidate)
                .arg("--version")
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            "O Codex CLI não está instalado ou não está disponível no PATH.".to_string()
        })?
        .clone();

    let sandbox = if allow_edits {
        "workspace-write"
    } else {
        "read-only"
    };
    let full_prompt = build_prompt(prompt, context.as_deref());
    let (stdout_path, stderr_path) = output_paths();
    let stdout_file = File::create(&stdout_path)
        .map_err(|error| format!("Não foi possível preparar a saída do Codex: {error}"))?;
    let stderr_file = File::create(&stderr_path)
        .map_err(|error| format!("Não foi possível preparar os erros do Codex: {error}"))?;
    let mut process = Command::new(&command);
    process
        .current_dir(&repository_path)
        .args([
            "exec",
            "--ephemeral",
            "--sandbox",
            sandbox,
            full_prompt.as_str(),
        ])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let child = process.spawn().map_err(|error| {
        let _ = fs::remove_file(&stdout_path);
        let _ = fs::remove_file(&stderr_path);
        format!("Não foi possível iniciar o Codex CLI: {error}")
    })?;
    let process = Arc::new(CodexProcess {
        child: Mutex::new(child),
        cancelled: AtomicBool::new(false),
    });

    {
        let mut active = state
            .process
            .lock()
            .map_err(|_| "Não foi possível controlar o Codex CLI.".to_string())?;
        if active.is_some() {
            if let Ok(mut child) = process.child.lock() {
                let _ = child.kill();
            }
            let _ = fs::remove_file(&stdout_path);
            let _ = fs::remove_file(&stderr_path);
            return Err("Já existe uma solicitação do Codex em andamento.".to_string());
        }
        *active = Some(Arc::clone(&process));
    }

    let started_at = Instant::now();
    let status = loop {
        let process_status = process
            .child
            .lock()
            .map_err(|_| "Não foi possível acompanhar o Codex CLI.".to_string())?
            .try_wait()
            .map_err(|error| format!("Não foi possível acompanhar o Codex CLI: {error}"))?;

        if let Some(status) = process_status {
            break Ok(status);
        }

        if process.cancelled.load(Ordering::Relaxed) {
            if let Ok(mut child) = process.child.lock() {
                let _ = child.kill();
            }
            break Err("A solicitação do Codex foi interrompida.".to_string());
        }

        if started_at.elapsed() >= CODEX_TIMEOUT {
            if let Ok(mut child) = process.child.lock() {
                let _ = child.kill();
            }
            break Err(
                "O Codex demorou muito para responder. Tente uma solicitação menor.".to_string(),
            );
        }

        thread::sleep(Duration::from_millis(80));
    };

    let stdout = read_output_file(&stdout_path);
    let stderr = read_output_file(&stderr_path);
    let _ = fs::remove_file(&stdout_path);
    let _ = fs::remove_file(&stderr_path);
    if let Ok(mut active) = state.process.lock() {
        *active = None;
    }

    let status = status?;
    if !status.success() {
        let error = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return Err(limit_output(error));
    }

    let output = limit_output(stdout);
    if output.is_empty() {
        return Err("O Codex não retornou uma resposta.".to_string());
    }

    Ok(CodexRunResult { output })
}

#[tauri::command]
pub fn cancel_codex(state: State<'_, CodexProcessState>) -> Result<(), String> {
    let process = state
        .process
        .lock()
        .map_err(|_| "Não foi possível interromper o Codex CLI.".to_string())?
        .clone()
        .ok_or_else(|| "Nenhuma solicitação do Codex está em andamento.".to_string())?;

    process.cancelled.store(true, Ordering::Relaxed);
    if let Ok(mut child) = process.child.lock() {
        let _ = child.kill();
    }
    Ok(())
}

fn ensure_repository(path: &PathBuf) -> Result<(), String> {
    if !path.is_dir() || !path.join(".git").exists() {
        return Err("O repositório selecionado não está disponível.".to_string());
    }

    Ok(())
}

fn build_prompt(prompt: &str, context: Option<&str>) -> String {
    let context = context.unwrap_or_default().trim();
    if context.is_empty() {
        return prompt.to_string();
    }

    format!(
        "Considere esta conversa anterior apenas como contexto. Continue trabalhando no repositório atual.\n\n{context}\n\nNova solicitação do usuário:\n{prompt}"
    )
}

fn output_paths() -> (PathBuf, PathBuf) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let prefix = format!("orangit-codex-{}-{timestamp}", std::process::id());
    let temporary_directory = env::temp_dir();

    (
        temporary_directory.join(format!("{prefix}-stdout.log")),
        temporary_directory.join(format!("{prefix}-stderr.log")),
    )
}

fn read_output_file(path: &PathBuf) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn output_text(bytes: &[u8]) -> Option<String> {
    let output = String::from_utf8_lossy(bytes).trim().to_string();
    (!output.is_empty()).then_some(output)
}

fn limit_output(output: String) -> String {
    let output = output.trim().to_string();
    if output.chars().count() <= MAX_OUTPUT_LENGTH {
        return output;
    }

    let shortened = output.chars().take(MAX_OUTPUT_LENGTH).collect::<String>();
    format!("{shortened}\n\n[Saída truncada pelo Git App]")
}

fn codex_commands() -> Vec<PathBuf> {
    let mut commands = Vec::new();

    #[cfg(target_os = "windows")]
    {
        commands.extend([
            PathBuf::from("codex.exe"),
            PathBuf::from("codex.cmd"),
            PathBuf::from("codex"),
        ]);

        if let Ok(app_data) = env::var("APPDATA") {
            let npm_directory = PathBuf::from(app_data).join("npm");
            commands.push(npm_directory.join("codex.cmd"));
            commands.push(npm_directory.join("codex.exe"));
        }

        if let Ok(user_profile) = env::var("USERPROFILE") {
            let user_profile = PathBuf::from(user_profile);
            commands.push(user_profile.join(".codex").join("bin").join("codex.exe"));
            commands.push(user_profile.join(".local").join("bin").join("codex.exe"));

            let extensions = user_profile.join(".vscode").join("extensions");
            if let Ok(entries) = fs::read_dir(extensions) {
                let mut extension_paths = entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("openai.chatgpt-")
                    })
                    .map(|entry| {
                        entry
                            .path()
                            .join("bin")
                            .join("windows-x86_64")
                            .join("codex.exe")
                    })
                    .collect::<Vec<_>>();
                extension_paths.sort();
                commands.extend(extension_paths.into_iter().rev());
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    commands.push(PathBuf::from("codex"));

    commands
}
