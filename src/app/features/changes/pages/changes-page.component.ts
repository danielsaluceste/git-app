import { Component, inject, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { GitFile, GitFileStatus } from "../../../core/models/git-file.model";
import { RepositoryStatus } from "../../../core/models/repository.model";
import { CommitAiService } from "../../../core/services/commit-ai.service";
import { RepositoryService } from "../../../core/services/repository.service";
import { SettingsService } from "../../../core/services/settings.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";

@Component({
  selector: "app-changes-page",
  imports: [ConfirmDialogComponent, FormsModule],
  templateUrl: "./changes-page.component.html",
  styleUrl: "./changes-page.component.css",
})
export class ChangesPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly settingsService = inject(SettingsService);
  private readonly commitAiService = inject(CommitAiService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly status = signal<RepositoryStatus | undefined>(undefined);
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly errorMessage = signal("");
  readonly successMessage = signal("");
  readonly commitMessage = signal("");
  readonly aiEnabled = this.settingsService.aiEnabled;
  readonly aiSupported = this.commitAiService.isSupported;
  readonly aiLoadingModel = this.commitAiService.isLoadingModel;
  readonly aiGenerating = this.commitAiService.isGenerating;
  readonly aiProgress = this.commitAiService.progress;
  readonly aiProgressText = this.commitAiService.progressText;
  readonly showAiDownloadConfirm = signal(false);
  readonly aiModelSize = this.commitAiService.modelSizeLabel;
  private pendingAiDiff = "";

  ngOnInit(): void {
    void this.loadStatus();
  }

  async loadStatus(): Promise<boolean> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoading.set(false);
      return false;
    }

    this.isLoading.set(true);
    this.errorMessage.set("");

    try {
      this.status.set(await this.repositoryService.getStatus(repository.path));
      return true;
    } catch {
      this.errorMessage.set("Não foi possível carregar o status deste repositório.");
      return false;
    } finally {
      this.isLoading.set(false);
    }
  }

  stagedFiles(files: GitFile[]): GitFile[] {
    return files.filter((file) => file.isStaged);
  }

  unstagedFiles(files: GitFile[]): GitFile[] {
    return files.filter((file) => !file.isStaged);
  }

  async stageFile(file: GitFile): Promise<void> {
    await this.runGitAction(
      (repository) => this.repositoryService.stageFiles(repository.path, [file.path]),
      "Arquivo preparado para commit.",
    );
  }

  async unstageFile(file: GitFile): Promise<void> {
    await this.runGitAction(
      (repository) => this.repositoryService.unstageFiles(repository.path, [file.path]),
      "Arquivo removido do stage.",
    );
  }

  async stageAll(files: GitFile[]): Promise<void> {
    const paths = this.unstagedFiles(files).map((file) => file.path);
    if (paths.length === 0) {
      return;
    }

    await this.runGitAction(
      (repository) => this.repositoryService.stageFiles(repository.path, paths),
      "Todos os arquivos foram preparados para commit.",
    );
  }

  async unstageAll(files: GitFile[]): Promise<void> {
    const paths = this.stagedFiles(files).map((file) => file.path);
    if (paths.length === 0) {
      return;
    }

    await this.runGitAction(
      (repository) => this.repositoryService.unstageFiles(repository.path, paths),
      "Todos os arquivos foram removidos do stage.",
    );
  }

  async commitChanges(files: GitFile[]): Promise<void> {
    const repository = this.activeRepository();
    const message = this.commitMessage().trim();

    if (!repository) {
      return;
    }
    if (!message) {
      this.errorMessage.set("Digite uma mensagem para o commit.");
      return;
    }
    if (this.stagedFiles(files).length === 0) {
      this.errorMessage.set("Prepare pelo menos um arquivo antes de criar o commit.");
      return;
    }

    const committed = await this.runGitAction(
      () => this.repositoryService.commit(repository.path, message),
      "Commit criado com sucesso.",
    );
    if (committed) {
      this.commitMessage.set("");
    }
  }

  async generateCommitWithAi(files: GitFile[]): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.stagedFiles(files).length === 0) {
      this.errorMessage.set("Prepare pelo menos um arquivo antes de usar a IA.");
      return;
    }

    this.errorMessage.set("");
    this.successMessage.set("");

    try {
      const diff = await this.repositoryService.getStagedDiff(repository.path);
      if (!diff.trim()) {
        this.errorMessage.set("Não há conteúdo staged suficiente para a IA analisar.");
        return;
      }

      if (!(await this.commitAiService.isModelCached())) {
        this.pendingAiDiff = diff;
        this.showAiDownloadConfirm.set(true);
        return;
      }

      await this.generateFromDiff(diff);
    } catch (error: unknown) {
      this.errorMessage.set(this.getAiErrorMessage(error));
    }
  }

  async confirmAiDownload(): Promise<void> {
    this.showAiDownloadConfirm.set(false);
    const diff = this.pendingAiDiff;
    this.pendingAiDiff = "";
    if (diff) {
      await this.generateFromDiff(diff);
    }
  }

  cancelAiDownload(): void {
    this.pendingAiDiff = "";
    this.showAiDownloadConfirm.set(false);
  }

  statusLabel(status: GitFileStatus): string {
    switch (status) {
      case "added":
        return "Adicionado";
      case "deleted":
        return "Excluído";
      case "renamed":
        return "Renomeado";
      case "untracked":
        return "Não rastreado";
      case "modified":
        return "Modificado";
    }
  }

  statusCode(status: GitFileStatus): string {
    switch (status) {
      case "added":
        return "A";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "untracked":
        return "?";
      case "modified":
        return "M";
    }
  }

  private async generateFromDiff(diff: string): Promise<void> {
    try {
      const generatedMessage = await this.commitAiService.generateCommitMessage(diff);
      this.commitMessage.set(generatedMessage);
      this.successMessage.set("Mensagem sugerida pela IA local. Revise antes de criar o commit.");
    } catch (error: unknown) {
      this.errorMessage.set(this.getAiErrorMessage(error));
    }
  }

  private getAiErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return `Não foi possível gerar a mensagem: ${error.trim()}`;
    }

    if (error instanceof Error && error.message) {
      return `Não foi possível gerar a mensagem: ${error.message}`;
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = String(error.message).trim();
      if (message) {
        return `Não foi possível gerar a mensagem: ${message}`;
      }
    }

    return "Não foi possível gerar a mensagem com a IA local.";
  }

  private async runGitAction(
    action: (repository: NonNullable<ReturnType<typeof this.activeRepository>>) => Promise<void>,
    successMessage: string,
  ): Promise<boolean> {
    const repository = this.activeRepository();
    if (!repository) {
      return false;
    }

    this.isSaving.set(true);
    this.errorMessage.set("");
    this.successMessage.set("");

    try {
      await action(repository);
      await this.loadStatus();
      this.successMessage.set(successMessage);
      return true;
    } catch (error: unknown) {
      this.errorMessage.set(typeof error === "string" ? error : "Não foi possível executar a ação do Git.");
      return false;
    } finally {
      this.isSaving.set(false);
    }
  }
}
