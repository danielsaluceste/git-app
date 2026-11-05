import { Component, computed, HostListener, inject } from "@angular/core";
import { Router } from "@angular/router";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { GithubConnection, GithubRepository } from "../../../core/models/github.model";
import { LayoutService } from "../../../core/services/layout.service";
import { GithubService } from "../../../core/services/github.service";
import {
  GitSyncCredentials,
  Repository,
  RepositoryAuthenticationSource,
} from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { WorkspaceService } from "../../../core/services/workspace.service";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

type AddRepositoryMode = "options" | "clone";
type CloneSource = "url" | "github";

/** `"system"` usa a configuração do computador; as demais chaves são `modo:id`. */
type CloneAuthKey = "system" | string;

const SYSTEM_AUTH_KEY = "system";
const GIT_URL_PATTERN = /^(?:git@|ssh:\/\/|https?:\/\/|git:\/\/)/i;
const GITHUB_HTTPS_URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

interface CloneProgress {
  operationId: string;
  progress: number;
  stage: string;
  detail: string;
  finished: boolean;
  cancelled: boolean;
}

@Component({
  selector: "app-repositories-page",
  imports: [TranslatePipe],
  templateUrl: "./repositories-page.component.html",
  styleUrl: "./repositories-page.component.css",
})
export class RepositoriesPageComponent {
  private readonly repositoryService = inject(RepositoryService);
  private readonly githubService = inject(GithubService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly router = inject(Router);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  readonly activeWorkspace = this.workspaceService.activeWorkspace;
  readonly repositories = computed(() =>
    this.repositoryService
      .repositories()
      .filter((repository) => repository.workspaceId === this.activeWorkspace().id),
  );

  isLoading = false;
  isAddRepositoryModalOpen = false;
  addRepositoryMode: AddRepositoryMode = "options";
  cloneSource: CloneSource = "url";
  cloneUrl = "";
  cloneDestination = "";
  cloneAuthKey: CloneAuthKey = SYSTEM_AUTH_KEY;
  sshRepositorySlug = "";
  githubRepositories: GithubRepository[] = [];
  githubRepositoriesLoading = false;
  githubRepositoriesError = "";
  selectedGithubConnectionKey: string | undefined;
  selectedGithubRepositoryId: number | undefined;
  cloneOperationId = "";
  cloneProgress = 0;
  cloneStage = this.translationService.translate("repositories.preparingClone");
  cloneDetail = this.translationService.translate("repositories.connectingRemote");
  cloneCancelRequested = false;
  private cloneProgressUnlisten: UnlistenFn | undefined;
  readonly githubConnections = this.githubService.workspaceConnections;

  openAddRepositoryModal(): void {
    this.addRepositoryMode = "options";
    this.cloneUrl = "";
    this.cloneDestination = "";
    this.cloneSource = "url";
    this.cloneAuthKey = SYSTEM_AUTH_KEY;
    this.selectedGithubConnectionKey = undefined;
    this.sshRepositorySlug = "";
    this.githubRepositories = [];
    this.githubRepositoriesError = "";
    this.selectedGithubRepositoryId = undefined;
    this.isAddRepositoryModalOpen = true;
  }

  closeAddRepositoryModal(): void {
    if (this.isLoading) {
      return;
    }

    this.isAddRepositoryModalOpen = false;
    this.addRepositoryMode = "options";
  }

  selectCloneOption(): void {
    this.addRepositoryMode = "clone";
    this.cloneSource = "url";
  }

  selectGithubCloneOption(): void {
    const connections = this.githubConnections();

    if (connections.length === 0) {
      this.goToIntegrations();
      return;
    }

    const preferred = connections.find((connection) => connection.isDefault) ?? connections[0];
    this.addRepositoryMode = "clone";
    this.cloneSource = "github";
    this.selectGithubAccount(this.connectionKey(preferred));
  }

  selectCloneSource(source: CloneSource): void {
    this.cloneSource = source;
    this.cloneUrl = "";
    this.sshRepositorySlug = "";
    this.githubRepositoriesError = "";
    this.selectedGithubRepositoryId = undefined;

    if (source === "github") {
      const connections = this.githubConnections();
      const current = this.connectionFromKey(this.selectedGithubConnectionKey);
      const connection = current ?? connections.find((item) => item.isDefault) ?? connections[0];

      if (connection) {
        this.selectGithubAccount(this.connectionKey(connection));
      }
    }
  }

  selectGithubAccount(connectionKey: string): void {
    const connection = this.connectionFromKey(connectionKey);

    if (!connection) {
      return;
    }

    this.selectedGithubConnectionKey = connectionKey;
    this.cloneAuthKey = connectionKey;
    this.selectedGithubRepositoryId = undefined;
    this.cloneUrl = "";
    this.sshRepositorySlug = "";
    this.githubRepositories = [];
    this.githubRepositoriesError = "";

    if (connection.mode === "app") {
      void this.loadGithubRepositories();
    }
  }

  selectGithubAccountFromEvent(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;

    if (value) {
      this.selectGithubAccount(value);
    }
  }

  selectCloneAuthFromEvent(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as CloneAuthKey;
    this.cloneAuthKey = value || SYSTEM_AUTH_KEY;
  }

  selectGithubRepository(repository: GithubRepository): void {
    this.selectedGithubRepositoryId = repository.id;
    this.cloneUrl = repository.cloneUrl;
  }

  async loadGithubRepositories(): Promise<void> {
    const connection = this.selectedGithubConnection();

    // A chave SSH não lista repositórios: ela autentica o Git, mas não tem
    // acesso à API do GitHub. Nesse modo o repositório é informado à mão.
    if (!connection || connection.mode !== "app") {
      this.githubRepositories = [];
      return;
    }

    this.githubRepositoriesLoading = true;
    this.githubRepositoriesError = "";

    try {
      this.githubRepositories = await this.githubService.listRepositories(
        this.activeWorkspace().id,
        connection.id,
      );
    } catch (error: unknown) {
      this.githubRepositories = [];
      this.githubRepositoriesError =
        typeof error === "string"
          ? error
          : this.translationService.translate("repositories.githubLoadError");
    } finally {
      this.githubRepositoriesLoading = false;
    }
  }

  async chooseCloneDestination(): Promise<void> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: this.translationService.translate("repositories.chooseCloneFolderTitle"),
      });

      if (typeof selected === "string") {
        this.cloneDestination = selected;
      }
    } catch {
      this.toastService.error(
        this.translationService.translate("repositories.folderPickerError"),
        this.translationService.translate("repositories.cloneDestinationTitle"),
      );
    }
  }

  goToIntegrations(): void {
    this.isAddRepositoryModalOpen = false;
    void this.router.navigate(["/integrations"]);
  }

  async addLocalRepository(): Promise<void> {
    this.isAddRepositoryModalOpen = false;

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: this.translationService.translate("repositories.addLocalTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      this.isLoading = true;
      const repositoryInfo = await this.repositoryService.inspectLocalRepository(selected);
      const added = this.repositoryService.add({
        name: repositoryInfo.name,
        path: repositoryInfo.path,
        workspaceId: this.activeWorkspace().id,
        cloneSource: "local",
        authenticationSource: "system",
      });

      if (!added) {
        this.toastService.warning(
          this.translationService.translate("repositories.alreadyAdded"),
          this.translationService.translate("repositories.duplicateTitle"),
        );
      } else {
        this.toastService.success(
          this.translationService.translate("repositories.addedMessage"),
          this.translationService.translate("repositories.addedTitle"),
        );
      }
    } catch (error: unknown) {
      this.toastService.error(
        typeof error === "string"
          ? error
          : this.translationService.translate("repositories.invalidLocalError"),
        this.translationService.translate("repositories.localErrorTitle"),
      );
    } finally {
      this.isLoading = false;
    }
  }

  /** O formulário só libera o clone quando a origem e a autenticação estão completas. */
  cloneReady(): boolean {
    if (this.cloneSource === "github") {
      const connection = this.selectedGithubConnection();

      if (!connection) {
        return false;
      }

      return connection.mode === "ssh"
        ? this.sshRepositorySlug.trim().length > 0
        : this.selectedGithubRepositoryId !== undefined;
    }

    return this.cloneUrl.trim().length > 0;
  }

  connectionKey(connection: GithubConnection): string {
    return `${connection.mode}:${connection.id}`;
  }

  connectionLabel(connection: GithubConnection): string {
    const mode = this.translationService.translate(
      connection.mode === "ssh" ? "integrations.modeSsh" : "integrations.modeApp",
    );
    const keyName = connection.ssh?.keyName ? ` · ${connection.ssh.keyName}` : "";
    const isDefault = connection.isDefault
      ? ` · ${this.translationService.translate("integrations.default")}`
      : "";

    return `${mode} · @${connection.login}${keyName}${isDefault}`;
  }

  selectedGithubConnection(): GithubConnection | undefined {
    return this.connectionFromKey(this.selectedGithubConnectionKey);
  }

  selectedConnectionIsSsh(): boolean {
    return this.selectedGithubConnection()?.mode === "ssh";
  }

  usesSshAuth(): boolean {
    return this.connectionFromKey(this.cloneAuthKey)?.mode === "ssh";
  }

  sshCloneHint(): string {
    return this.translationService.translate("repositories.sshCloneHint", {
      url: this.sshRepositoryPreview(),
    });
  }

  async cloneRepository(): Promise<void> {
    const remoteUrl = this.resolveCloneUrl();

    if (!remoteUrl.trim() || !this.cloneDestination.trim()) {
      this.toastService.warning(
        this.translationService.translate("repositories.urlAndDestination"),
        this.translationService.translate("repositories.incompleteTitle"),
      );
      return;
    }

    if (this.cloneAuthKey !== SYSTEM_AUTH_KEY && !this.connectionFromKey(this.cloneAuthKey)) {
      this.toastService.warning(
        this.translationService.translate("repositories.accountRequired"),
        this.translationService.translate("repositories.accountRequiredTitle"),
      );
      return;
    }

    const connection = this.connectionFromKey(this.cloneAuthKey);

    this.isLoading = true;
    this.cloneOperationId = this.createCloneOperationId();
    this.cloneProgress = 0;
    this.cloneStage = this.translationService.translate("repositories.preparingClone");
    this.cloneDetail = this.translationService.translate("repositories.connectingRemote");
    this.cloneCancelRequested = false;

    try {
      await this.startCloneProgressListener();
      const repositoryInfo = await this.repositoryService.cloneRepository(
        remoteUrl.trim(),
        this.cloneDestination,
        this.cloneOperationId,
        this.cloneCredentials(connection),
      );
      const added = this.repositoryService.add({
        name: repositoryInfo.name,
        path: repositoryInfo.path,
        workspaceId: this.activeWorkspace().id,
        cloneSource: this.cloneSource,
        authenticationSource: this.authenticationSource(connection),
        githubConnectionId: connection?.id,
      });

      this.isAddRepositoryModalOpen = false;
      this.addRepositoryMode = "options";
      if (!added) {
        this.toastService.warning(
          this.translationService.translate("repositories.alreadyAdded"),
          this.translationService.translate("repositories.duplicateTitle"),
        );
      } else {
        this.toastService.success(
          this.translationService.translate("repositories.cloneDone"),
          this.translationService.translate("repositories.cloneDoneTitle"),
        );
      }
    } catch (error: unknown) {
      if (this.cloneCancelRequested) {
        this.toastService.info(
          this.translationService.translate("repositories.cancelled"),
          this.translationService.translate("repositories.cancelledTitle"),
        );
      } else {
        this.toastService.error(
          typeof error === "string" ? error : this.translationService.translate("repositories.cloneError"),
          this.translationService.translate("repositories.cloneErrorTitle"),
        );
      }
    } finally {
      this.stopCloneProgressListener();
      this.isLoading = false;
    }
  }

  async cancelClone(): Promise<void> {
    if (!this.cloneOperationId || this.cloneCancelRequested) {
      return;
    }

    this.cloneCancelRequested = true;
    this.cloneStage = this.translationService.translate("repositories.cancelStage");
    this.cloneDetail = this.translationService.translate("repositories.cancelDetail");

    try {
      await this.repositoryService.cancelClone(this.cloneOperationId);
    } catch {
      this.toastService.warning(
        this.translationService.translate("repositories.cancelWarning"),
        this.translationService.translate("repositories.cancelWarningTitle"),
      );
    }
  }

  @HostListener("document:keydown.escape")
  onEscapeKeydown(): void {
    this.closeAddRepositoryModal();
  }

  openRepository(repository: Repository): void {
    this.repositoryService.openRepository(repository);
    this.layoutService.closeMainSidebar();
    void this.router.navigate(["/overview"]);
  }

  trackRepository(_index: number, repository: Repository): string {
    return `${repository.workspaceId}:${repository.path}`;
  }

  private connectionFromKey(connectionKey: string | undefined): GithubConnection | undefined {
    if (!connectionKey || connectionKey === SYSTEM_AUTH_KEY) {
      return undefined;
    }

    return this.githubConnections().find(
      (connection) => this.connectionKey(connection) === connectionKey,
    );
  }

  private cloneCredentials(connection: GithubConnection | undefined): GitSyncCredentials | undefined {
    if (!connection) {
      return undefined;
    }

    return connection.mode === "ssh"
      ? { sshKeyPath: connection.ssh?.keyPath }
      : { workspaceId: this.activeWorkspace().id, githubUserId: connection.id };
  }

  private authenticationSource(
    connection: GithubConnection | undefined,
  ): RepositoryAuthenticationSource {
    if (!connection) {
      return "system";
    }

    return connection.mode === "ssh" ? "ssh" : "github";
  }

  private resolveCloneUrl(): string {
    const connection = this.connectionFromKey(this.cloneAuthKey);

    if (this.cloneSource === "github") {
      if (connection?.mode === "ssh") {
        return this.sshRepositoryUrl(this.sshRepositorySlug);
      }

      const selectedRepository = this.githubRepositories.find(
        (repository) => repository.id === this.selectedGithubRepositoryId,
      );

      return selectedRepository?.cloneUrl ?? "";
    }

    const url = this.cloneUrl.trim();

    // Com chave SSH a URL HTTPS do GitHub é convertida para o formato SSH,
    // senão o Git tentaria autenticar por HTTPS e ignoraria a chave.
    return connection?.mode === "ssh" ? this.toSshUrl(url) : url;
  }

  private sshRepositoryUrl(value: string): string {
    const trimmed = value.trim();

    if (!trimmed) {
      return "";
    }

    if (GIT_URL_PATTERN.test(trimmed)) {
      return this.toSshUrl(trimmed);
    }

    const slug = trimmed.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");

    return `git@github.com:${slug}.git`;
  }

  private sshRepositoryPreview(): string {
    const preview = this.sshRepositoryUrl(this.sshRepositorySlug);

    return preview || "git@github.com:usuario/projeto.git";
  }

  private toSshUrl(url: string): string {
    const match = GITHUB_HTTPS_URL_PATTERN.exec(url.trim());

    if (!match) {
      return url;
    }

    return `git@github.com:${match[1]}/${match[2]}.git`;
  }

  private async startCloneProgressListener(): Promise<void> {
    this.cloneProgressUnlisten = await listen<CloneProgress>("clone-progress", (event) => {
      if (event.payload.operationId !== this.cloneOperationId) {
        return;
      }

      this.cloneProgress = event.payload.progress;
      this.cloneStage = this.translateCloneStage(event.payload.stage);
      this.cloneDetail = event.payload.detail;
    });
  }

  private stopCloneProgressListener(): void {
    this.cloneProgressUnlisten?.();
    this.cloneProgressUnlisten = undefined;
  }

  private createCloneOperationId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return `clone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private translateCloneStage(stage: string): string {
    const stageKey: Record<string, string> = {
      "Preparando clonagem": "repositories.preparingClone",
      "Baixando objetos": "repositories.downloadingObjects",
      "Resolvendo alterações": "repositories.resolvingChanges",
      "Atualizando arquivos": "repositories.updatingFiles",
      "Criando repositório": "repositories.creatingRepository",
      "Clonando repositório": "repositories.cloningRepository",
    };

    return stageKey[stage] ? this.translationService.translate(stageKey[stage]) : stage;
  }
}
