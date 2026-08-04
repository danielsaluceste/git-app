import { Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  LocalRepositoryInfo,
  Repository,
  RepositoryStatus,
  RepositoryReferences,
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

  async stageFiles(path: string, files: string[]): Promise<void> {
    await invoke("stage_repository_files", { path, files });
  }

  async unstageFiles(path: string, files: string[]): Promise<void> {
    await invoke("unstage_repository_files", { path, files });
  }

  async commit(path: string, message: string): Promise<void> {
    await invoke("commit_repository", { path, message });
  }

  async getStagedDiff(path: string): Promise<string> {
    return invoke<string>("get_repository_staged_diff", { path });
  }

  async getFileDiff(path: string, filePath: string, staged: boolean): Promise<string> {
    return invoke<string>("get_repository_file_diff", { path, filePath, staged });
  }

  async getCommits(path: string): Promise<Commit[]> {
    return invoke<Commit[]>("get_repository_commits", { path });
  }

  async getCommitFiles(path: string, commitHash: string): Promise<CommitFile[]> {
    return invoke<CommitFile[]>("get_commit_files", { path, commitHash });
  }

  async getCommitFileDiff(path: string, commitHash: string, filePath: string): Promise<string> {
    return invoke<string>("get_commit_file_diff", { path, commitHash, filePath });
  }

  async fetch(path: string): Promise<void> {
    await invoke("fetch_repository", { path });
  }

  async pull(path: string): Promise<void> {
    await invoke("pull_repository", { path });
  }

  async push(path: string): Promise<void> {
    await invoke("push_repository", { path });
  }

  async checkoutBranch(path: string, branch: string): Promise<void> {
    await invoke("checkout_branch", { path, branch });
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
