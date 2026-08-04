import { Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  LocalRepositoryInfo,
  Repository,
  RepositoryStatus,
  RepositoryReferences,
} from "../models/repository.model";
import { Commit } from "../models/commit.model";

const STORAGE_KEY = "git-app.repositories";

@Injectable({ providedIn: "root" })
export class RepositoryService {
  private readonly repositoriesState = signal<Repository[]>(this.loadRepositories());
  private readonly activeRepositoryState = signal<Repository | undefined>(undefined);

  readonly repositories = this.repositoriesState.asReadonly();
  readonly activeRepository = this.activeRepositoryState.asReadonly();

  async inspectLocalRepository(path: string): Promise<LocalRepositoryInfo> {
    return invoke<LocalRepositoryInfo>("inspect_repository", { path });
  }

  async getReferences(path: string): Promise<RepositoryReferences> {
    return invoke<RepositoryReferences>("get_repository_references", { path });
  }

  async getStatus(path: string): Promise<RepositoryStatus> {
    return invoke<RepositoryStatus>("get_repository_status", { path });
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

  async getCommits(path: string): Promise<Commit[]> {
    return invoke<Commit[]>("get_repository_commits", { path });
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
