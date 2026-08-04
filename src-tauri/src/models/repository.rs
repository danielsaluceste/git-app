use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct LocalRepositoryInfo {
    pub name: String,
    pub path: String,
}
