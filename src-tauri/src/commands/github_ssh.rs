//! Integração com o GitHub por chave SSH.
//!
//! O modo SSH usa o OpenSSH instalado no computador: nenhum token é criado,
//! guardado ou enviado pelo GitLuna. Este módulo apenas descobre as chaves que
//! já existem em `~/.ssh`, pode gerar uma chave dedicada e confirma com o
//! GitHub se a chave escolhida autentica a conta.

use super::process;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const SSH_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_KEYGEN_TIMEOUT: Duration = Duration::from_secs(30);
const GITHUB_SSH_HOST: &str = "git@github.com";
const MANAGED_KEY_PREFIX: &str = "gitluna_";
const MANAGED_KEY_BASE_NAME: &str = "gitluna_github_ed25519";
const KNOWN_ALGORITHMS: [&str; 4] = ["ssh-", "ecdsa-", "sk-ssh-", "sk-ecdsa-"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub name: String,
    pub path: String,
    pub public_key: String,
    pub algorithm: String,
    pub managed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbe {
    pub authenticated: bool,
    pub login: Option<String>,
    pub message: String,
}

#[tauri::command]
pub async fn list_ssh_keys() -> Result<Vec<SshKey>, String> {
    run_blocking(list_ssh_keys_impl).await
}

#[tauri::command]
pub async fn generate_ssh_key() -> Result<SshKey, String> {
    run_blocking(generate_ssh_key_impl).await
}

#[tauri::command]
pub async fn probe_github_ssh(key_path: Option<String>) -> Result<SshProbe, String> {
    run_blocking(move || probe_github_ssh_impl(key_path)).await
}

#[tauri::command]
pub async fn delete_ssh_key(path: String) -> Result<(), String> {
    run_blocking(move || delete_ssh_key_impl(path)).await
}

/// Executa trabalho bloqueante (disco, processos) fora da thread principal.
async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Falha ao executar a operação SSH: {error}"))?
}

fn list_ssh_keys_impl() -> Result<Vec<SshKey>, String> {
    let directory = ssh_directory()?;

    if !directory.is_dir() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(&directory)
        .map_err(|error| format!("Não foi possível ler a pasta de chaves SSH: {error}"))?;
    let mut keys = Vec::new();

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Não foi possível ler a pasta de chaves SSH: {error}"))?;
        let public_path = entry.path();

        if !public_path.is_file() || !has_public_key_extension(&public_path) {
            continue;
        }

        // O Git precisa da chave privada; a pública é só usada para exibição.
        let private_path = private_key_path(&public_path);
        if !private_path.is_file() {
            continue;
        }

        let Some(public_key) = read_public_key(&public_path) else {
            continue;
        };
        let Some(algorithm) = algorithm_of(&public_key) else {
            continue;
        };
        let Some(name) = private_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
        else {
            continue;
        };

        keys.push(SshKey {
            managed: name.starts_with(MANAGED_KEY_PREFIX),
            name,
            path: private_path.to_string_lossy().to_string(),
            public_key,
            algorithm,
        });
    }

    keys.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });

    Ok(keys)
}

fn generate_ssh_key_impl() -> Result<SshKey, String> {
    let directory = ssh_directory()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Não foi possível criar a pasta de chaves SSH: {error}"))?;

    let (private_path, public_path) = available_key_paths(&directory)?;
    let comment = format!("gitluna@{}", computer_name());

    let mut command = Command::new("ssh-keygen");
    command
        .arg("-q")
        .arg("-t")
        .arg("ed25519")
        .arg("-N")
        .arg("")
        .arg("-C")
        .arg(&comment)
        .arg("-f")
        .arg(&private_path);

    let output = process::run(
        command,
        SSH_KEYGEN_TIMEOUT,
        "ssh-keygen",
        "O ssh-keygen demorou muito para responder. Tente gerar a chave pelo terminal.",
    )?;

    if !output.success() {
        let detail = output.stderr().trim().to_string();
        let _ = std::fs::remove_file(&private_path);
        return Err(if detail.is_empty() {
            "Não foi possível gerar a chave SSH neste computador.".to_string()
        } else {
            format!("Não foi possível gerar a chave SSH: {detail}")
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&private_path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o600);
            let _ = std::fs::set_permissions(&private_path, permissions);
        }
    }

    let public_key = read_public_key(&public_path).ok_or_else(|| {
        "A chave SSH foi criada, mas a chave pública não pôde ser lida.".to_string()
    })?;
    let algorithm = algorithm_of(&public_key).unwrap_or_else(|| "ssh-ed25519".to_string());
    let name = private_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(MANAGED_KEY_BASE_NAME)
        .to_string();

    Ok(SshKey {
        managed: true,
        name,
        path: private_path.to_string_lossy().to_string(),
        public_key,
        algorithm,
    })
}

fn probe_github_ssh_impl(key_path: Option<String>) -> Result<SshProbe, String> {
    let key = match key_path {
        Some(path) if !path.trim().is_empty() => Some(validate_key_path(&path)?),
        _ => None,
    };

    let mut command = Command::new("ssh");
    command
        .arg("-T")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=20");

    if let Some(key) = key.as_ref() {
        command
            .arg("-o")
            .arg("IdentitiesOnly=yes")
            .arg("-i")
            .arg(key);
    }

    command.arg(GITHUB_SSH_HOST);

    let output = process::run(
        command,
        SSH_PROBE_TIMEOUT,
        "SSH",
        "O GitHub não respondeu à verificação SSH em tempo hábil. Verifique a conexão e tente novamente.",
    )?;

    // O GitHub responde a `ssh -T` em stderr e encerra com código 1 mesmo
    // quando a autenticação funciona; por isso a saída decide o resultado.
    let combined = format!("{}\n{}", output.stdout(), output.stderr());
    let login = parse_authenticated_login(&combined);
    let message = summarize_output(&combined);

    Ok(SshProbe {
        authenticated: login.is_some(),
        login,
        message,
    })
}

fn delete_ssh_key_impl(path: String) -> Result<(), String> {
    let directory = ssh_directory()?;
    let key_path = validate_key_path(&path)?;
    let name = key_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();

    // Só removemos chaves que o próprio GitLuna criou, e somente dentro de
    // `~/.ssh`: qualquer outro caminho é responsabilidade do usuário.
    if !name.starts_with(MANAGED_KEY_PREFIX) {
        return Err("Somente chaves criadas pelo GitLuna podem ser removidas por aqui.".to_string());
    }

    let canonical_directory = std::fs::canonicalize(&directory)
        .map_err(|error| format!("Não foi possível localizar a pasta de chaves SSH: {error}"))?;
    let canonical_key = std::fs::canonicalize(&key_path)
        .map_err(|error| format!("Não foi possível localizar a chave SSH: {error}"))?;

    if !canonical_key.starts_with(&canonical_directory) {
        return Err("A chave SSH informada está fora da pasta de chaves do usuário.".to_string());
    }

    std::fs::remove_file(&canonical_key)
        .map_err(|error| format!("Não foi possível remover a chave SSH: {error}"))?;

    let public_key = public_key_path(&key_path);
    if public_key.exists() {
        let _ = std::fs::remove_file(&public_key);
    }

    Ok(())
}

fn ssh_directory() -> Result<PathBuf, String> {
    Ok(home_directory()?.join(".ssh"))
}

fn home_directory() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .ok_or_else(|| {
            "Não foi possível localizar a pasta do usuário neste computador.".to_string()
        })
}

fn available_key_paths(directory: &Path) -> Result<(PathBuf, PathBuf), String> {
    for index in 0..20 {
        let name = if index == 0 {
            MANAGED_KEY_BASE_NAME.to_string()
        } else {
            format!("{MANAGED_KEY_BASE_NAME}_{index}")
        };
        let private_path = directory.join(&name);
        let public_path = public_key_path(&private_path);

        if !private_path.exists() && !public_path.exists() {
            return Ok((private_path, public_path));
        }
    }

    Err("Já existem muitas chaves do GitLuna nesta pasta. Remova uma delas e tente novamente."
        .to_string())
}

fn validate_key_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Err("Nenhuma chave SSH foi informada.".to_string());
    }

    let key_path = PathBuf::from(trimmed);
    if !key_path.is_file() {
        return Err(
            "A chave SSH selecionada não foi encontrada. Atualize a lista e tente novamente."
                .to_string(),
        );
    }

    Ok(key_path)
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "computador".to_string())
}

fn has_public_key_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("pub"))
        .unwrap_or(false)
}

fn private_key_path(public_path: &Path) -> PathBuf {
    let name = public_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let trimmed = name
        .strip_suffix(".pub")
        .or_else(|| name.strip_suffix(".PUB"))
        .unwrap_or(name);

    public_path.with_file_name(trimmed)
}

fn public_key_path(private_path: &Path) -> PathBuf {
    let mut name = private_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    name.push_str(".pub");

    private_path.with_file_name(name)
}

fn read_public_key(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let line = content.lines().next()?.trim();

    (!line.is_empty()).then(|| line.to_string())
}

fn algorithm_of(public_key: &str) -> Option<String> {
    let algorithm = public_key.split_whitespace().next()?;
    KNOWN_ALGORITHMS
        .iter()
        .any(|prefix| algorithm.starts_with(prefix))
        .then(|| algorithm.to_string())
}

/// Extrai o login de `Hi usuario! You've successfully authenticated...`.
fn parse_authenticated_login(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("Hi ")?;
        let (login, _) = rest.split_once('!')?;
        let login = login.trim();

        (!login.is_empty() && !login.contains(char::is_whitespace))
            .then(|| login.to_string())
    })
}

fn summarize_output(output: &str) -> String {
    let message = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let limit = 400;

    if message.chars().count() <= limit {
        return message;
    }

    message.chars().take(limit).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifica_o_login_na_resposta_do_github() {
        let output = "Hi daniel! You've successfully authenticated, but GitHub does not provide shell access.\n";

        assert_eq!(parse_authenticated_login(output), Some("daniel".to_string()));
    }

    #[test]
    fn ignora_respostas_sem_autenticacao() {
        assert_eq!(
            parse_authenticated_login("git@github.com: Permission denied (publickey).\n"),
            None
        );
        assert_eq!(parse_authenticated_login("Hi !\n"), None);
        assert_eq!(parse_authenticated_login(""), None);
    }

    #[test]
    fn reconhece_algoritmos_de_chave_conhecidos() {
        assert_eq!(
            algorithm_of("ssh-ed25519 AAAAC3Nza gitluna@pc").as_deref(),
            Some("ssh-ed25519")
        );
        assert_eq!(algorithm_of("ssh-rsa AAAAB3Nz"), Some("ssh-rsa".to_string()));
        assert_eq!(algorithm_of("texto qualquer"), None);
    }

    #[test]
    fn deriva_o_caminho_da_chave_privada_e_publica() {
        let directory = std::env::temp_dir();

        assert_eq!(
            private_key_path(&directory.join("id_ed25519.pub")),
            directory.join("id_ed25519")
        );
        assert_eq!(
            public_key_path(&directory.join("id_ed25519")),
            directory.join("id_ed25519.pub")
        );
    }

    #[test]
    fn resume_a_saida_com_limite_de_caracteres() {
        let output = "linha 1\n\n  linha 2  \n";

        assert_eq!(summarize_output(output), "linha 1\nlinha 2");
    }
}
