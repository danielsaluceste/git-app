//! Execução de processos externos com coleta de saída e limite de tempo.
//!
//! stdout e stderr são lidos em threads paralelas enquanto o processo roda. Se
//! esperássemos o processo terminar para ler os pipes, uma saída maior que o
//! buffer do sistema poderia bloquear o próprio processo — algo comum em
//! `git diff` longo e em clones grandes.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub struct ProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl ProcessOutput {
    pub fn success(&self) -> bool {
        self.success
    }

    pub fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.stdout).to_string()
    }

    pub fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.stderr).to_string()
    }
}

/// Executa o processo com saída capturada. `subject` nomeia o processo nas
/// mensagens de erro e `timeout_message` é a mensagem devolvida ao usuário
/// quando o limite de tempo é atingido.
pub fn run(
    mut command: Command,
    timeout: Duration,
    subject: &str,
    timeout_message: &str,
) -> Result<ProcessOutput, String> {
    // Nenhum processo daqui é interativo: sem stdin fechado um prompt poderia
    // ficar esperando entrada para sempre.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = command
        .spawn()
        .map_err(|error| format!("Não foi possível executar o {subject}: {error}"))?;

    collect(child, timeout, subject, timeout_message)
}

/// Lê a saída de um processo já iniciado com stdout e stderr em pipes.
pub fn collect(
    mut child: Child,
    timeout: Duration,
    subject: &str,
    timeout_message: &str,
) -> Result<ProcessOutput, String> {
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Não foi possível ler a saída do {subject}."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Não foi possível ler o erro do {subject}."))?;

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
                return Err(timeout_message.to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "Não foi possível verificar o processo do {subject}: {error}"
                ));
            }
        }
    }

    let status = child
        .try_wait()
        .map_err(|error| format!("Não foi possível finalizar o {subject}: {error}"))?
        .ok_or_else(|| format!("O {subject} encerrou sem informar o resultado."))?;
    let (stdout, stdout_result) = stdout_reader
        .join()
        .map_err(|_| format!("Não foi possível ler a saída do {subject}."))?;
    let (stderr, stderr_result) = stderr_reader
        .join()
        .map_err(|_| format!("Não foi possível ler o erro do {subject}."))?;

    stdout_result.map_err(|error| format!("Não foi possível ler a saída do {subject}: {error}"))?;
    stderr_result.map_err(|error| format!("Não foi possível ler o erro do {subject}: {error}"))?;

    Ok(ProcessOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}
