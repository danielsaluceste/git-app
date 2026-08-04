import { Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { LocalRepositoryInfo, Repository } from "../models/repository.model";

const STORAGE_KEY = "git-app.repositories";

@Injectable({ providedIn: "root" })
export class RepositoryService {
  private readonly repositoriesState = signal<Repository[]>(this.loadRepositories());
  private activeRepository?: Repository;

  readonly repositories = this.repositoriesState.asReadonly();

  async inspectLocalRepository(path: string): Promise<LocalRepositoryInfo> {
    return invoke<LocalRepositoryInfo>("inspect_repository", { path });
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
    return this.activeRepository;
  }

  setActive(repository: Repository | undefined): void {
    this.activeRepository = repository;
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
