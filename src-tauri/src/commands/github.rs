use keyring::Entry;
use reqwest::header::ACCEPT;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

const GITHUB_API_VERSION: &str = "2022-11-28";
const TOKEN_SERVICE: &str = "org.gitluna.desktop.github";

#[derive(Default)]
pub struct GithubCredentialState {
    credentials: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    pub id: u64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub html_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowPoll {
    pub status: String,
    pub user: Option<GithubUser>,
    pub interval: Option<u64>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub description: Option<String>,
    pub clone_url: String,
    pub html_url: String,
    pub private: bool,
    pub owner_login: String,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token_expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GithubUserResponse {
    id: u64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRepositoryResponse {
    id: u64,
    name: String,
    full_name: String,
    description: Option<String>,
    clone_url: String,
    html_url: String,
    private: bool,
    owner: GithubRepositoryOwner,
}

#[derive(Debug, Deserialize)]
struct GithubRepositoryOwner {
    login: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredCredential {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    refresh_token_expires_at: Option<u64>,
}

#[tauri::command]
pub async fn start_device_flow(client_id: String) -> Result<DeviceFlowStart, String> {
    let client_id = client_id.trim();

    if client_id.is_empty() {
        return Err("O Client ID do GitHub App não foi configurado.".to_string());
    }

    let client = github_client()?;
    let response = client
        .post("https://github.com/login/device/code")
        .query(&[("client_id", client_id)])
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Não foi possível iniciar a conexão com o GitHub: {error}"))?;

    let status = response.status();
    let body = response
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|error| format_github_response_error(status, error.to_string()))?;

    Ok(DeviceFlowStart {
        device_code: body.device_code,
        user_code: body.user_code,
        verification_uri: body.verification_uri,
        verification_uri_complete: body.verification_uri_complete,
        expires_in: body.expires_in,
        interval: body.interval.unwrap_or(5),
    })
}

#[tauri::command]
pub async fn poll_device_flow(
    state: State<'_, GithubCredentialState>,
    client_id: String,
    device_code: String,
    workspace_id: String,
) -> Result<DeviceFlowPoll, String> {
    let client_id = client_id.trim();
    let device_code = device_code.trim();

    if client_id.is_empty() || device_code.is_empty() {
        return Err("Os dados temporários da autorização estão incompletos.".to_string());
    }

    let client = github_client()?;
    let response = client
        .post("https://github.com/login/oauth/access_token")
        .query(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Não foi possível consultar a autorização do GitHub: {error}"))?;

    let status = response.status();
    let token = response
        .json::<TokenResponse>()
        .await
        .map_err(|error| format_github_response_error(status, error.to_string()))?;

    if let Some(access_token) = token.access_token {
        let user = get_github_user(&client, &access_token).await?;
        let session_access_token = access_token.clone();
        store_credential(
            &workspace_id,
            user.id,
            StoredCredential {
                access_token,
                refresh_token: token.refresh_token,
                expires_at: token
                    .expires_in
                    .map(|seconds| unix_now().saturating_add(seconds)),
                refresh_token_expires_at: token
                    .refresh_token_expires_in
                    .map(|seconds| unix_now().saturating_add(seconds)),
            },
        )?;
        cache_credential(&state, &workspace_id, user.id, &session_access_token);

        return Ok(DeviceFlowPoll {
            status: "authorized".to_string(),
            user: Some(user),
            interval: None,
            message: None,
        });
    }

    let error = token.error.unwrap_or_else(|| "unknown_error".to_string());
    let message = token.error_description.or_else(|| Some(error.clone()));

    let poll_status = match error.as_str() {
        "authorization_pending" => "pending",
        "slow_down" => "slowDown",
        "access_denied" => "denied",
        "expired_token" => "expired",
        "device_flow_disabled" => "disabled",
        _ => "error",
    };

    Ok(DeviceFlowPoll {
        status: poll_status.to_string(),
        user: None,
        interval: token.interval,
        message,
    })
}

#[tauri::command]
pub async fn list_repositories(
    state: State<'_, GithubCredentialState>,
    workspace_id: String,
    user_id: u64,
) -> Result<Vec<GithubRepository>, String> {
    let access_token = get_access_token(&state, &workspace_id, user_id)?;
    let client = github_client()?;
    let mut repositories = Vec::new();

    for page in 1..=3 {
        let response = client
            .get("https://api.github.com/user/repos")
            .bearer_auth(&access_token)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .query(&[
                ("per_page", "100".to_string()),
                ("page", page.to_string()),
                (
                    "affiliation",
                    "owner,collaborator,organization_member".to_string(),
                ),
                ("sort", "updated".to_string()),
            ])
            .send()
            .await
            .map_err(|error| {
                format!("Não foi possível buscar os repositórios do GitHub: {error}")
            })?;

        let status = response.status();
        let page_repositories = response
            .json::<Vec<GithubRepositoryResponse>>()
            .await
            .map_err(|error| format_github_response_error(status, error.to_string()))?;

        let page_is_empty = page_repositories.is_empty();
        repositories.extend(
            page_repositories
                .into_iter()
                .map(|repository| GithubRepository {
                    id: repository.id,
                    name: repository.name,
                    full_name: repository.full_name,
                    description: repository.description,
                    clone_url: repository.clone_url,
                    html_url: repository.html_url,
                    private: repository.private,
                    owner_login: repository.owner.login,
                }),
        );

        if page_is_empty {
            break;
        }
    }

    Ok(repositories)
}

#[tauri::command]
pub fn disconnect_account(
    state: State<'_, GithubCredentialState>,
    workspace_id: String,
    user_id: u64,
) -> Result<(), String> {
    if let Ok(mut credentials) = state.credentials.lock() {
        credentials.remove(&credential_key(&workspace_id, user_id));
    }

    disconnect_account_from_storage(&workspace_id, user_id)
}

fn disconnect_account_from_storage(workspace_id: &str, user_id: u64) -> Result<(), String> {
    delete_credential(&credential_entry(&workspace_id, user_id)?)?;
    delete_credential(&global_credential_entry(user_id)?)
}

async fn get_github_user(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<GithubUser, String> {
    let response = client
        .get("https://api.github.com/user")
        .bearer_auth(access_token)
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .send()
        .await
        .map_err(|error| format!("Não foi possível identificar a conta do GitHub: {error}"))?;

    let status = response.status();
    let user = response
        .json::<GithubUserResponse>()
        .await
        .map_err(|error| format_github_response_error(status, error.to_string()))?;

    Ok(GithubUser {
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
    })
}

fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("GitLuna/0.1.0")
        .build()
        .map_err(|error| format!("Não foi possível preparar a conexão com o GitHub: {error}"))
}

fn credential_entry(workspace_id: &str, user_id: u64) -> Result<Entry, String> {
    Entry::new(TOKEN_SERVICE, &format!("{workspace_id}:{user_id}"))
        .map_err(|error| format!("Não foi possível acessar o armazenamento seguro: {error}"))
}

fn global_credential_entry(user_id: u64) -> Result<Entry, String> {
    Entry::new(TOKEN_SERVICE, &format!("user:{user_id}"))
        .map_err(|error| format!("Não foi possível acessar o armazenamento seguro: {error}"))
}

fn store_credential(
    workspace_id: &str,
    user_id: u64,
    credential: StoredCredential,
) -> Result<(), String> {
    let entry = credential_entry(workspace_id, user_id)?;
    let serialized = serde_json::to_string(&credential)
        .map_err(|error| format!("Não foi possível preparar a credencial segura: {error}"))?;

    entry
        .set_password(&serialized)
        .map_err(|error| format!("Não foi possível salvar a credencial com segurança: {error}"))?;
    global_credential_entry(user_id)?
        .set_password(&serialized)
        .map_err(|error| format!("Não foi possível salvar a credencial com segurança: {error}"))
}

pub fn get_access_token(
    state: &GithubCredentialState,
    workspace_id: &str,
    user_id: u64,
) -> Result<String, String> {
    if let Ok(credentials) = state.credentials.lock() {
        if let Some(access_token) = credentials.get(&credential_key(workspace_id, user_id)) {
            return Ok(access_token.clone());
        }
    }

    let serialized = credential_entry(workspace_id, user_id)
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .or_else(|_| {
            global_credential_entry(user_id)
                .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        })
        .map_err(|error| {
            format!(
                "A autorização da conta do GitHub não está disponível neste computador. Reconecte a conta em Integrações. ({error})"
            )
        })?;
    let credential = serde_json::from_str::<StoredCredential>(&serialized)
        .map_err(|error| format!("A credencial do GitHub está inválida: {error}"))?;

    cache_credential(state, workspace_id, user_id, &credential.access_token);

    Ok(credential.access_token)
}

fn cache_credential(
    state: &GithubCredentialState,
    workspace_id: &str,
    user_id: u64,
    access_token: &str,
) {
    if let Ok(mut credentials) = state.credentials.lock() {
        credentials.insert(
            credential_key(workspace_id, user_id),
            access_token.to_string(),
        );
    }
}

fn credential_key(workspace_id: &str, user_id: u64) -> String {
    format!("{workspace_id}:{user_id}")
}

fn delete_credential(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(error) if is_missing_credential_error(&error.to_string()) => Ok(()),
        Err(error) => Err(format!(
            "Não foi possível remover a conexão segura: {error}"
        )),
    }
}

fn is_missing_credential_error(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("no entry")
        || normalized.contains("no matching entry")
        || normalized.contains("not found")
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn format_github_response_error(status: reqwest::StatusCode, message: String) -> String {
    format!("O GitHub respondeu com {status}: {message}")
}
