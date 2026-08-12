import { Component, computed, HostListener, inject } from "@angular/core";
import { Router } from "@angular/router";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { GithubRepository } from "../../../core/models/github.model";
import { LayoutService } from "../../../core/services/layout.service";
import { GithubService } from "../../../core/services/github.service";
import { Repository } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { WorkspaceService } from "../../../core/services/workspace.service";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

type AddRepositoryMode = "options" | "clone";
type CloneSource = "url" | "github";

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
  githubRepositories: GithubRepository[] = [];
  githubRepositoriesLoading = false;
  githubRepositoriesError = "";
  selectedGithubUserId: number | undefined;
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
    this.githubRepositories = [];
    this.githubRepositoriesError = "";
    this.selectedGithubUserId = undefined;
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

    this.addRepositoryMode = "clone";
    this.cloneSource = "github";
    this.selectedGithubUserId = connections[0].id;
    void this.loadGithubRepositories();
  }

  selectCloneSource(source: CloneSource): void {
    this.cloneSource = source;
    this.cloneUrl = "";
    this.githubRepositoriesError = "";
    this.selectedGithubRepositoryId = undefined;

    if (source === "github") {
      const connections = this.githubConnections();
      this.selectedGithubUserId ??= connections[0]?.id;
      void this.loadGithubRepositories();
    }
  }

  selectGithubAccount(userId: number): void {
    this.selectedGithubUserId = userId;
    this.selectedGithubRepositoryId = undefined;
    this.cloneUrl = "";
    void this.loadGithubRepositories();
  }

  selectGithubAccountFromEvent(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);

    if (Number.isFinite(value) && value > 0) {
      this.selectGithubAccount(value);
    }
  }

  selectGithubRepository(repository: GithubRepository): void {
    this.selectedGithubRepositoryId = repository.id;
    this.cloneUrl = repository.cloneUrl;
  }

  async loadGithubRepositories(): Promise<void> {
    if (!this.selectedGithubUserId) {
      this.githubRepositories = [];
      return;
    }

    this.githubRepositoriesLoading = true;
    this.githubRepositoriesError = "";

    try {
      this.githubRepositories = await this.githubService.listRepositories(
        this.activeWorkspace().id,
        this.selectedGithubUserId,
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

  async cloneRepository(): Promise<void> {
    const selectedRepository = this.githubRepositories.find(
      (repository) => repository.id === this.selectedGithubRepositoryId,
    );
    const remoteUrl = this.cloneSource === "github" ? selectedRepository?.cloneUrl ?? "" : this.cloneUrl;

    if (!remoteUrl.trim() || !this.cloneDestination.trim()) {
      this.toastService.warning(
        this.translationService.translate("repositories.urlAndDestination"),
        this.translationService.translate("repositories.incompleteTitle"),
      );
      return;
    }

    if (this.cloneSource === "github" && !this.selectedGithubUserId) {
      this.toastService.warning(
        this.translationService.translate("repositories.accountRequired"),
        this.translationService.translate("repositories.accountRequiredTitle"),
      );
      return;
    }

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
        this.activeWorkspace().id,
        this.cloneSource === "github" ? this.selectedGithubUserId : undefined,
      );
      const added = this.repositoryService.add({
        name: repositoryInfo.name,
        path: repositoryInfo.path,
        workspaceId: this.activeWorkspace().id,
        cloneSource: this.cloneSource,
        authenticationSource: this.cloneSource === "github" ? "github" : "system",
        githubConnectionId:
          this.cloneSource === "github" ? this.selectedGithubUserId : undefined,
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
