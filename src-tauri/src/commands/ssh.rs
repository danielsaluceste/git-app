//! Chaves SSH do GitHub.
//!
//! O app nunca lê o conteúdo das chaves privadas: a interface exibe apenas a
//! chave pública e a impressão digital. A geração e a validação usam o OpenSSH
//! (`ssh-keygen`/`ssh`), que já é o mesmo cliente usado pelos comandos Git.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SUPPORTED_KEY_TYPES: [&str; 6] = [
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    /// Caminho da chave privada (é ela que autentica no GitHub).
    pub path: String,
    pub public_key_path: String,
    pub name: String,
    pub key_type: String,
    pub bits: Option<u32>,
    pub fingerprint: Option<String>,
    pub comment: Option<String>,
    pub public_key: String,
    pub has_private_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyList {
    pub directory: String,
    pub keys: Vec<SshKey>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionTest {
    /// authenticated | permissionDenied | network | error
    pub status: String,
    pub login: Option<String>,
    pub message: Option<String>,
}

#[tauri::command(async)]
pub fn list_ssh_keys() -> Result<SshKeyList, String> {
    let directory = ssh_directory()?;
    let keys = collect_ssh_keys(&directory)?;

    Ok(SshKeyList {
        directory: directory.display().to_string(),
        keys,
    })
}

fn collect_ssh_keys(directory: &Path) -> Result<Vec<SshKey>, String> {
    let mut keys = Vec::new();

    if !directory.is_dir() {
        return Ok(keys);
    }

    let mut public_keys: Vec<PathBuf> = std::fs::read_dir(directory)
        .map_err(|error| format!("Não foi possível ler a pasta de chaves SSH: {error}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_public_key_path(path))
        .collect();
    public_keys.sort();

    for public_path in public_keys {
        if let Some(key) = summarize_public_key(&public_path) {
            if key.has_private_key {
                keys.push(key);
            }
        }
    }

    keys.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(keys)
}

#[tauri::command(async)]
pub fn inspect_ssh_key(path: String) -> Result<SshKey, String> {
    let selected = PathBuf::from(path.trim());

    if !selected.is_file() {
        return Err("A chave SSH selecionada não foi encontrada.".to_string());
    }

    if is_public_key_path(&selected) {
        return summarize_public_key(&selected)
            .ok_or_else(|| "O arquivo selecionado não é uma chave SSH válida.".to_string());
    }

    if let Some(key) = summarize_public_key(&public_key_for(&selected)) {
        return Ok(key);
    }

    summarize_private_key(&selected)
}

#[tauri::command(async)]
pub fn create_ssh_key(name: String, comment: Option<String>) -> Result<SshKey, String> {
    let file_name = name.trim();
    validate_key_name(file_name)?;

    let directory = ssh_directory()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Não foi possível criar a pasta ~/.ssh: {error}"))?;
    #[cfg(unix)]
    set_directory_permissions(&directory);

    let private_path = directory.join(file_name);
    let public_path = directory.join(format!("{file_name}.pub"));

    if private_path.exists() || public_path.exists() {
        return Err("Já existe uma chave com esse nome na pasta ~/.ssh.".to_string());
    }

    let comment = normalize_comment(comment.unwrap_or_default());
    let output = Command::new("ssh-keygen")
        .arg("-q")
        .arg("-t")
        .arg("ed25519")
        .arg("-N")
        .arg("")
        .arg("-C")
        .arg(&comment)
        .arg("-f")
        .arg(&private_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            format!(
                "Não foi possível executar o ssh-keygen: {error}. Verifique se o OpenSSH está instalado."
            )
        })?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Não foi possível gerar a chave SSH.".to_string()
        } else {
            format!("Não foi possível gerar a chave SSH: {detail}")
        });
    }

    #[cfg(unix)]
    set_key_permissions(&private_path, &public_path);

    summarize_public_key(&public_path)
        .ok_or_else(|| "A chave foi criada, mas não foi possível ler a chave pública.".to_string())
}

#[tauri::command(async)]
pub fn test_ssh_connection(key_path: String) -> Result<SshConnectionTest, String> {
    let private_path = PathBuf::from(key_path.trim());

    if !private_path.is_file() {
        return Err("A chave SSH selecionada não foi encontrada.".to_string());
    }

    if is_public_key_path(&private_path) {
        return Err("Selecione a chave privada (sem .pub) para testar a conexão.".to_string());
    }

    #[cfg(unix)]
    ensure_safe_permissions(&private_path);

    let output = Command::new("ssh")
        .arg("-T")
        .arg("-i")
        .arg(&private_path)
        .arg("-o")
        .arg("IdentitiesOnly=yes")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("NumberOfPasswordPrompts=0")
        .arg("git@github.com")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            format!(
                "Não foi possível executar o SSH: {error}. Verifique se o OpenSSH está instalado."
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = failure_detail(&stderr, &stdout);
    let combined = format!("{stdout}\n{stderr}").to_lowercase();

    if combined.contains("successfully authenticated") {
        return Ok(SshConnectionTest {
            status: "authenticated".to_string(),
            login: extract_login(&format!("{stdout}\n{stderr}")),
            message: None,
        });
    }

    if combined.contains("permission denied") {
        return Ok(SshConnectionTest {
            status: "permissionDenied".to_string(),
            login: None,
            message: detail,
        });
    }

    if combined.contains("could not resolve hostname")
        || combined.contains("connection timed out")
        || combined.contains("network is unreachable")
        || combined.contains("connection refused")
        || combined.contains("no route to host")
    {
        return Ok(SshConnectionTest {
            status: "network".to_string(),
            login: None,
            message: detail,
        });
    }

    Ok(SshConnectionTest {
        status: "error".to_string(),
        login: None,
        message: detail.or_else(|| Some("O SSH encerrou sem uma resposta reconhecida.".to_string())),
    })
}

fn summarize_public_key(public_path: &Path) -> Option<SshKey> {
    let content = std::fs::read_to_string(public_path).ok()?;
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))?;
    let mut parts = line.split_whitespace();
    let raw_type = parts.next()?;
    let key_data = parts.next()?;

    if !SUPPORTED_KEY_TYPES.contains(&raw_type) || key_data.is_empty() {
        return None;
    }

    let comment = parts.collect::<Vec<_>>().join(" ");
    let (bits, fingerprint) = read_key_metadata(public_path);
    let private_path = private_key_for(public_path);

    Some(SshKey {
        path: private_path.display().to_string(),
        public_key_path: public_path.display().to_string(),
        name: public_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("chave SSH")
            .to_string(),
        key_type: key_type_label(raw_type),
        bits,
        fingerprint,
        comment: (!comment.is_empty()).then_some(comment),
        public_key: line.to_string(),
        has_private_key: private_path.is_file(),
    })
}

fn summarize_private_key(private_path: &Path) -> Result<SshKey, String> {
    let derived = derive_public_key(private_path).ok_or_else(|| {
        "Não foi possível ler a chave privada. Se ela tiver passphrase, selecione o arquivo .pub correspondente."
            .to_string()
    })?;
    let mut parts = derived.split_whitespace();
    let raw_type = parts.next().unwrap_or_default();
    let key_data = parts.next().unwrap_or_default();

    if !SUPPORTED_KEY_TYPES.contains(&raw_type) || key_data.is_empty() {
        return Err("O arquivo selecionado não é uma chave SSH válida.".to_string());
    }

    let comment = parts.collect::<Vec<_>>().join(" ");
    let (bits, fingerprint) = read_key_metadata(private_path);

    Ok(SshKey {
        path: private_path.display().to_string(),
        public_key_path: private_path.display().to_string(),
        name: private_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("chave SSH")
            .to_string(),
        key_type: key_type_label(raw_type),
        bits,
        fingerprint,
        comment: (!comment.is_empty()).then_some(comment),
        public_key: derived,
        has_private_key: true,
    })
}

fn derive_public_key(private_path: &Path) -> Option<String> {
    let output = Command::new("ssh-keygen")
        .arg("-y")
        .arg("-P")
        .arg("")
        .arg("-f")
        .arg(private_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let public_key = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!public_key.is_empty()).then_some(public_key)
}

fn read_key_metadata(key_path: &Path) -> (Option<u32>, Option<String>) {
    let output = Command::new("ssh-keygen")
        .arg("-l")
        .arg("-f")
        .arg(key_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    let Ok(output) = output else {
        return (None, None);
    };

    if !output.status.success() {
        return (None, None);
    }

    // Formato: "256 SHA256:abc... comentário (ED25519)"
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let bits = parts.next().and_then(|value| value.parse::<u32>().ok());
    let fingerprint = parts
        .next()
        .filter(|value| value.starts_with("SHA256:") || value.starts_with("MD5:"))
        .map(str::to_string);

    (bits, fingerprint)
}

fn key_type_label(raw_type: &str) -> String {
    if raw_type == "ssh-ed25519" {
        "ED25519".to_string()
    } else if raw_type == "ssh-rsa" {
        "RSA".to_string()
    } else if raw_type.starts_with("ecdsa-sha2-") {
        "ECDSA".to_string()
    } else if raw_type.starts_with("sk-ssh-ed25519") {
        "ED25519 (FIDO)".to_string()
    } else {
        raw_type.to_uppercase()
    }
}

fn is_public_key_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pub"))
}

fn private_key_for(public_path: &Path) -> PathBuf {
    public_path.with_extension("")
}

fn public_key_for(private_path: &Path) -> PathBuf {
    let mut public_path = private_path.as_os_str().to_os_string();
    public_path.push(".pub");
    PathBuf::from(public_path)
}

fn validate_key_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Escolha um nome de até 64 caracteres para a chave.".to_string());
    }

    if name.starts_with('.')
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return Err(
            "Use apenas letras, números, ponto, hífen ou sublinhado no nome da chave.".to_string(),
        );
    }

    if name == "." || name == ".." {
        return Err("Escolha um nome válido para a chave.".to_string());
    }

    Ok(())
}

fn normalize_comment(comment: String) -> String {
    let cleaned: String = comment
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let trimmed = cleaned.trim();

    if trimmed.is_empty() {
        default_comment()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn default_comment() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "gitluna".to_string());
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_default();

    if host.trim().is_empty() {
        format!("{user}@GitLuna")
    } else {
        format!("{user}@{}", host.trim())
    }
}

fn failure_detail(stderr: &str, stdout: &str) -> Option<String> {
    let lines: Vec<&str> = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    lines
        .iter()
        .find(|line| {
            let lowered = line.to_lowercase();
            lowered.contains("permission denied")
                || lowered.contains("load key")
                || lowered.contains("bad permissions")
                || lowered.contains("no such identity")
        })
        .or_else(|| lines.last())
        .map(|line| line.to_string())
}

fn extract_login(output: &str) -> Option<String> {
    let mut words = output.split_whitespace();

    while let Some(word) = words.next() {
        if word.eq_ignore_ascii_case("hi") {
            let login = words.next()?.trim_end_matches('!');
            if !login.is_empty() {
                return Some(login.to_string());
            }
        }
    }

    None
}

fn ssh_directory() -> Result<PathBuf, String> {
    Ok(home_directory()?.join(".ssh"))
}

fn home_directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            let mut home = PathBuf::from(drive);
            home.push(path);
            Some(home)
        });

    home.ok_or_else(|| "Não foi possível localizar a pasta pessoal do usuário.".to_string())
}

#[cfg(unix)]
fn set_directory_permissions(directory: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
}

#[cfg(unix)]
fn set_key_permissions(private_path: &Path, public_path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let _ = std::fs::set_permissions(private_path, std::fs::Permissions::from_mode(0o600));
    let _ = std::fs::set_permissions(public_path, std::fs::Permissions::from_mode(0o644));
}

#[cfg(unix)]
fn ensure_safe_permissions(private_path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let Ok(metadata) = std::fs::metadata(private_path) else {
        return;
    };

    if metadata.permissions().mode() & 0o077 != 0 {
        let _ = std::fs::set_permissions(private_path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_key_name_aceita_nomes_comuns() {
        assert!(validate_key_name("id_ed25519").is_ok());
        assert!(validate_key_name("github-pessoal").is_ok());
        assert!(validate_key_name("id_rsa.work").is_ok());
    }

    #[test]
    fn validate_key_name_rejeita_caminhos_e_caracteres_invalidos() {
        assert!(validate_key_name("../id_rsa").is_err());
        assert!(validate_key_name("chave com espaço").is_err());
        assert!(validate_key_name(".hidden").is_err());
        assert!(validate_key_name("").is_err());
        assert!(validate_key_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn collect_ssh_keys_lista_apenas_chaves_com_par_privado() {
        let directory = std::env::temp_dir().join(format!(
            "gitluna-ssh-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();

        let public_line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8PY2sEtr+qRELsECfQHY5KyfDIks5bP/bu3VmnRYLN test@local";
        std::fs::write(directory.join("id_ed25519.pub"), public_line).unwrap();
        std::fs::write(directory.join("id_ed25519"), "chave privada").unwrap();
        std::fs::write(directory.join("sem_privada.pub"), public_line).unwrap();
        std::fs::write(directory.join("known_hosts"), "github.com ssh-ed25519 AAAA").unwrap();

        let keys = collect_ssh_keys(&directory).unwrap();

        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].name, "id_ed25519");
        assert!(keys[0].has_private_key);
        assert_eq!(keys[0].public_key, public_line);
        assert_eq!(keys[0].key_type, "ED25519");

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn collect_ssh_keys_devolve_lista_vazia_para_pasta_inexistente() {
        let directory = std::env::temp_dir().join("gitluna-ssh-pasta-inexistente");
        let _ = std::fs::remove_dir_all(&directory);

        assert!(collect_ssh_keys(&directory).unwrap().is_empty());
    }

    #[test]
    fn failure_detail_prefere_a_linha_de_erro() {
        let stderr = "Warning: Permanently added 'github.com' to the list of known hosts.\nPermission denied (publickey).";
        assert_eq!(
            failure_detail(stderr, ""),
            Some("Permission denied (publickey).".to_string())
        );
        assert_eq!(
            failure_detail("", "algo inesperado"),
            Some("algo inesperado".to_string())
        );
    }

    #[test]
    fn extract_login_le_a_mensagem_do_github() {
        let output = "Hi daniel-salu! You've successfully authenticated, but GitHub does not provide shell access.";
        assert_eq!(extract_login(output), Some("daniel-salu".to_string()));
        assert_eq!(extract_login("Permission denied (publickey)."), None);
    }

    #[test]
    fn key_type_label_traduz_os_tipos_suportados() {
        assert_eq!(key_type_label("ssh-ed25519"), "ED25519");
        assert_eq!(key_type_label("ssh-rsa"), "RSA");
        assert_eq!(key_type_label("ecdsa-sha2-nistp256"), "ECDSA");
    }
}
