import { Component, inject } from "@angular/core";
import { Router } from "@angular/router";
import {
  Repository,
  RepositoryAuthenticationSource,
  RepositoryRemote,
} from "../../../core/models/repository.model";
import { GithubService } from "../../../core/services/github.service";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

@Component({
  selector: "app-repository-settings-page",
  imports: [ConfirmDialogComponent, TranslatePipe],
  templateUrl: "./repository-settings-page.component.html",
  styleUrl: "./repository-settings-page.component.css",
})
export class RepositorySettingsPageComponent {
  private readonly repositoryService = inject(RepositoryService);
  private readonly githubService = inject(GithubService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly githubConnections = this.githubService.workspaceConnections;

  selectedSource: RepositoryAuthenticationSource = "system";
  selectedGithubConnectionId: number | undefined;
  isSaving = false;
  remote: RepositoryRemote = {};
  remoteUrl = "";
  isLoadingRemote = true;
  isSavingRemote = false;
  pendingRemoteUrl = "";

  constructor() {
    const repository = this.activeRepository();
    this.selectedSource = repository?.authenticationSource ?? "system";
    this.selectedGithubConnectionId = repository?.githubConnectionId;
    void this.loadRemote();
  }

  async loadRemote(): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoadingRemote = false;
      return;
    }

    try {
      this.remote = await this.repositoryService.getRemote(repository.path);
      this.remoteUrl = this.remote.url ?? "";
    } catch (error: unknown) {
      this.toastService.error(
        typeof error === "string" ? error : this.translationService.translate("repoSettings.remoteReadError"),
        this.translationService.translate("repoSettings.remoteTitleShort"),
      );
    } finally {
      this.isLoadingRemote = false;
    }
  }

  updateRemoteUrl(event: Event): void {
    this.remoteUrl = (event.target as HTMLInputElement).value;
  }

  requestSaveRemoteUrl(): void {
    const normalizedUrl = this.remoteUrl.trim();
    if (!normalizedUrl) {
      this.toastService.warning(
        this.translationService.translate("repoSettings.validUrl"),
        this.translationService.translate("repoSettings.remoteTitleShort"),
      );
      return;
    }

    if (normalizedUrl === (this.remote.url ?? "").trim()) {
      this.toastService.info(
        this.translationService.translate("repoSettings.urlUpdated"),
        this.translationService.translate("repoSettings.remoteTitleShort"),
      );
      return;
    }

    this.pendingRemoteUrl = normalizedUrl;
  }

  cancelSaveRemoteUrl(): void {
    this.pendingRemoteUrl = "";
  }

  async confirmSaveRemoteUrl(): Promise<void> {
    const repository = this.activeRepository();
    const url = this.pendingRemoteUrl;
    this.pendingRemoteUrl = "";

    if (!repository || !url) {
      return;
    }

    this.isSavingRemote = true;
    try {
      this.remote = await this.repositoryService.setRemoteUrl(repository.path, url);
      this.remoteUrl = this.remote.url ?? url;
      this.toastService.success(
        this.translationService.translate("repoSettings.remoteUpdated", { remote: this.remote.name ?? "origin" }),
        this.translationService.translate("repoSettings.remoteUpdatedTitle"),
      );
    } catch (error: unknown) {
      this.toastService.error(
        typeof error === "string" ? error : this.translationService.translate("repoSettings.remoteUpdateError"),
        this.translationService.translate("repoSettings.remoteTitleShort"),
      );
    } finally {
      this.isSavingRemote = false;
    }
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
      this.toastService.warning(
        this.translationService.translate("repoSettings.accountRequired"),
        this.translationService.translate("repoSettings.accountRequiredTitle"),
      );
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
      this.toastService.error(
        this.translationService.translate("repoSettings.authSaveError"),
        this.translationService.translate("repoSettings.settingsTitle"),
      );
      return;
    }

    const account = this.githubConnections().find(
      (connection) => connection.id === this.selectedGithubConnectionId,
    );
    this.toastService.success(
      this.selectedSource === "github"
        ? this.translationService.translate("repoSettings.githubSync", { login: account?.login ?? "GitHub account" })
        : this.translationService.translate("repoSettings.computerSync"),
      this.translationService.translate("repoSettings.savedTitle"),
    );
  }

  sourceLabel(repository: Repository): string {
    if (repository.authenticationSource === "github") {
      const account = this.githubConnections().find(
        (connection) => connection.id === repository.githubConnectionId,
      );
      return account
        ? `GitHub · @${account.login}`
        : this.translationService.translate("repoSettings.githubAccountUnavailable");
    }

    return this.translationService.translate("repoSettings.computerCredentials");
  }
}
