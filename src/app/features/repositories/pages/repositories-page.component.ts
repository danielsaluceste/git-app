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
import { WorkspaceService } from "../../../core/services/workspace.service";

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
  cloneStage = "Preparando clonagem";
  cloneDetail = "Conectando ao repositório remoto...";
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
          : "Não foi possível carregar os repositórios desta conta.";
    } finally {
      this.githubRepositoriesLoading = false;
    }
  }

  async chooseCloneDestination(): Promise<void> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Escolher pasta vazia para clonar",
      });

      if (typeof selected === "string") {
        this.cloneDestination = selected;
      }
    } catch {
      this.toastService.error("Não foi possível abrir o seletor de pastas.", "Destino do clone");
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
        title: "Adicionar repositório local",
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
        this.toastService.warning("Este repositório já está adicionado neste workspace.", "Repositório duplicado");
      } else {
        this.toastService.success("Repositório adicionado ao workspace.", "Repositório adicionado");
      }
    } catch (error: unknown) {
      this.toastService.error(
        typeof error === "string"
          ? error
          : "Não foi possível adicionar a pasta. Selecione um repositório Git válido.",
        "Repositório local",
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
      this.toastService.warning("Informe a URL e escolha uma pasta de destino.", "Dados incompletos");
      return;
    }

    if (this.cloneSource === "github" && !this.selectedGithubUserId) {
      this.toastService.warning("Escolha a conta GitHub que será usada no clone.", "Conta não selecionada");
      return;
    }

    this.isLoading = true;
    this.cloneOperationId = this.createCloneOperationId();
    this.cloneProgress = 0;
    this.cloneStage = "Preparando clonagem";
    this.cloneDetail = "Conectando ao repositório remoto...";
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
        this.toastService.warning("Este repositório já está adicionado neste workspace.", "Repositório duplicado");
      } else {
        this.toastService.success("Repositório clonado e adicionado ao workspace.", "Clone concluído");
      }
    } catch (error: unknown) {
      if (this.cloneCancelRequested) {
        this.toastService.info("A clonagem foi cancelada.", "Clone cancelado");
      } else {
        this.toastService.error(
          typeof error === "string" ? error : "Não foi possível clonar o repositório.",
          "Falha ao clonar",
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
    this.cloneStage = "Cancelando clonagem";
    this.cloneDetail = "Interrompendo o Git com segurança...";

    try {
      await this.repositoryService.cancelClone(this.cloneOperationId);
    } catch {
      this.toastService.warning("A clonagem já pode ter sido finalizada.", "Cancelamento");
    }
  }

  @HostListener("document:keydown.escape")
  onEscapeKeydown(): void {
    this.closeAddRepositoryModal();
  }

  openRepository(repository: Repository): void {
    this.repositoryService.setActive(repository);
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
      this.cloneStage = event.payload.stage;
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
}
