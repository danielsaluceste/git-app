import { Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  LocalRepositoryInfo,
  Repository,
  RepositoryOperation,
  RepositoryOperationKind,
  RepositoryRemote,
  RepositoryStatus,
  RepositoryReferences,
  PullResult,
  RepositoryAuthenticationSource,
  ConflictFile,
} from "../models/repository.model";
import { Commit } from "../models/commit.model";
import { CommitFile } from "../models/commit-file.model";
import { CreateTagRequest, GitTag } from "../models/tag.model";

const STORAGE_KEY = "git-app.repositories";
const OPEN_REPOSITORIES_KEY = "git-app.open-repositories";
const ACTIVE_REPOSITORY_KEY = "git-app.active-repository";

interface StoredRepositoryReference {
  workspaceId: string;
  path: string;
}

interface RepositoryCache {
  status?: RepositoryStatus;
  references?: RepositoryReferences;
  operation?: RepositoryOperation | null;
  commitsCurrent?: Commit[];
  commitsAll?: Commit[];
  commitDraft?: {
    message: string;
    amend: boolean;
  };
}

@Injectable({ providedIn: "root" })
export class RepositoryService {
  private readonly repositoriesState = signal<Repository[]>(this.loadRepositories());
  private readonly openRepositoriesState = signal<Repository[]>(this.loadOpenRepositories());
  private readonly activeRepositoryState = signal<Repository | undefined>(undefined);
  private readonly repositoryStatusState = signal<RepositoryStatus | undefined>(undefined);
  private readonly repositoryReferencesState = signal<RepositoryReferences | undefined>(undefined);
  private readonly repositoryRefreshVersionState = signal(0);
  private readonly repositoryCache = new Map<string, RepositoryCache>();
  private readonly backgroundRefreshes = new Set<string>();
  private watcherUnlisten?: UnlistenFn;

  constructor() {
    void this.initWatcherListener();
  }

  readonly repositories = this.repositoriesState.asReadonly();
  readonly openRepositories = this.openRepositoriesState.asReadonly();
  readonly activeRepository = this.activeRepositoryState.asReadonly();
  readonly repositoryStatus = this.repositoryStatusState.asReadonly();
  readonly repositoryReferences = this.repositoryReferencesState.asReadonly();
  readonly repositoryRefreshVersion = this.repositoryRefreshVersionState.asReadonly();

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
    this.cacheFor(path).references = references;
    if (this.isActiveRepositoryPath(path)) {
      this.repositoryReferencesState.set(references);
    }
    return references;
  }

  async getRemote(path: string): Promise<RepositoryRemote> {
    return invoke<RepositoryRemote>("get_repository_remote", { path });
  }

  async setRemoteUrl(path: string, url: string): Promise<RepositoryRemote> {
    return invoke<RepositoryRemote>("set_repository_remote_url", { path, url });
  }

  async getOperation(path: string): Promise<RepositoryOperation | null> {
    const operation = await invoke<RepositoryOperation | null>("get_repository_operation", { path });
    this.cacheFor(path).operation = operation;
    return operation;
  }

  async continueOperation(path: string, operation: RepositoryOperationKind): Promise<void> {
    await invoke("continue_repository_operation", { path, operation });
  }

  async abortOperation(path: string, operation: RepositoryOperationKind): Promise<void> {
    await invoke("abort_repository_operation", { path, operation });
  }

  async getStatus(path: string): Promise<RepositoryStatus> {
    const status = await invoke<RepositoryStatus>("get_repository_status", { path });
    this.cacheFor(path).status = status;
    if (this.isActiveRepositoryPath(path)) {
      this.repositoryStatusState.set(status);
    }
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

  async discardFile(path: string, filePath: string): Promise<void> {
    await invoke("discard_repository_file", { path, filePath });
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
    const commits = await invoke<Commit[]>("get_repository_commits", {
      path,
      allBranches,
      skip,
      limit,
    });
    if (skip === 0) {
      if (allBranches) {
        this.cacheFor(path).commitsAll = commits;
      } else {
        this.cacheFor(path).commitsCurrent = commits;
      }
    }
    return commits;
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

  async pull(path: string, workspaceId?: string, githubUserId?: number): Promise<PullResult> {
    return invoke<PullResult>("pull_repository", {
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

  getCachedReferences(path: string): RepositoryReferences | undefined {
    return this.cacheFor(path).references;
  }

  getCachedStatus(path: string): RepositoryStatus | undefined {
    return this.cacheFor(path).status;
  }

  getCachedOperation(path: string): RepositoryOperation | null | undefined {
    return this.cacheFor(path).operation;
  }

  getCachedCommitDraft(path: string): { message: string; amend: boolean } | undefined {
    return this.cacheFor(path).commitDraft;
  }

  setCachedCommitDraft(path: string, message: string, amend: boolean): void {
    this.cacheFor(path).commitDraft = { message, amend };
  }

  clearCachedCommitDraft(path: string): void {
    delete this.cacheFor(path).commitDraft;
  }

  getCachedCommits(path: string, allBranches: boolean): Commit[] | undefined {
    return allBranches ? this.cacheFor(path).commitsAll : this.cacheFor(path).commitsCurrent;
  }

  async refreshAfterRepositoryOpened(repository: Repository): Promise<void> {
    const cacheKey = this.normalizeRepositoryPath(repository.path);
    if (this.backgroundRefreshes.has(cacheKey)) {
      return;
    }

    this.backgroundRefreshes.add(cacheKey);
    try {
      try {
        const syncCredentials = this.getSyncCredentials(repository);
        await this.fetch(
          repository.path,
          syncCredentials.workspaceId,
          syncCredentials.githubUserId,
        );
      } catch {
        // Os dados locais continuam sendo atualizados mesmo sem conexão remota.
      }

      await Promise.allSettled([
        this.getReferences(repository.path),
        this.getStatus(repository.path),
        this.getOperation(repository.path),
      ]);
      this.repositoryRefreshVersionState.update((version) => version + 1);
    } finally {
      this.backgroundRefreshes.delete(cacheKey);
    }
  }

  async checkoutBranch(path: string, branch: string): Promise<void> {
    await invoke("checkout_branch", { path, branch });
  }

  async mergeBranch(path: string, sourceBranch: string, targetBranch: string): Promise<void> {
    await invoke("merge_branch", { path, sourceBranch, targetBranch });
  }

  async rebaseBranch(path: string, sourceBranch: string, targetBranch: string): Promise<void> {
    await invoke("rebase_branch", { path, sourceBranch, targetBranch });
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

  async getTags(path: string): Promise<GitTag[]> {
    return invoke<GitTag[]>("get_repository_tags", { path });
  }

  async createTag(path: string, request: CreateTagRequest): Promise<void> {
    await invoke("create_repository_tag", {
      path,
      name: request.name,
      commitHash: request.commitHash ?? null,
      message: request.message ?? null,
      push: request.push,
    });
  }

  async deleteTag(path: string, name: string, deleteRemote = false): Promise<void> {
    await invoke("delete_repository_tag", { path, name, deleteRemote });
  }

  async pushTags(path: string): Promise<void> {
    await invoke("push_repository_tags", { path });
  }

  async pushTag(path: string, name: string): Promise<void> {
    await invoke("push_repository_tag", { path, name });
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
    this.openRepositoriesState.update((items) =>
      items.map((item) => (this.isSameRepository(item, repository) ? updatedRepository : item)),
    );
    this.persistOpenRepositories();
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
    const removed = this.repositoriesState().find(
      (repository) =>
        repository.workspaceId === workspaceId &&
        this.normalizeRepositoryPath(repository.path) === this.normalizeRepositoryPath(path),
    );

    this.setRepositories(
      this.repositoriesState().filter(
        (repository) =>
          !(
            repository.workspaceId === workspaceId &&
            this.normalizeRepositoryPath(repository.path) === this.normalizeRepositoryPath(path)
          ),
      ),
    );

    if (removed) {
      this.closeOpenRepository(removed);
    }
  }

  getActive(): Repository | undefined {
    return this.activeRepositoryState();
  }

  setActive(repository: Repository | undefined): void {
    this.activeRepositoryState.set(repository);
    this.repositoryStatusState.set(repository ? this.getCachedStatus(repository.path) : undefined);
    this.repositoryReferencesState.set(repository ? this.getCachedReferences(repository.path) : undefined);
    this.persistActiveRepository(repository);

    if (repository) {
      void this.watchRepository(repository.path);
    } else {
      void this.unwatchRepository();
    }
  }

  async watchRepository(path: string): Promise<void> {
    try {
      await invoke("watch_repository", { path });
    } catch (error) {
      console.warn("Falha ao iniciar file watcher:", error);
    }
  }

  async unwatchRepository(): Promise<void> {
    try {
      await invoke("unwatch_repository");
    } catch (error) {
      console.warn("Falha ao parar file watcher:", error);
    }
  }

  private async initWatcherListener(): Promise<void> {
    try {
      this.watcherUnlisten = await listen<{ path: string }>(
        "repository-changed",
        (event) => {
          const active = this.activeRepositoryState();
          if (!active) {
            return;
          }

          const eventPath = this.normalizeRepositoryPath(event.payload.path);
          const activePath = this.normalizeRepositoryPath(active.path);
          if (eventPath === activePath) {
            void this.handleRepositoryFileChange(active);
          }
        },
      );
    } catch (error) {
      console.warn("Falha ao inicializar listener de mudanças de arquivo:", error);
    }
  }

  private async handleRepositoryFileChange(repository: Repository): Promise<void> {
    try {
      await Promise.allSettled([
        this.getReferences(repository.path),
        this.getStatus(repository.path),
        this.getOperation(repository.path),
      ]);
      this.repositoryRefreshVersionState.update((version) => version + 1);
    } catch (error) {
      console.warn("Erro ao atualizar dados após evento do file watcher:", error);
    }
  }

  openRepository(repository: Repository): void {
    const existing = this.openRepositoriesState().find((item) =>
      this.isSameRepository(item, repository),
    );

    if (!existing) {
      this.openRepositoriesState.update((items) => [...items, repository]);
    } else {
      this.openRepositoriesState.update((items) =>
        items.map((item) => (this.isSameRepository(item, repository) ? repository : item)),
      );
    }

    this.persistOpenRepositories();
    this.setActive(repository);
  }

  restoreActiveRepository(): Repository | undefined {
    const reference = this.loadActiveRepositoryReference();
    const repository = reference
      ? this.openRepositoriesState().find((item) => this.isSameRepositoryReference(item, reference))
      : undefined;

    if (repository) {
      this.setActive(repository);
      return repository;
    }

    this.clearStoredActiveRepository();
    return undefined;
  }

  closeOpenRepository(repository: Repository): Repository | undefined {
    const openRepositories = this.openRepositoriesState();
    const index = openRepositories.findIndex((item) => this.isSameRepository(item, repository));

    if (index < 0) {
      return undefined;
    }

    const sameWorkspaceRepositories = openRepositories.filter(
      (item) => item.workspaceId === repository.workspaceId && !this.isSameRepository(item, repository),
    );
    const nextRepository = sameWorkspaceRepositories.length
      ? sameWorkspaceRepositories[Math.min(index, sameWorkspaceRepositories.length - 1)]
      : undefined;

    this.openRepositoriesState.set(
      openRepositories.filter((item) => !this.isSameRepository(item, repository)),
    );
    this.persistOpenRepositories();

    if (this.isSameRepository(this.activeRepositoryState(), repository)) {
      this.setActive(nextRepository);
    }

    return nextRepository;
  }

  reorderOpenRepository(
    source: Repository,
    target: Repository,
    placeAfter = false,
  ): void {
    if (this.isSameRepository(source, target)) {
      return;
    }

    const openRepositories = this.openRepositoriesState();
    const workspaceIndexes = openRepositories
      .map((item, index) => (item.workspaceId === source.workspaceId ? index : -1))
      .filter((index) => index >= 0);
    const sourceIndex = workspaceIndexes.findIndex((index) =>
      this.isSameRepository(openRepositories[index], source),
    );
    const targetIndex = workspaceIndexes.findIndex((index) =>
      this.isSameRepository(openRepositories[index], target),
    );

    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }

    if ((!placeAfter && sourceIndex < targetIndex) || (placeAfter && sourceIndex > targetIndex)) {
      return;
    }

    const workspaceRepositories = workspaceIndexes.map((index) => openRepositories[index]);
    const [movedRepository] = workspaceRepositories.splice(sourceIndex, 1);
    const targetIndexAfterRemoval = workspaceRepositories.findIndex((item) =>
      this.isSameRepository(item, target),
    );
    workspaceRepositories.splice(
      targetIndexAfterRemoval + (placeAfter ? 1 : 0),
      0,
      movedRepository,
    );

    const reorderedRepositories = [...openRepositories];
    workspaceIndexes.forEach((index, position) => {
      reorderedRepositories[index] = workspaceRepositories[position];
    });
    this.openRepositoriesState.set(reorderedRepositories);
    this.persistOpenRepositories();
  }

  private isSameRepository(
    first: Repository | undefined,
    second: Repository | undefined,
  ): boolean {
    return !!first && !!second && first.workspaceId === second.workspaceId &&
      this.normalizeRepositoryPath(first.path) === this.normalizeRepositoryPath(second.path);
  }

  private normalizeRepositoryPath(path: string): string {
    return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }

  private cacheFor(path: string): RepositoryCache {
    const cacheKey = this.normalizeRepositoryPath(path);
    let cache = this.repositoryCache.get(cacheKey);

    if (!cache) {
      cache = {};
      this.repositoryCache.set(cacheKey, cache);
    }

    return cache;
  }

  private getSyncCredentials(repository: Repository): {
    workspaceId?: string;
    githubUserId?: number;
  } {
    if (repository.authenticationSource !== "github" || repository.githubConnectionId === undefined) {
      return {};
    }

    return {
      workspaceId: repository.workspaceId,
      githubUserId: repository.githubConnectionId,
    };
  }

  private isActiveRepositoryPath(path: string): boolean {
    const activeRepository = this.activeRepositoryState();
    return !!activeRepository &&
      this.normalizeRepositoryPath(activeRepository.path) === this.normalizeRepositoryPath(path);
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

  private loadOpenRepositories(): Repository[] {
    if (typeof localStorage === "undefined") {
      return [];
    }

    try {
      const saved = localStorage.getItem(OPEN_REPOSITORIES_KEY);
      const parsed = saved ? (JSON.parse(saved) as unknown) : [];

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((item): item is StoredRepositoryReference => this.isStoredRepositoryReference(item))
        .map((reference) =>
          this.repositoriesState().find((repository) =>
            this.isSameRepositoryReference(repository, reference),
          ),
        )
        .filter((repository): repository is Repository => !!repository);
    } catch {
      return [];
    }
  }

  private loadActiveRepositoryReference(): StoredRepositoryReference | undefined {
    if (typeof localStorage === "undefined") {
      return undefined;
    }

    try {
      const saved = localStorage.getItem(ACTIVE_REPOSITORY_KEY);
      const parsed = saved ? (JSON.parse(saved) as unknown) : undefined;
      return this.isStoredRepositoryReference(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private persistOpenRepositories(): void {
    if (typeof localStorage !== "undefined") {
      const references = this.openRepositoriesState().map((repository) => ({
        workspaceId: repository.workspaceId,
        path: repository.path,
      }));
      localStorage.setItem(OPEN_REPOSITORIES_KEY, JSON.stringify(references));
    }
  }

  private persistActiveRepository(repository: Repository | undefined): void {
    if (typeof localStorage === "undefined") {
      return;
    }

    if (!repository) {
      this.clearStoredActiveRepository();
      return;
    }

    localStorage.setItem(
      ACTIVE_REPOSITORY_KEY,
      JSON.stringify({ workspaceId: repository.workspaceId, path: repository.path }),
    );
  }

  private clearStoredActiveRepository(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(ACTIVE_REPOSITORY_KEY);
    }
  }

  private isStoredRepositoryReference(value: unknown): value is StoredRepositoryReference {
    if (!value || typeof value !== "object") {
      return false;
    }

    const reference = value as Partial<StoredRepositoryReference>;
    return typeof reference.workspaceId === "string" && typeof reference.path === "string";
  }

  private isSameRepositoryReference(
    repository: Repository,
    reference: StoredRepositoryReference,
  ): boolean {
    return repository.workspaceId === reference.workspaceId &&
      this.normalizeRepositoryPath(repository.path) === this.normalizeRepositoryPath(reference.path);
  }

  private setRepositories(repositories: Repository[]): void {
    this.repositoriesState.set(repositories);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(repositories));
    }
  }
}
