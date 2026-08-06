use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct LocalRepositoryInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryReferences {
    pub current_branch: Option<String>,
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub tags: Vec<String>,
    pub stashes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRemote {
    pub name: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperation {
    pub kind: String,
    pub current_branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub current_branch: Option<String>,
    pub is_dirty: bool,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub ahead_count: usize,
    pub behind_count: usize,
    pub conflicted_count: usize,
    pub files: Vec<RepositoryFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFile {
    pub path: String,
    pub status: String,
    pub is_staged: bool,
    pub is_conflicted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub result: String,
    pub base_exists: bool,
    pub ours_exists: bool,
    pub theirs_exists: bool,
    pub result_exists: bool,
    pub is_binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub parents: Vec<String>,
    pub references: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub status: String,
}
