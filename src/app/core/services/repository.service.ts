import { inject, Injectable, signal } from "@angular/core";
import { RouteReuseStrategy } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { AppRouteReuseStrategy } from "../strategies/app-route-reuse-strategy";
import {
  LocalRepositoryInfo,
  Repository,
  RepositoryOperation,
  RepositoryOperationKind,
  RepositoryRemote,
  RepositoryStatus,
  RepositoryReferences,
  RepositorySignature,
  PullResult,
  RepositoryAuthenticationSource,
  ConflictFile,
} from "../models/repository.model";
import { Commit } from "../models/commit.model";
import { CommitFile } from "../models/commit-file.model";
import { BlameLine } from "../models/blame.model";
import { UndoCandidate } from "../models/undo.model";
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
  private readonly routeReuseStrategy = inject(RouteReuseStrategy, { optional: true });
  private readonly repositoriesState = signal<Repository[]>(this.loadRepositories());
  private readonly openRepositoriesState = signal<Repository[]>(this.loadOpenRepositories());
  private readonly activeRepositoryState = signal<Repository | undefined>(undefined);
  private readonly repositoryStatusState = signal<RepositoryStatus | undefined>(undefined);
  private readonly repositoryReferencesState = signal<RepositoryReferences | undefined>(undefined);
  private readonly repositoryRefreshVersionState = signal(0);
  private readonly repositoryCache = new Map<string, RepositoryCache>();
  private readonly backgroundRefreshes = new Set<string>();
  private readonly inFlightRequests = new Map<string, Promise<unknown>>();
  private readonly repositorySignatures = new Map<string, string>();
  private readonly lastLocalRefreshAt = new Map<string, number>();
  private readonly lastAutoFetchAt = new Map<string, number>();
  private readonly localRefreshMinGap = 1_500;
  private readonly fileChangeRefreshMinGap = 2_000;
  private readonly watcherRefreshDebounce = 500;
  private readonly autoFetchInterval = 3 * 60_000;
  private readonly idleSafetyRefreshInterval = 120_000;
  private readonly duplicateFetchGap = 20_000;
  private watcherUnlisten?: UnlistenFn;
  private watcherRefreshTimer?: ReturnType<typeof setTimeout>;
  private pendingWatcherRepository?: Repository;

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
    const references = await this.dedupe(
      `references:${this.normalizeRepositoryPath(path)}`,
      () => invoke<RepositoryReferences>("get_repository_references", { path }),
    );
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
    const operation = await this.dedupe(
      `operation:${this.normalizeRepositoryPath(path)}`,
      () => invoke<RepositoryOperation | null>("get_repository_operation", { path }),
    );
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
    const status = await this.dedupe(
      `status:${this.normalizeRepositoryPath(path)}`,
      () => invoke<RepositoryStatus>("get_repository_status", { path }),
    );
    this.cacheFor(path).status = status;
    if (this.isActiveRepositoryPath(path)) {
      this.repositoryStatusState.set(status);
    }
    return status;
  }

  async getConflicts(path: string): Promise<ConflictFile[]> {
    return invoke<ConflictFile[]>("get_repository_conflicts", { path });
  }

  /**
   * Assinatura leve do repositório (apenas leitura de metadados do `.git`, sem
   * criar processos Git) usada para saber se vale a pena atualizar a interface.
   */
  async getSignature(path: string): Promise<RepositorySignature> {
    return this.dedupe(
      `signature:${this.normalizeRepositoryPath(path)}`,
      () => invoke<RepositorySignature>("get_repository_signature", { path }),
    );
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

  /** Aplica um único trecho do diff no índice (staging por hunk). */
  async stageHunk(path: string, filePath: string, hunkIndex: number): Promise<void> {
    await invoke("stage_repository_hunk", { path, filePath, hunkIndex });
  }

  async unstageHunk(path: string, filePath: string, hunkIndex: number): Promise<void> {
    await invoke("unstage_repository_hunk", { path, filePath, hunkIndex });
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

  async cherryPickCommit(path: string, commitHash: string): Promise<void> {
    await invoke("cherry_pick_commit", { path, commitHash });
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

  /** Autoria linha a linha de um arquivo (`git blame --line-porcelain`). */
  async getFileBlame(path: string, filePath: string): Promise<BlameLine[]> {
    return invoke<BlameLine[]>("get_file_blame", { path, filePath });
  }

  /** Commits que tocaram o arquivo, seguindo renomeações (`git log --follow`). */
  async getFileHistory(path: string, filePath: string, limit = 50): Promise<Commit[]> {
    return invoke<Commit[]>("get_file_history", { path, filePath, limit });
  }

  /** Último commit que pode ser desfeito com segurança (via reflog). */
  async getUndoCandidate(path: string): Promise<UndoCandidate | null> {
    return invoke<UndoCandidate | null>("get_undo_candidate", { path });
  }

  /** Volta o ponteiro da branch um passo (`reset --soft`), preservando arquivos. */
  async undoLastOperation(
    path: string,
    currentHash: string,
    previousHash: string,
  ): Promise<void> {
    await invoke("undo_last_operation", { path, currentHash, previousHash });
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
      await this.refreshLocalStateLocked(repository, cacheKey);
      await this.storeSignature(repository, cacheKey);

      // Evita disparar vários `git fetch` seguidos ao abrir/trocar de
      // repositório em sequência.
      if (Date.now() - (this.lastAutoFetchAt.get(cacheKey) ?? 0) < this.duplicateFetchGap) {
        return;
      }

      this.lastAutoFetchAt.set(cacheKey, Date.now());

      const syncCredentials = this.getSyncCredentials(repository);
      await this.fetch(
        repository.path,
        syncCredentials.workspaceId,
        syncCredentials.githubUserId,
      );

      await Promise.allSettled([
        this.getReferences(repository.path),
        this.getStatus(repository.path),
      ]);
      this.repositoryRefreshVersionState.update((version) => version + 1);
      await this.storeSignature(repository, cacheKey);
    } finally {
      this.backgroundRefreshes.delete(cacheKey);
    }
  }

  /**
   * Atualização automática (timer, foco da janela, volta do sistema): só cria
   * processos Git quando a assinatura do `.git` mudou ou quando já passou do
   * intervalo de segurança. O app continua se atualizando sozinho, porém sem
   * rodar `git status`/`git log` a cada ciclo quando nada aconteceu.
   */
  async refreshAutomatically(repository: Repository): Promise<void> {
    const cacheKey = this.normalizeRepositoryPath(repository.path);
    if (this.backgroundRefreshes.has(cacheKey)) {
      return;
    }

    const signature = await this.getSignature(repository.path).catch(() => undefined);
    const previousSignature = this.repositorySignatures.get(cacheKey);
    const hasLocalSnapshot = this.lastLocalRefreshAt.has(cacheKey);
    const signatureChanged =
      !!signature && !!previousSignature && signature.signature !== previousSignature;
    const now = Date.now();
    const lastLocalRefresh = this.lastLocalRefreshAt.get(cacheKey) ?? 0;
    const safetyRefreshDue = now - lastLocalRefresh >= this.idleSafetyRefreshInterval;

    if (hasLocalSnapshot && !signatureChanged && !safetyRefreshDue) {
      return;
    }

    if (now - lastLocalRefresh < this.localRefreshMinGap) {
      return;
    }

    this.backgroundRefreshes.add(cacheKey);
    try {
      if (signature) {
        this.repositorySignatures.set(cacheKey, signature.signature);
      }

      await this.refreshLocalStateLocked(repository, cacheKey);
      await this.syncRemoteWhenDue(repository, cacheKey);
    } finally {
      this.backgroundRefreshes.delete(cacheKey);
    }
  }

  /** Atualiza somente dados locais (sem rede). Retorna se a atualização rodou. */
  async refreshLocalState(repository: Repository): Promise<boolean> {
    const cacheKey = this.normalizeRepositoryPath(repository.path);
    if (this.backgroundRefreshes.has(cacheKey)) {
      return false;
    }

    this.backgroundRefreshes.add(cacheKey);
    try {
      await this.refreshLocalStateLocked(repository, cacheKey);
      return true;
    } finally {
      this.backgroundRefreshes.delete(cacheKey);
    }
  }

  private async refreshLocalStateLocked(repository: Repository, cacheKey: string): Promise<void> {
    await Promise.allSettled([
      this.getReferences(repository.path),
      this.getStatus(repository.path),
      this.getOperation(repository.path),
    ]);
    this.lastLocalRefreshAt.set(cacheKey, Date.now());
    this.repositoryRefreshVersionState.update((version) => version + 1);
  }

  private async storeSignature(repository: Repository, cacheKey: string): Promise<void> {
    const signature = await this.getSignature(repository.path).catch(() => undefined);

    if (signature) {
      this.repositorySignatures.set(cacheKey, signature.signature);
    }
  }

  /**
   * Sincroniza com o remoto respeitando um intervalo mínimo entre fetches
   * automáticos, para que foco/visibilidade da janela não gerem tráfego de rede
   * a cada alternância de contexto.
   */
  private async syncRemoteWhenDue(repository: Repository, cacheKey: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastAutoFetchAt.get(cacheKey) ?? 0) < this.autoFetchInterval) {
      return;
    }

    this.lastAutoFetchAt.set(cacheKey, now);

    const references = this.getCachedReferences(repository.path);
    if (!references || references.remoteBranches.length === 0) {
      // Sem remote configurado não existe o que sincronizar.
      return;
    }

    const syncCredentials = this.getSyncCredentials(repository);

    try {
      await this.fetch(
        repository.path,
        syncCredentials.workspaceId,
        syncCredentials.githubUserId,
      );
    } catch {
      return;
    }

    await Promise.allSettled([
      this.getReferences(repository.path),
      this.getStatus(repository.path),
    ]);
    this.repositoryRefreshVersionState.update((version) => version + 1);
    await this.storeSignature(repository, cacheKey);
  }

  /** Reaproveita requisições concorrentes para o mesmo dado. */
  private dedupe<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const inFlight = this.inFlightRequests.get(key) as Promise<T> | undefined;

    if (inFlight) {
      return inFlight;
    }

    const request = factory();
    const tracked = request.finally(() => {
      if (this.inFlightRequests.get(key) === tracked) {
        this.inFlightRequests.delete(key);
      }
    });

    this.inFlightRequests.set(key, tracked);
    return tracked;
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
    const prev = this.activeRepositoryState();
    const isDifferent =
      !prev ||
      !repository ||
      prev.path !== repository.path ||
      prev.workspaceId !== repository.workspaceId;

    if (isDifferent && this.routeReuseStrategy instanceof AppRouteReuseStrategy) {
      this.routeReuseStrategy.clearHandles();
    }

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
            this.handleRepositoryFileChange(active);
          }
        },
      );
    } catch (error) {
      console.warn("Falha ao inicializar listener de mudanças de arquivo:", error);
    }
  }

  private handleRepositoryFileChange(repository: Repository): void {
    this.pendingWatcherRepository = repository;

    if (this.watcherRefreshTimer !== undefined) {
      return;
    }

    // Agrupa a rajada de eventos que um único comando Git costuma gerar.
    this.watcherRefreshTimer = setTimeout(() => {
      this.watcherRefreshTimer = undefined;
      const pending = this.pendingWatcherRepository;
      this.pendingWatcherRepository = undefined;

      if (pending) {
        void this.refreshAfterRepositoryFileChange(pending);
      }
    }, this.watcherRefreshDebounce);
  }

  private async refreshAfterRepositoryFileChange(repository: Repository): Promise<void> {
    if (!this.isSameRepository(this.activeRepositoryState(), repository)) {
      return;
    }

    const cacheKey = this.normalizeRepositoryPath(repository.path);
    if (this.backgroundRefreshes.has(cacheKey)) {
      return;
    }

    const elapsed = Date.now() - (this.lastLocalRefreshAt.get(cacheKey) ?? 0);
    if (this.lastLocalRefreshAt.has(cacheKey) && elapsed < this.fileChangeRefreshMinGap) {
      // Evita rodar Git novamente por causa do mesmo evento logo em seguida.
      setTimeout(
        () => void this.refreshAfterRepositoryFileChange(repository),
        this.fileChangeRefreshMinGap - elapsed,
      );
      return;
    }

    try {
      await this.refreshLocalState(repository);
      await this.storeSignature(repository, cacheKey);
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
