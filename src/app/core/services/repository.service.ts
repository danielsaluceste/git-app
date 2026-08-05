import { Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  LocalRepositoryInfo,
  Repository,
  RepositoryStatus,
  RepositoryReferences,
  RepositoryAuthenticationSource,
  ConflictFile,
} from "../models/repository.model";
import { Commit } from "../models/commit.model";
import { CommitFile } from "../models/commit-file.model";

const STORAGE_KEY = "git-app.repositories";

@Injectable({ providedIn: "root" })
export class RepositoryService {
  private readonly repositoriesState = signal<Repository[]>(this.loadRepositories());
  private readonly activeRepositoryState = signal<Repository | undefined>(undefined);
  private readonly repositoryStatusState = signal<RepositoryStatus | undefined>(undefined);
  private readonly repositoryReferencesState = signal<RepositoryReferences | undefined>(undefined);

  readonly repositories = this.repositoriesState.asReadonly();
  readonly activeRepository = this.activeRepositoryState.asReadonly();
  readonly repositoryStatus = this.repositoryStatusState.asReadonly();
  readonly repositoryReferences = this.repositoryReferencesState.asReadonly();

  async inspectLocalRepository(path: string): Promise<LocalRepositoryInfo> {
    return invoke<LocalRepositoryInfo>("inspect_repository", { path });
  }

  async cloneRepository(
    url: string,
    destination: string,
    operationId: string,
    workspaceId?: string,
    githubUserId?: number,
  ): Promise<LocalRepositoryInfo> {
    return invoke<LocalRepositoryInfo>("clone_repository", {
      url,
      destination,
      operationId,
      workspaceId: workspaceId ?? null,
      githubUserId: githubUserId ?? null,
    });
  }

  async cancelClone(operationId: string): Promise<void> {
    await invoke("cancel_clone", { operationId });
  }

  async getReferences(path: string): Promise<RepositoryReferences> {
    const references = await invoke<RepositoryReferences>("get_repository_references", { path });
    this.repositoryReferencesState.set(references);
    return references;
  }

  async getStatus(path: string): Promise<RepositoryStatus> {
    const status = await invoke<RepositoryStatus>("get_repository_status", { path });
    this.repositoryStatusState.set(status);
    return status;
  }

  async getConflicts(path: string): Promise<ConflictFile[]> {
    return invoke<ConflictFile[]>("get_repository_conflicts", { path });
  }

  async resolveConflict(
    path: string,
    filePath: string,
    content: string,
    keepFile: boolean,
  ): Promise<void> {
    await invoke("resolve_repository_conflict", {
      path,
      filePath,
      content,
      keepFile,
    });
  }

  async resolveConflictSide(path: string, filePath: string, side: "ours" | "theirs"): Promise<void> {
    await invoke("resolve_repository_conflict_side", {
      path,
      filePath,
      side,
    });
  }

  async stageFiles(path: string, files: string[]): Promise<void> {
    await invoke("stage_repository_files", { path, files });
  }

  async unstageFiles(path: string, files: string[]): Promise<void> {
    await invoke("unstage_repository_files", { path, files });
  }

  async commit(path: string, message: string, amend = false): Promise<void> {
    await invoke("commit_repository", { path, message, amend });
  }

  async getLastCommitMessage(path: string): Promise<string> {
    return invoke<string>("get_last_commit_message", { path });
  }

  async revertCommit(path: string, commitHash: string): Promise<void> {
    await invoke("revert_commit", { path, commitHash });
  }

  async getStagedDiff(path: string): Promise<string> {
    return invoke<string>("get_repository_staged_diff", { path });
  }

  async getFileDiff(path: string, filePath: string, staged: boolean): Promise<string> {
    return invoke<string>("get_repository_file_diff", { path, filePath, staged });
  }

  async stash(path: string, message?: string, filePaths?: string[]): Promise<void> {
    await invoke("stash_repository", { path, message, filePaths });
  }

  async applyStash(path: string, stashRef: string): Promise<void> {
    await invoke("apply_stash", { path, stashRef });
  }

  async applyStashFiles(path: string, stashRef: string, filePaths: string[]): Promise<void> {
    await invoke("apply_stash_files", { path, stashRef, filePaths });
  }

  async renameStash(path: string, stashRef: string, message: string): Promise<void> {
    await invoke("rename_stash", { path, stashRef, message });
  }

  async dropStash(path: string, stashRef: string): Promise<void> {
    await invoke("drop_stash", { path, stashRef });
  }

  async getStashFiles(path: string, stashRef: string): Promise<CommitFile[]> {
    return invoke<CommitFile[]>("get_stash_files", { path, stashRef });
  }

  async getStashFileDiff(path: string, stashRef: string, filePath: string): Promise<string> {
    return invoke<string>("get_stash_file_diff", { path, stashRef, filePath });
  }

  async getCommits(
    path: string,
    allBranches = true,
    skip = 0,
    limit = 100,
  ): Promise<Commit[]> {
    return invoke<Commit[]>("get_repository_commits", {
      path,
      allBranches,
      skip,
      limit,
    });
  }

  async getCommitFiles(path: string, commitHash: string): Promise<CommitFile[]> {
    return invoke<CommitFile[]>("get_commit_files", { path, commitHash });
  }

  async getCommitFileDiff(path: string, commitHash: string, filePath: string): Promise<string> {
    return invoke<string>("get_commit_file_diff", { path, commitHash, filePath });
  }

  async fetch(path: string, workspaceId?: string, githubUserId?: number): Promise<void> {
    await invoke("fetch_repository", {
      path,
      workspaceId: workspaceId ?? null,
      githubUserId: githubUserId ?? null,
    });
  }

  async pull(path: string, workspaceId?: string, githubUserId?: number): Promise<void> {
    await invoke("pull_repository", {
      path,
      workspaceId: workspaceId ?? null,
      githubUserId: githubUserId ?? null,
    });
  }

  async push(path: string, workspaceId?: string, githubUserId?: number): Promise<void> {
    await invoke("push_repository", {
      path,
      workspaceId: workspaceId ?? null,
      githubUserId: githubUserId ?? null,
    });
  }

  async checkoutBranch(path: string, branch: string): Promise<void> {
    await invoke("checkout_branch", { path, branch });
  }

  async checkoutCommit(path: string, commitHash: string): Promise<void> {
    await invoke("checkout_commit", { path, commitHash });
  }

  async createBranch(path: string, branch: string, startPoint?: string): Promise<void> {
    await invoke("create_branch", { path, branch, startPoint });
  }

  async renameBranch(path: string, currentName: string, newName: string): Promise<void> {
    await invoke("rename_branch", { path, currentName, newName });
  }

  async deleteBranch(path: string, branch: string): Promise<void> {
    await invoke("delete_branch", { path, branch });
  }

  async deleteRemoteBranch(path: string, remoteBranch: string): Promise<void> {
    await invoke("delete_remote_branch", { path, remoteBranch });
  }

  updateAuthentication(
    repository: Repository,
    source: RepositoryAuthenticationSource,
    githubConnectionId?: number,
  ): boolean {
    if (source === "github" && githubConnectionId === undefined) {
      return false;
    }

    const updatedRepository: Repository = {
      ...repository,
      authenticationSource: source,
      githubConnectionId: source === "github" ? githubConnectionId : undefined,
    };
    const repositories = this.repositoriesState().map((item) =>
      item.workspaceId === repository.workspaceId && item.path === repository.path
        ? updatedRepository
        : item,
    );

    this.setRepositories(repositories);
    if (this.activeRepositoryState()?.path === repository.path) {
      this.activeRepositoryState.set(updatedRepository);
    }

    return true;
  }

  add(repository: Repository): boolean {
    const alreadyAdded = this.repositoriesState().some(
      (item) =>
        item.workspaceId === repository.workspaceId &&
        item.path.toLowerCase() === repository.path.toLowerCase(),
    );

    if (alreadyAdded) {
      return false;
    }

    this.setRepositories([...this.repositoriesState(), repository]);
    return true;
  }

  remove(workspaceId: string, path: string): void {
    this.setRepositories(
      this.repositoriesState().filter(
        (repository) => !(repository.workspaceId === workspaceId && repository.path === path),
      ),
    );
  }

  getActive(): Repository | undefined {
    return this.activeRepositoryState();
  }

  setActive(repository: Repository | undefined): void {
    this.activeRepositoryState.set(repository);
    this.repositoryStatusState.set(undefined);
    this.repositoryReferencesState.set(undefined);
  }

  private loadRepositories(): Repository[] {
    if (typeof localStorage === "undefined") {
      return [];
    }

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsed = saved ? (JSON.parse(saved) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as Repository[]) : [];
    } catch {
      return [];
    }
  }

  private setRepositories(repositories: Repository[]): void {
    this.repositoriesState.set(repositories);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(repositories));
    }
  }
}
