use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, fs::File};
use tauri::State;

const CODEX_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_OUTPUT_LENGTH: usize = 40_000;
const MAX_PROMPT_LENGTH: usize = 20_000;

#[derive(Clone, Default)]
pub struct CodexProcessState {
    process: Arc<Mutex<Option<Arc<CodexProcess>>>>,
    server: Arc<Mutex<Option<CodexServer>>>,
    active_server_pid: Arc<Mutex<Option<u32>>>,
}

struct CodexProcess {
    child: Mutex<Child>,
    cancelled: AtomicBool,
}

struct CodexServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next_request_id: u64,
    threads: HashMap<String, String>,
}

impl Drop for CodexServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelOption {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub upgrade: Option<String>,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<CodexReasoningOption>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelsResult {
    pub models: Vec<CodexModelOption>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageWindow {
    pub used_percent: i64,
    pub window_duration_mins: Option<i64>,
    pub resets_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub plan_type: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<CodexUsageWindow>,
    pub secondary: Option<CodexUsageWindow>,
    pub rate_limit_reached_type: Option<String>,
    pub lifetime_tokens: Option<i64>,
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
pub async fn get_codex_models(
    state: State<'_, CodexProcessState>,
    codex_command: Option<String>,
) -> Result<CodexModelsResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_codex_server(&state, codex_command, |server| {
            let response = server.request("model/list", json!({}))?;
            let models = response
                .get("data")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let id = item.get("id").and_then(Value::as_str)?.to_string();
                            Some(CodexModelOption {
                                id,
                                model: item
                                    .get("model")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                display_name: item
                                    .get("displayName")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                description: item
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                hidden: item
                                    .get("hidden")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                is_default: item
                                    .get("isDefault")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                upgrade: item
                                    .get("upgrade")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                default_reasoning_effort: item
                                    .get("defaultReasoningEffort")
                                    .and_then(Value::as_str)
                                    .unwrap_or("medium")
                                    .to_string(),
                                supported_reasoning_efforts: item
                                    .get("supportedReasoningEfforts")
                                    .and_then(Value::as_array)
                                    .map(|efforts| {
                                        efforts
                                            .iter()
                                            .filter_map(|effort| {
                                                Some(CodexReasoningOption {
                                                    reasoning_effort: effort
                                                        .get("reasoningEffort")
                                                        .and_then(Value::as_str)?
                                                        .to_string(),
                                                    description: effort
                                                        .get("description")
                                                        .and_then(Value::as_str)
                                                        .unwrap_or_default()
                                                        .to_string(),
                                                })
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            Ok(CodexModelsResult { models })
        })
    })
    .await
    .map_err(|error| format!("NÃ£o foi possÃ­vel carregar os modelos do Codex: {error}"))?
}

#[tauri::command]
pub async fn get_codex_usage(
    state: State<'_, CodexProcessState>,
    codex_command: Option<String>,
) -> Result<CodexUsage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_codex_server(&state, codex_command, |server| {
            let limits = server.request("account/rateLimits/read", json!({}))?;
            let snapshot = limits.get("rateLimits").unwrap_or(&Value::Null);
            let usage = server.request("account/usage/read", json!({})).ok();

            Ok(CodexUsage {
                plan_type: snapshot
                    .get("planType")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                limit_name: snapshot
                    .get("limitName")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                primary: parse_usage_window(snapshot.get("primary")),
                secondary: parse_usage_window(snapshot.get("secondary")),
                rate_limit_reached_type: snapshot
                    .get("rateLimitReachedType")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                lifetime_tokens: usage
                    .as_ref()
                    .and_then(|value| value.pointer("/summary/lifetimeTokens"))
                    .and_then(Value::as_i64),
            })
        })
    })
    .await
    .map_err(|error| format!("NÃ£o foi possÃ­vel carregar o limite do Codex: {error}"))?
}

fn parse_usage_window(value: Option<&Value>) -> Option<CodexUsageWindow> {
    let value = value?;
    Some(CodexUsageWindow {
        used_percent: value
            .get("usedPercent")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        window_duration_mins: value.get("windowDurationMins").and_then(Value::as_i64),
        resets_at: value.get("resetsAt").and_then(Value::as_i64),
    })
}

fn with_codex_server<T, F>(
    state: &CodexProcessState,
    codex_command: Option<String>,
    action: F,
) -> Result<T, String>
where
    F: FnOnce(&mut CodexServer) -> Result<T, String>,
{
    let mut server_guard = state
        .server
        .lock()
        .map_err(|_| "NÃ£o foi possÃ­vel controlar o Codex CLI.".to_string())?;

    if server_guard
        .as_mut()
        .and_then(|server| server.child.try_wait().ok().flatten())
        .is_some()
    {
        *server_guard = None;
    }

    if server_guard.is_none() {
        let command = codex_command
            .map(PathBuf::from)
            .or_else(resolve_codex_command)
            .ok_or_else(|| "O Codex CLI nÃ£o estÃ¡ disponÃ­vel.".to_string())?;
        *server_guard = Some(CodexServer::start(&command)?);
    }

    let server = server_guard
        .as_mut()
        .ok_or_else(|| "NÃ£o foi possÃ­vel iniciar o Codex CLI.".to_string())?;
    action(server)
}

#[tauri::command]
pub async fn run_codex(
    state: State<'_, CodexProcessState>,
    repository_path: String,
    prompt: String,
    context: Option<String>,
    allow_edits: bool,
    codex_command: Option<String>,
    session_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<CodexRunResult, String> {
    let state = state.inner().clone();

    let task_result = tauri::async_runtime::spawn_blocking(move || {
        catch_unwind(AssertUnwindSafe(|| {
            run_codex_blocking(
                state,
                repository_path,
                prompt,
                context,
                allow_edits,
                codex_command,
                session_id,
                model,
                reasoning_effort,
            )
        }))
    })
    .await
    .map_err(|error| format!("Não foi possível acompanhar o Codex CLI: {error}"))?;

    task_result.map_err(|_| {
        "O Codex encontrou um erro interno, mas o GitLuna continua aberto.".to_string()
    })?
}

fn run_codex_blocking(
    state: CodexProcessState,
    repository_path: String,
    prompt: String,
    context: Option<String>,
    allow_edits: bool,
    codex_command: Option<String>,
    session_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<CodexRunResult, String> {
    let repository_path = PathBuf::from(repository_path.trim());
    ensure_repository(&repository_path)?;

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Digite uma solicitação para o Codex.".to_string());
    }

    if let Some(result) = run_codex_app_server(
        &state,
        &repository_path,
        prompt,
        allow_edits,
        codex_command.clone(),
        session_id.clone(),
        model.clone(),
        reasoning_effort.clone(),
    )? {
        return Ok(result);
    }

    let command = if let Some(codex_command) = codex_command {
        PathBuf::from(codex_command)
    } else {
        codex_commands()
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
            .clone()
    };

    let sandbox = if allow_edits {
        "workspace-write"
    } else {
        "read-only"
    };
    let full_prompt = limit_prompt(build_prompt(prompt, context.as_deref()));
    let mut codex_args = vec![
        "--ask-for-approval".to_string(),
        "never".to_string(),
        "exec".to_string(),
        "--ephemeral".to_string(),
        "--sandbox".to_string(),
        sandbox.to_string(),
    ];
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        codex_args.extend(["--model".to_string(), model]);
    }
    if let Some(reasoning_effort) = reasoning_effort.filter(|value| !value.trim().is_empty()) {
        codex_args.extend([
            "-c".to_string(),
            format!("model_reasoning_effort=\"{reasoning_effort}\""),
        ]);
    }
    codex_args.push(full_prompt);

    let (stdout_path, stderr_path) = output_paths();
    let stdout_file = File::create(&stdout_path)
        .map_err(|error| format!("Não foi possível preparar a saída do Codex: {error}"))?;
    let stderr_file = File::create(&stderr_path)
        .map_err(|error| format!("Não foi possível preparar os erros do Codex: {error}"))?;
    let mut process = Command::new(&command);
    process
        .current_dir(&repository_path)
        .args(codex_args)
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

fn run_codex_app_server(
    state: &CodexProcessState,
    repository_path: &PathBuf,
    prompt: &str,
    allow_edits: bool,
    codex_command: Option<String>,
    session_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<Option<CodexRunResult>, String> {
    let mut server_guard = state
        .server
        .lock()
        .map_err(|_| "Não foi possível controlar o Codex CLI.".to_string())?;

    if server_guard
        .as_mut()
        .and_then(|server| server.child.try_wait().ok().flatten())
        .is_some()
    {
        *server_guard = None;
    }

    if server_guard.is_none() {
        let command = codex_command
            .map(PathBuf::from)
            .or_else(resolve_codex_command);
        let Some(command) = command else {
            return Ok(None);
        };

        let server = match CodexServer::start(&command) {
            Ok(server) => server,
            Err(_) => return Ok(None),
        };
        *server_guard = Some(server);
    }

    let server = server_guard
        .as_mut()
        .ok_or_else(|| "Não foi possível iniciar o Codex CLI.".to_string())?;
    let session_key = format!(
        "{}:{}:{}",
        repository_path.display(),
        session_id.unwrap_or_else(|| "default".to_string()),
        allow_edits
    );
    let thread_id = if let Some(thread_id) = server.threads.get(&session_key) {
        thread_id.clone()
    } else {
        let thread = server.request(
            "thread/start",
            json!({
                "cwd": repository_path.to_string_lossy(),
                "approvalPolicy": "never",
                "sandbox": if allow_edits { "workspace-write" } else { "read-only" },
                "ephemeral": true,
                "model": model.clone()
            }),
        )?;
        let thread_id = thread
            .get("thread")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "O Codex não retornou o identificador da sessão.".to_string())?
            .to_string();
        server.threads.insert(session_key, thread_id.clone());
        thread_id
    };

    let pid = server.child.id();
    if let Ok(mut active_pid) = state.active_server_pid.lock() {
        *active_pid = Some(pid);
    }
    let result = server.turn(
        &thread_id,
        prompt,
        model.as_deref(),
        reasoning_effort.as_deref(),
    );
    if let Ok(mut active_pid) = state.active_server_pid.lock() {
        *active_pid = None;
    }

    result.map(Some)
}

impl CodexServer {
    fn start(command: &PathBuf) -> Result<Self, String> {
        let mut process = Command::new(command);
        process
            .arg("app-server")
            .arg("--stdio")
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = process
            .spawn()
            .map_err(|error| format!("Não foi possível iniciar o Codex app-server: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "O Codex não abriu a entrada do app-server.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "O Codex não abriu a saída do app-server.".to_string())?;
        let mut server = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_request_id: 1,
            threads: HashMap::new(),
        };

        server.request(
            "initialize",
            json!({
                "clientInfo": { "name": "gitluna", "version": "0.1.0" },
                "capabilities": { "experimentalApi": true }
            }),
        )?;
        server.notify("initialized", json!({}))?;
        Ok(server)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "method": method, "params": params });
        self.write_message(&message)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        let message = json!({ "method": method, "id": id, "params": params });
        self.write_message(&message)?;

        loop {
            let message = self.read_message()?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }

            if let Some(error) = message.get("error") {
                return Err(format!("Erro do Codex: {error}"));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn turn(
        &mut self,
        thread_id: &str,
        prompt: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<CodexRunResult, String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.write_message(&json!({
            "method": "turn/start",
            "id": id,
            "params": {
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt }],
                "model": model,
                "effort": reasoning_effort
            }
        }))?;

        let mut output = String::new();
        loop {
            let message = self.read_message()?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(format!("Erro do Codex: {error}"));
                }
                continue;
            }

            if message.get("method").and_then(Value::as_str) == Some("item/completed") {
                let item = message.pointer("/params/item");
                if item
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    == Some("agentMessage")
                {
                    if let Some(text) = item
                        .and_then(|value| value.get("text"))
                        .and_then(Value::as_str)
                    {
                        output.push_str(text);
                    }
                }
            }

            if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
                break;
            }
        }

        let output = limit_output(output);
        if output.is_empty() {
            return Err("O Codex não retornou uma resposta.".to_string());
        }

        Ok(CodexRunResult { output })
    }

    fn write_message(&mut self, message: &Value) -> Result<(), String> {
        let serialized = serde_json::to_string(message)
            .map_err(|error| format!("Não foi possível preparar a mensagem do Codex: {error}"))?;
        self.stdin
            .write_all(format!("{serialized}\n").as_bytes())
            .map_err(|error| format!("Não foi possível enviar a solicitação ao Codex: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("Não foi possível enviar a solicitação ao Codex: {error}"))
    }

    fn read_message(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        let bytes = self
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("Não foi possível ler a resposta do Codex: {error}"))?;
        if bytes == 0 {
            return Err("O Codex app-server encerrou a conexão.".to_string());
        }

        serde_json::from_str(line.trim())
            .map_err(|error| format!("O Codex retornou uma mensagem inválida: {error}"))
    }
}

#[tauri::command]
pub fn cancel_codex(state: State<'_, CodexProcessState>) -> Result<(), String> {
    if let Ok(active_pid) = state.active_server_pid.lock() {
        if let Some(pid) = *active_pid {
            terminate_process(pid);
            return Ok(());
        }
    }

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

fn limit_prompt(prompt: String) -> String {
    if prompt.chars().count() <= MAX_PROMPT_LENGTH {
        return prompt;
    }

    let shortened = prompt.chars().take(MAX_PROMPT_LENGTH).collect::<String>();
    format!(
        "{shortened}\n\n[Contexto anterior reduzido pelo GitLuna para manter a execução estável.]"
    )
}

fn output_paths() -> (PathBuf, PathBuf) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let prefix = format!("gitluna-codex-{}-{timestamp}", std::process::id());
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
    format!("{shortened}\n\n[Saída truncada pelo GitLuna]")
}

fn resolve_codex_command() -> Option<PathBuf> {
    codex_commands().into_iter().find(|candidate| {
        Command::new(candidate)
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    })
}

fn terminate_process(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
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
