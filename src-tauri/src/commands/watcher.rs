use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
pub struct RepositoryChangedPayload {
    pub path: String,
}

pub struct RepoWatcherHandle {
    pub _watcher: RecommendedWatcher,
    pub stop_sender: Sender<()>,
}

#[derive(Default)]
pub struct WatcherState {
    pub active_watcher: Mutex<Option<(String, RepoWatcherHandle)>>,
}

fn is_noise_path(path_str: &str) -> bool {
    let normalized = path_str.replace('\\', "/");

    if normalized.ends_with(".lock") {
        return true;
    }

    const NOISE_FRAGMENTS: [&str; 19] = [
        "/.git/objects/",
        "/.git/logs/",
        "/.git/lfs/",
        "/.git/fsmonitor--daemon/",
        "/node_modules/",
        "/target/",
        "/dist/",
        "/build/",
        "/.angular/",
        "/.vscode/",
        "/.idea/",
        "/.cache/",
        "/.next/",
        "/.nuxt/",
        "/.svelte-kit/",
        "/.turbo/",
        "/coverage/",
        "/.venv/",
        "/__pycache__/",
    ];

    NOISE_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
}

fn is_relevant_event(event: &Event) -> bool {
    if event.paths.is_empty() {
        return true;
    }

    event.paths.iter().any(|path| {
        let path_str = path.to_string_lossy();
        !is_noise_path(&path_str)
    })
}

#[tauri::command(async)]
pub fn watch_repository(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let repo_path = PathBuf::from(&path);
    if !repo_path.is_dir() || !repo_path.join(".git").exists() {
        return Err("O repositório selecionado não é válido.".to_string());
    }

    let mut lock = state
        .active_watcher
        .lock()
        .map_err(|err| format!("Erro ao obter trava do watcher: {err}"))?;

    // If already watching the same path, nothing to do
    if let Some((current_path, _)) = lock.as_ref() {
        if current_path == &path {
            return Ok(());
        }
    }

    // Stop existing watcher if present
    if let Some((_, old_handle)) = lock.take() {
        let _ = old_handle.stop_sender.send(());
    }

    let (event_tx, event_rx): (Sender<Event>, Receiver<Event>) = channel();
    let (stop_tx, stop_rx): (Sender<()>, Receiver<()>) = channel();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = event_tx.send(event);
            }
        },
        Config::default(),
    )
    .map_err(|err| format!("Falha ao inicializar file watcher: {err}"))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|err| format!("Falha ao observar diretório: {err}"))?;

    let app_handle = app.clone();
    let watch_path = path.clone();

    std::thread::spawn(move || {
        let debounce_duration = Duration::from_millis(250);

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match event_rx.recv_timeout(Duration::from_millis(400)) {
                Ok(first_event) => {
                    if is_relevant_event(&first_event) {
                        let start = Instant::now();
                        while start.elapsed() < debounce_duration {
                            if stop_rx.try_recv().is_ok() {
                                return;
                            }
                            let remaining = debounce_duration.saturating_sub(start.elapsed());
                            if remaining.is_zero() {
                                break;
                            }
                            let _ = event_rx.recv_timeout(remaining);
                        }

                        let _ = app_handle.emit(
                            "repository-changed",
                            RepositoryChangedPayload {
                                path: watch_path.clone(),
                            },
                        );
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
        }
    });

    *lock = Some((
        path,
        RepoWatcherHandle {
            _watcher: watcher,
            stop_sender: stop_tx,
        },
    ));

    Ok(())
}

#[tauri::command(async)]
pub fn unwatch_repository(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut lock = state
        .active_watcher
        .lock()
        .map_err(|err| format!("Erro ao obter trava do watcher: {err}"))?;

    if let Some((_, handle)) = lock.take() {
        let _ = handle.stop_sender.send(());
    }

    Ok(())
}
