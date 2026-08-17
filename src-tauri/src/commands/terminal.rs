use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputPayload {
    pub session_id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitPayload {
    pub session_id: String,
    pub exit_code: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[allow(dead_code)]
pub struct TerminalSession {
    pub id: String,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct TerminalState {
    pub sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[tauri::command]
pub fn get_available_shells() -> Result<Vec<ShellInfo>, String> {
    let mut shells = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // 1. PowerShell 7 (pwsh)
        if let Ok(path) = which_executable("pwsh.exe") {
            shells.push(ShellInfo {
                id: "pwsh".to_string(),
                name: "PowerShell 7".to_string(),
                path,
                is_default: true,
            });
        }

        // 2. Windows PowerShell (System32)
        let sys_ps = PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        let ps_path = if sys_ps.exists() {
            sys_ps.to_string_lossy().to_string()
        } else {
            which_executable("powershell.exe").unwrap_or_else(|_| "powershell.exe".to_string())
        };

        let has_pwsh = !shells.is_empty();
        shells.push(ShellInfo {
            id: "powershell".to_string(),
            name: "Windows PowerShell".to_string(),
            path: ps_path,
            is_default: !has_pwsh,
        });

        // 3. Git Bash
        let git_bash_candidates = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
        ];

        for candidate in &git_bash_candidates {
            let p = Path::new(candidate);
            if p.exists() {
                shells.push(ShellInfo {
                    id: "git-bash".to_string(),
                    name: "Git Bash".to_string(),
                    path: candidate.to_string(),
                    is_default: false,
                });
                break;
            }
        }

        // 4. Command Prompt (CMD)
        let cmd_path = PathBuf::from(r"C:\Windows\System32\cmd.exe");
        if cmd_path.exists() {
            shells.push(ShellInfo {
                id: "cmd".to_string(),
                name: "Prompt de Comando (CMD)".to_string(),
                path: cmd_path.to_string_lossy().to_string(),
                is_default: false,
            });
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            shells.push(ShellInfo {
                id: "default-shell".to_string(),
                name: format!("Shell padrão ({shell})"),
                path: shell,
                is_default: true,
            });
        }

        let standard_shells = [
            ("/bin/zsh", "Zsh"),
            ("/bin/bash", "Bash"),
            ("/bin/sh", "Sh"),
        ];

        for (path, name) in &standard_shells {
            if Path::new(path).exists() && !shells.iter().any(|s| s.path == *path) {
                shells.push(ShellInfo {
                    id: name.to_lowercase(),
                    name: name.to_string(),
                    path: path.to_string(),
                    is_default: shells.is_empty(),
                });
            }
        }
    }

    Ok(shells)
}

#[tauri::command]
pub fn create_terminal_session(
    app: AppHandle,
    state: State<'_, TerminalState>,
    path: String,
    rows: Option<u16>,
    cols: Option<u16>,
    shell: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();

    let size = PtySize {
        rows: rows.unwrap_or(24).max(5),
        cols: cols.unwrap_or(80).max(10),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Falha ao instanciar PTY do sistema: {e}"))?;

    let shells = get_available_shells()?;
    let selected_shell = if let Some(req_shell) = shell.filter(|s| !s.trim().is_empty()) {
        shells
            .iter()
            .find(|s| s.id == req_shell || s.path == req_shell)
            .map(|s| s.path.clone())
            .unwrap_or(req_shell)
    } else {
        shells
            .iter()
            .find(|s| s.is_default)
            .map(|s| s.path.clone())
            .unwrap_or_else(|| {
                #[cfg(target_os = "windows")]
                {
                    "powershell.exe".to_string()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    "/bin/bash".to_string()
                }
            })
    };

    let mut cmd = CommandBuilder::new(&selected_shell);

    // Set working directory
    let cwd = PathBuf::from(&path);
    if cwd.is_dir() {
        cmd.cwd(cwd);
    }

    // Set standard environment variables
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Falha ao iniciar o processo da shell ({selected_shell}): {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Falha ao obter stream de leitura do terminal: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Falha ao obter stream de escrita do terminal: {e}"))?;

    let session_id = format!("term-{}", SESSION_COUNTER.fetch_add(1, Ordering::SeqCst));
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    // Background thread to read stdout/stderr from PTY
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app_clone.emit(
                        "terminal-exit",
                        TerminalExitPayload {
                            session_id: session_id_clone.clone(),
                            exit_code: None,
                        },
                    );
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(
                        "terminal-output",
                        TerminalOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: text,
                        },
                    );
                }
                Err(_) => {
                    let _ = app_clone.emit(
                        "terminal-exit",
                        TerminalExitPayload {
                            session_id: session_id_clone.clone(),
                            exit_code: None,
                        },
                    );
                    break;
                }
            }
        }
    });

    let session = TerminalSession {
        id: session_id.clone(),
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
    };

    state
        .sessions
        .lock()
        .map_err(|_| "Erro de sincronização de estado do terminal.".to_string())?
        .insert(session_id.clone(), session);

    Ok(session_id)
}

#[tauri::command]
pub fn write_terminal(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Erro de sincronização de estado do terminal.".to_string())?;

    if let Some(session) = sessions.get(&session_id) {
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "Erro ao obter trava do escritor de terminal.".to_string())?;

        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Falha ao escrever no terminal: {e}"))?;

        writer
            .flush()
            .map_err(|e| format!("Falha ao descarregar buffer do terminal: {e}"))?;

        Ok(())
    } else {
        Err(format!("Sessão de terminal '{session_id}' não encontrada."))
    }
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Erro de sincronização de estado do terminal.".to_string())?;

    if let Some(session) = sessions.get(&session_id) {
        let master = session
            .master
            .lock()
            .map_err(|_| "Erro ao obter trava do master PTY.".to_string())?;

        let size = PtySize {
            rows: rows.max(5),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        };

        master
            .resize(size)
            .map_err(|e| format!("Falha ao redimensionar terminal: {e}"))?;

        Ok(())
    } else {
        Err(format!("Sessão de terminal '{session_id}' não encontrada."))
    }
}

#[tauri::command]
pub fn close_terminal(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Erro de sincronização de estado do terminal.".to_string())?;

    if let Some(session) = sessions.remove(&session_id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
        Ok(())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn which_executable(exe_name: &str) -> Result<String, String> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().to_string());
            }
        }
    }
    Err(format!("Executável '{exe_name}' não encontrado no PATH."))
}
