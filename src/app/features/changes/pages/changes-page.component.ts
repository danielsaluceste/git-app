import { Component, HostListener, inject, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { GitFile, GitFileStatus } from "../../../core/models/git-file.model";
import { RepositoryOperation, RepositoryStatus } from "../../../core/models/repository.model";
import { CommitAiService } from "../../../core/services/commit-ai.service";
import { RepositoryService } from "../../../core/services/repository.service";
import { SettingsService } from "../../../core/services/settings.service";
import { ToastService } from "../../../core/services/toast.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { FileDiffDialogComponent } from "../../../shared/dialogs/file-diff-dialog/file-diff-dialog.component";
import { FixedBottomLayoutComponent } from "../../../shared/components/fixed-bottom-layout/fixed-bottom-layout.component";
import { ConflictResolverComponent } from "../../../shared/components/conflict-resolver/conflict-resolver.component";
import { StashDialogComponent } from "../../../shared/dialogs/stash-dialog/stash-dialog.component";

@Component({
  selector: "app-changes-page",
  imports: [ConfirmDialogComponent, FileDiffDialogComponent, FixedBottomLayoutComponent, ConflictResolverComponent, StashDialogComponent, FormsModule],
  templateUrl: "./changes-page.component.html",
  styleUrl: "./changes-page.component.css",
})
export class ChangesPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly settingsService = inject(SettingsService);
  private readonly commitAiService = inject(CommitAiService);
  private readonly toastService = inject(ToastService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly status = signal<RepositoryStatus | undefined>(undefined);
  readonly operation = signal<RepositoryOperation | undefined>(undefined);
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly isLoadingAmendMessage = signal(false);
  readonly commitMessage = signal("");
  readonly amendLastCommit = signal(false);
  readonly showStashForm = signal(false);
  readonly stashMessage = signal("");
  readonly stashFilePaths = signal<string[]>([]);
  readonly aiEnabled = this.settingsService.aiEnabled;
  readonly aiSupported = this.commitAiService.isSupported;
  readonly aiLoadingModel = this.commitAiService.isLoadingModel;
  readonly aiGenerating = this.commitAiService.isGenerating;
  readonly aiProgress = this.commitAiService.progress;
  readonly aiProgressText = this.commitAiService.progressText;
  readonly showAiDownloadConfirm = signal(false);
  readonly aiModelSize = this.commitAiService.modelSizeLabel;
  readonly selectedFile = signal<GitFile | undefined>(undefined);
  readonly selectedConflictFile = signal<GitFile | undefined>(undefined);
  readonly fileDiff = signal("");
  readonly fileDiffLoading = signal(false);
  readonly fileDiffError = signal("");
  readonly isOperationActionRunning = signal(false);
  readonly pendingAbortOperation = signal(false);
  private pendingAiDiff = "";

  ngOnInit(): void {
    void this.loadStatus();
  }

  @HostListener("window:keydown", ["$event"])
  onKeyboardShortcut(event: KeyboardEvent): void {
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key === "Enter") {
      const repositoryStatus = this.status();
      if (repositoryStatus && !this.isLoading() && !this.isSaving()) {
        event.preventDefault();
        void this.commitChanges(repositoryStatus.files);
      }
      return;
    }

    if (event.key === "Escape" && this.showStashForm() && !this.isSaving()) {
      this.closeStashForm();
    }
  }

  async loadStatus(): Promise<boolean> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoading.set(false);
      this.status.set(undefined);
      this.operation.set(undefined);
      return false;
    }

    this.isLoading.set(true);
    this.operation.set(undefined);
    try {
      const [repositoryStatus, operation] = await Promise.all([
        this.repositoryService.getStatus(repository.path),
        this.repositoryService.getOperation(repository.path).catch(() => null),
      ]);
      this.status.set(repositoryStatus);
      this.operation.set(operation ?? undefined);
      return true;
    } catch {
      this.toastService.error("Não foi possível carregar o status deste repositório.", "Status do Git");
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

  conflictFiles(files: GitFile[]): GitFile[] {
    return files.filter((file) => file.isConflicted || file.status === "conflicted");
  }

  openConflictResolver(file: GitFile): void {
    this.selectedConflictFile.set(file);
  }

  closeConflictResolver(): void {
    this.selectedConflictFile.set(undefined);
  }

  async onConflictResolved(): Promise<void> {
    this.closeConflictResolver();
    await this.loadStatus();
  }

  operationTitle(): string {
    return this.operation()?.kind === "rebase"
      ? "Rebase em andamento"
      : "Merge em andamento";
  }

  operationDescription(): string {
    const branch = this.operation()?.currentBranch;
    return branch
      ? `A branch ${branch} está aguardando a resolução dos conflitos e a continuação da operação.`
      : "Resolva os conflitos e continue ou aborte a operação Git.";
  }

  openFirstConflict(): void {
    const conflict = this.conflictFiles(this.status()?.files ?? [])[0];
    if (conflict) {
      this.openConflictResolver(conflict);
    }
  }

  async continueOperation(): Promise<void> {
    const repository = this.activeRepository();
    const operation = this.operation();
    const conflicts = this.conflictFiles(this.status()?.files ?? []);

    if (!repository || !operation || this.isOperationActionRunning()) {
      return;
    }
    if (conflicts.length > 0) {
      this.toastService.warning("Resolva todos os conflitos antes de continuar.", "Operação Git");
      this.openFirstConflict();
      return;
    }

    this.isOperationActionRunning.set(true);
    try {
      await this.repositoryService.continueOperation(repository.path, operation.kind);
      this.toastService.success(
        operation.kind === "merge" ? "O Merge foi concluído." : "O Rebase foi concluído.",
        operation.kind === "merge" ? "Merge concluído" : "Rebase concluído",
      );
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Continuar operação");
    } finally {
      await this.loadStatus();
      this.isOperationActionRunning.set(false);
    }
  }

  requestAbortOperation(): void {
    if (this.operation() && !this.isOperationActionRunning()) {
      this.pendingAbortOperation.set(true);
    }
  }

  cancelAbortOperation(): void {
    this.pendingAbortOperation.set(false);
  }

  async confirmAbortOperation(): Promise<void> {
    const repository = this.activeRepository();
    const operation = this.operation();
    this.pendingAbortOperation.set(false);

    if (!repository || !operation || this.isOperationActionRunning()) {
      return;
    }

    this.isOperationActionRunning.set(true);
    try {
      await this.repositoryService.abortOperation(repository.path, operation.kind);
      this.toastService.success(
        operation.kind === "merge" ? "O Merge foi abortado." : "O Rebase foi abortado.",
        operation.kind === "merge" ? "Merge abortado" : "Rebase abortado",
      );
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Abortar operação");
    } finally {
      await this.loadStatus();
      this.isOperationActionRunning.set(false);
    }
  }

  async openFileDiff(file: GitFile): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.selectedFile.set(file);
    this.fileDiff.set("");
    this.fileDiffError.set("");
    this.fileDiffLoading.set(true);

    try {
      const diff = await this.repositoryService.getFileDiff(repository.path, file.path, file.isStaged);
      this.fileDiff.set(diff);
    } catch (error: unknown) {
      this.fileDiffError.set(this.getGitErrorMessage(error));
    } finally {
      this.fileDiffLoading.set(false);
    }
  }

  closeFileDiff(): void {
    this.selectedFile.set(undefined);
    this.fileDiff.set("");
    this.fileDiffError.set("");
    this.fileDiffLoading.set(false);
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
      if (!this.amendLastCommit()) {
        this.toastService.warning("Digite uma mensagem para o commit.");
        return;
      }
    }
    if (this.isLoadingAmendMessage()) {
      return;
    }
    if (this.stagedFiles(files).length === 0) {
      this.toastService.warning("Prepare pelo menos um arquivo antes de criar o commit.");
      return;
    }
    if (this.conflictFiles(files).length > 0) {
      this.toastService.warning("Resolva todos os conflitos antes de criar o commit.");
      return;
    }

    const committed = await this.runGitAction(
      () => this.repositoryService.commit(repository.path, message, this.amendLastCommit()),
      this.amendLastCommit() ? "Último commit atualizado com sucesso." : "Commit criado com sucesso.",
    );
    if (committed) {
      this.commitMessage.set("");
      this.amendLastCommit.set(false);
      void this.router.navigate(["/overview"]);
    }
  }

  async toggleAmend(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    this.amendLastCommit.set(enabled);
    if (!enabled || this.commitMessage().trim()) {
      return;
    }

    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.isLoadingAmendMessage.set(true);
    try {
      this.commitMessage.set(await this.repositoryService.getLastCommitMessage(repository.path));
    } catch (error: unknown) {
      this.amendLastCommit.set(false);
      (event.target as HTMLInputElement).checked = false;
      this.toastService.error(this.getGitErrorMessage(error), "Amend");
    } finally {
      this.isLoadingAmendMessage.set(false);
    }
  }

  async generateCommitWithAi(files: GitFile[]): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.stagedFiles(files).length === 0) {
      this.toastService.warning("Prepare pelo menos um arquivo antes de usar a IA.");
      return;
    }

    try {
      const diff = await this.repositoryService.getStagedDiff(repository.path);
      if (!diff.trim()) {
        this.toastService.warning("Não há conteúdo staged suficiente para a IA analisar.");
        return;
      }

      if (!(await this.commitAiService.isModelCached())) {
        this.pendingAiDiff = diff;
        this.showAiDownloadConfirm.set(true);
        return;
      }

      await this.generateFromDiff(diff);
    } catch (error: unknown) {
      this.toastService.error(this.getAiErrorMessage(error), "IA local");
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

  openStashForm(): void {
    this.stashMessage.set("");
    this.stashFilePaths.set(
      (this.status()?.files ?? [])
        .filter((file) => !file.isConflicted && file.status !== "conflicted")
        .map((file) => file.path),
    );
    this.showStashForm.set(true);
  }

  closeStashForm(): void {
    this.stashMessage.set("");
    this.stashFilePaths.set([]);
    this.showStashForm.set(false);
  }

  async saveStash(): Promise<void> {
    const repository = this.activeRepository();
    const files = this.status()?.files ?? [];
    const selectedPaths = this.stashFilePaths();
    if (!repository) {
      return;
    }

    if (this.conflictFiles(files).length > 0) {
      this.toastService.warning("Resolva os conflitos antes de guardar um stash.");
      return;
    }
    if (files.length > 0 && selectedPaths.length === 0) {
      this.toastService.warning("Selecione pelo menos um arquivo para guardar no stash.");
      return;
    }

    const allPaths = files.map((file) => file.path);
    const isPartial = selectedPaths.length !== allPaths.length;

    const saved = await this.runGitAction(
      (activeRepository) =>
        this.repositoryService.stash(
          activeRepository.path,
          this.stashMessage().trim() || undefined,
          isPartial ? selectedPaths : undefined,
        ),
      "Alterações guardadas no stash.",
    );
    if (saved) {
      await this.repositoryService.getReferences(repository.path);
      this.closeStashForm();
    }
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
      case "conflicted":
        return "Conflito";
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
      case "conflicted":
        return "!";
      case "modified":
        return "M";
    }
  }

  private async generateFromDiff(diff: string): Promise<void> {
    try {
      const generatedMessage = await this.commitAiService.generateCommitMessage(diff);
      this.commitMessage.set(generatedMessage);
      this.toastService.success("Mensagem sugerida pela IA local. Revise antes de criar o commit.", "IA local");
    } catch (error: unknown) {
      this.toastService.error(this.getAiErrorMessage(error), "IA local");
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

  private getGitErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return "Não foi possível carregar as alterações deste arquivo.";
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

    try {
      await action(repository);
      await this.loadStatus();
      this.toastService.success(successMessage);
      return true;
    } catch (error: unknown) {
      this.toastService.error(
        typeof error === "string" ? error : "Não foi possível executar a ação do Git.",
        "Operação do Git",
      );
      return false;
    } finally {
      this.isSaving.set(false);
    }
  }
}
