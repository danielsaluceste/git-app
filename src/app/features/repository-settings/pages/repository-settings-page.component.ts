import { Component, inject } from "@angular/core";
import { Router } from "@angular/router";
import {
  Repository,
  RepositoryAuthenticationSource,
} from "../../../core/models/repository.model";
import { GithubService } from "../../../core/services/github.service";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";

@Component({
  selector: "app-repository-settings-page",
  templateUrl: "./repository-settings-page.component.html",
  styleUrl: "./repository-settings-page.component.css",
})
export class RepositorySettingsPageComponent {
  private readonly repositoryService = inject(RepositoryService);
  private readonly githubService = inject(GithubService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly githubConnections = this.githubService.workspaceConnections;

  selectedSource: RepositoryAuthenticationSource = "system";
  selectedGithubConnectionId: number | undefined;
  isSaving = false;

  constructor() {
    const repository = this.activeRepository();
    this.selectedSource = repository?.authenticationSource ?? "system";
    this.selectedGithubConnectionId = repository?.githubConnectionId;
  }

  selectSource(source: RepositoryAuthenticationSource): void {
    this.selectedSource = source;

    if (source === "github" && this.selectedGithubConnectionId === undefined) {
      this.selectedGithubConnectionId = this.githubConnections().find(
        (connection) => connection.isDefault,
      )?.id ?? this.githubConnections()[0]?.id;
    }
  }

  selectGithubConnectionFromEvent(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);

    if (Number.isFinite(value) && value > 0) {
      this.selectedGithubConnectionId = value;
    }
  }

  openIntegrations(): void {
    void this.router.navigate(["/integrations"]);
  }

  goBack(): void {
    void this.router.navigate(["/overview"]);
  }

  save(): void {
    const repository = this.activeRepository();
    if (!repository || this.isSaving) {
      return;
    }

    if (this.selectedSource === "github" && this.selectedGithubConnectionId === undefined) {
      this.toastService.warning("Conecte ou escolha uma conta GitHub primeiro.", "Conta não selecionada");
      return;
    }

    this.isSaving = true;
    const updated = this.repositoryService.updateAuthentication(
      repository,
      this.selectedSource,
      this.selectedGithubConnectionId,
    );
    this.isSaving = false;

    if (!updated) {
      this.toastService.error("Não foi possível salvar a autenticação deste repositório.", "Configurações");
      return;
    }

    const account = this.githubConnections().find(
      (connection) => connection.id === this.selectedGithubConnectionId,
    );
    this.toastService.success(
      this.selectedSource === "github"
        ? `Sincronização usando @${account?.login ?? "conta GitHub"}.`
        : "Sincronização usando as credenciais do computador.",
      "Configurações salvas",
    );
  }

  sourceLabel(repository: Repository): string {
    if (repository.authenticationSource === "github") {
      const account = this.githubConnections().find(
        (connection) => connection.id === repository.githubConnectionId,
      );
      return account ? `GitHub · @${account.login}` : "GitHub · conta não disponível";
    }

    return "Credenciais do computador";
  }
}
