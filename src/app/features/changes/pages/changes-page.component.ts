import { Component, computed, effect, HostListener, inject, OnDestroy, OnInit, signal, untracked } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { GitFile, GitFileStatus } from "../../../core/models/git-file.model";
import { AiModelId } from "../../../core/models/ai-model.model";
import { Repository, RepositoryOperation, RepositoryStatus } from "../../../core/models/repository.model";
import { CommitAiService } from "../../../core/services/commit-ai.service";
import { RepositoryService } from "../../../core/services/repository.service";
import { SettingsService } from "../../../core/services/settings.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { FileDiffDialogComponent } from "../../../shared/dialogs/file-diff-dialog/file-diff-dialog.component";
import { FixedBottomLayoutComponent } from "../../../shared/components/fixed-bottom-layout/fixed-bottom-layout.component";
import { ConflictResolverComponent } from "../../../shared/components/conflict-resolver/conflict-resolver.component";
import { StashDialogComponent } from "../../../shared/dialogs/stash-dialog/stash-dialog.component";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

interface FileContextMenu {
  file: GitFile;
  x: number;
  y: number;
}

@Component({
  selector: "app-changes-page",
  imports: [ConfirmDialogComponent, FileDiffDialogComponent, FixedBottomLayoutComponent, ConflictResolverComponent, StashDialogComponent, FormsModule, TranslatePipe],
  templateUrl: "./changes-page.component.html",
  styleUrl: "./changes-page.component.css",
})
export class ChangesPageComponent implements OnInit, OnDestroy {
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly settingsService = inject(SettingsService);
  private readonly commitAiService = inject(CommitAiService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

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
  readonly aiPreparing = signal(false);
  readonly aiProgress = this.commitAiService.progress;
  readonly aiProgressText = this.commitAiService.progressText;
  readonly showAiDownloadConfirm = signal(false);
  readonly aiModelSize = computed(() => this.translationService.translate(
    `settings.ai.model.${this.modelKey(this.commitAiService.selectedModel().id)}.size`,
  ));
  readonly selectedFile = signal<GitFile | undefined>(undefined);
  readonly selectedConflictFile = signal<GitFile | undefined>(undefined);
  readonly fileDiff = signal("");
  readonly fileDiffLoading = signal(false);
  readonly fileDiffError = signal("");
  readonly isOperationActionRunning = signal(false);
  readonly pendingAbortOperation = signal(false);
  readonly fileContextMenu = signal<FileContextMenu | undefined>(undefined);
  readonly pendingDiscardFile = signal<GitFile | undefined>(undefined);
  private pendingAiDiff = "";
  private statusLoadVersion = 0;
  private statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private statusRefreshInFlight = false;
  private lastLoadedRepoKey = "";
  private lastLoadedRefreshVersion = -1;

  private readonly activeRepositoryEffect = effect(() => {
    const repository = this.activeRepository();
    const refreshVersion = this.repositoryService.repositoryRefreshVersion();

    if (!repository) {
      this.isLoading.set(false);
      this.status.set(undefined);
      this.operation.set(undefined);
      this.lastLoadedRepoKey = "";
      return;
    }

    const repoKey = `${repository.workspaceId}:${repository.path.toLowerCase()}`;
    const isNewRepo = repoKey !== this.lastLoadedRepoKey;
    const isNewVersion = refreshVersion !== this.lastLoadedRefreshVersion;

    untracked(() => {
      this.restoreCommitDraft(repository);
      if (isNewRepo || isNewVersion || !this.status()) {
        this.lastLoadedRepoKey = repoKey;
        this.lastLoadedRefreshVersion = refreshVersion;
        void this.loadStatus(repository);
      }
    });
  });

  ngOnInit(): void {
    this.statusRefreshTimer = setInterval(() => this.refreshStatusIfVisible(), 30_000);
  }

  ngOnDestroy(): void {
    if (this.statusRefreshTimer !== undefined) {
      clearInterval(this.statusRefreshTimer);
    }
  }

  @HostListener("window:focus")
  onWindowFocus(): void {
    this.refreshStatusIfVisible();
  }

  @HostListener("document:visibilitychange")
  onVisibilityChange(): void {
    if (document.visibilityState === "visible") {
      this.refreshStatusIfVisible();
    }
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

    if (event.key === "Escape") {
      this.closeFileContextMenu();
    }
  }

  @HostListener("document:click")
  onDocumentClick(): void {
    this.closeFileContextMenu();
  }

  async loadStatus(
    repository = this.activeRepository(),
    cachedOnly = false,
  ): Promise<boolean> {
    const loadVersion = ++this.statusLoadVersion;

    if (!repository) {
      this.isLoading.set(false);
      this.status.set(undefined);
      this.operation.set(undefined);
      return false;
    }

    const cachedStatus = this.repositoryService.getCachedStatus(repository.path);
    const cachedOperation = this.repositoryService.getCachedOperation(repository.path);
    const hasCachedData = !!cachedStatus || cachedOperation !== undefined;

    if (cachedStatus) {
      this.status.set(cachedStatus);
    }
    if (cachedOperation !== undefined) {
      this.operation.set(cachedOperation ?? undefined);
    } else {
      this.operation.set(undefined);
    }
    this.isLoading.set(!hasCachedData);

    if (cachedOnly) {
      return hasCachedData;
    }

    try {
      const [repositoryStatus, operation] = await Promise.all([
        this.repositoryService.getStatus(repository.path),
        this.repositoryService.getOperation(repository.path).catch(() => null),
      ]);
      if (!this.isCurrentStatusLoad(repository, loadVersion)) {
        return false;
      }
      this.status.set(repositoryStatus);
      this.operation.set(operation ?? undefined);

      const currentSelected = this.selectedFile();
      if (currentSelected) {
        const stillExists = repositoryStatus.files.find((f) => f.path === currentSelected.path);
        if (stillExists) {
          this.selectedFile.set(stillExists);
          void this.refreshSelectedFileDiffQuietly(repository, stillExists);
        } else {
          this.selectedFile.set(undefined);
          this.fileDiff.set("");
        }
      }

      return true;
    } catch {
      if (!this.isCurrentStatusLoad(repository, loadVersion)) {
        return false;
      }

      this.toastService.error(
        this.translationService.translate("changes.statusLoadError"),
        this.translationService.translate("changes.statusTitle"),
      );
      return false;
    } finally {
      if (this.isCurrentStatusLoad(repository, loadVersion)) {
        this.isLoading.set(false);
      }
    }
  }

  private restoreCommitDraft(repository: Repository | undefined): void {
    const draft = repository
      ? this.repositoryService.getCachedCommitDraft(repository.path)
      : undefined;

    this.commitMessage.set(draft?.message ?? "");
    this.amendLastCommit.set(draft?.amend ?? false);
  }

  private persistCommitDraft(): void {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.repositoryService.setCachedCommitDraft(
      repository.path,
      this.commitMessage(),
      this.amendLastCommit(),
    );
  }

  private isCurrentStatusLoad(repository: Repository, loadVersion: number): boolean {
    const activeRepository = this.activeRepository();
    return loadVersion === this.statusLoadVersion &&
      !!activeRepository &&
      activeRepository.workspaceId === repository.workspaceId &&
      activeRepository.path.replaceAll("\\", "/").toLowerCase() ===
        repository.path.replaceAll("\\", "/").toLowerCase();
  }

  private refreshStatusIfVisible(): void {
    if (document.visibilityState === "hidden" || this.statusRefreshInFlight) {
      return;
    }

    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.statusRefreshInFlight = true;
    void this.loadStatus(repository).finally(() => {
      this.statusRefreshInFlight = false;
    });
  }

  stagedFiles(files: GitFile[]): GitFile[] {
    return files.filter((file) => file.isStaged);
  }

  unstagedFiles(files: GitFile[]): GitFile[] {
    return files.filter((file) => !file.isStaged);
  }

  setCommitMessage(message: string): void {
    this.commitMessage.set(message);
    this.persistCommitDraft();
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
      ? this.translationService.translate("changes.rebaseInProgress")
      : this.translationService.translate("changes.mergeInProgress");
  }

  operationDescription(): string {
    const branch = this.operation()?.currentBranch;
    const hasConflicts = this.conflictFiles(this.status()?.files ?? []).length > 0;

    if (branch && !hasConflicts) {
      return this.translationService.translate("changes.conflictsResolved", { branch });
    }

    return branch
      ? this.translationService.translate("changes.conflictsWaiting", { branch })
      : this.translationService.translate("changes.resolveAndContinue");
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
      this.toastService.warning(
        this.translationService.translate("changes.resolveBeforeContinue"),
        this.translationService.translate("changes.gitOperation"),
      );
      this.openFirstConflict();
      return;
    }

    this.isOperationActionRunning.set(true);
    try {
      await this.repositoryService.continueOperation(repository.path, operation.kind);
      this.toastService.success(
        this.translationService.translate(operation.kind === "merge" ? "changes.mergeCompleted" : "changes.rebaseCompleted"),
        this.translationService.translate(operation.kind === "merge" ? "changes.mergeCompletedTitle" : "changes.rebaseCompletedTitle"),
      );
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), this.translationService.translate("changes.continueErrorTitle"));
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
        this.translationService.translate(operation.kind === "merge" ? "changes.mergeAborted" : "changes.rebaseAborted"),
        this.translationService.translate(operation.kind === "merge" ? "changes.mergeAbortedTitle" : "changes.rebaseAbortedTitle"),
      );
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), this.translationService.translate("changes.abortErrorTitle"));
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

  private async refreshSelectedFileDiffQuietly(repository: Repository, file: GitFile): Promise<void> {
    try {
      const diff = await this.repositoryService.getFileDiff(repository.path, file.path, file.isStaged);
      if (this.selectedFile()?.path === file.path) {
        this.fileDiff.set(diff);
      }
    } catch {
      // Ignorar falhas silenciosas durante auto-refresh
    }
  }

  openFileContextMenu(event: MouseEvent, file: GitFile): void {
    if (this.isSaving()) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 220;
    const menuHeight = this.isConflictFile(file) ? 170 : 220;
    const margin = 8;
    const page = (event.currentTarget as HTMLElement).closest(".changes-page");
    const pageBounds = page?.getBoundingClientRect();
    const pointerX = pageBounds ? event.clientX - pageBounds.left : event.clientX;
    const pointerY = pageBounds ? event.clientY - pageBounds.top : event.clientY;
    const availableWidth = pageBounds?.width ?? window.innerWidth;
    const availableHeight = pageBounds?.height ?? window.innerHeight;
    const x = Math.min(Math.max(margin, pointerX), Math.max(margin, availableWidth - menuWidth - margin));
    const y = Math.min(Math.max(margin, pointerY), Math.max(margin, availableHeight - menuHeight - margin));
    this.fileContextMenu.set({ file, x, y });
  }

  closeFileContextMenu(): void {
    this.fileContextMenu.set(undefined);
  }

  openContextFileDiff(file: GitFile): void {
    this.closeFileContextMenu();
    void this.openFileDiff(file);
  }

  openContextConflictResolver(file: GitFile): void {
    this.closeFileContextMenu();
    this.openConflictResolver(file);
  }

  requestDiscardFile(file: GitFile): void {
    this.closeFileContextMenu();
    this.pendingDiscardFile.set(file);
  }

  cancelDiscardFile(): void {
    this.pendingDiscardFile.set(undefined);
  }

  async confirmDiscardFile(): Promise<void> {
    const repository = this.activeRepository();
    const file = this.pendingDiscardFile();
    this.pendingDiscardFile.set(undefined);

    if (!repository || !file || this.isSaving()) {
      return;
    }

    await this.runGitAction(
      (activeRepository) => this.repositoryService.discardFile(activeRepository.path, file.path),
      file.status === "untracked"
        ? this.translationService.translate("changes.deletedUntracked")
        : this.translationService.translate("changes.discardedFile"),
    );
  }

  isConflictFile(file: GitFile): boolean {
    return file.isConflicted === true || file.status === "conflicted";
  }

  discardFileTitle(file: GitFile): string {
    return this.translationService.translate(file.status === "untracked" ? "changes.deleteFile" : "changes.discardChanges");
  }

  discardFileMessage(file: GitFile): string {
    return file.status === "untracked"
      ? this.translationService.translate("changes.deleteFileMessage", { file: file.path })
      : this.translationService.translate("changes.discardChangesMessage", { file: file.path });
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
      this.translationService.translate("changes.stagedFile"),
    );
  }

  async unstageFile(file: GitFile): Promise<void> {
    await this.runGitAction(
      (repository) => this.repositoryService.unstageFiles(repository.path, [file.path]),
      this.translationService.translate("changes.unstagedFile"),
    );
  }

  async stageAll(files: GitFile[]): Promise<void> {
    const paths = this.unstagedFiles(files).map((file) => file.path);
    if (paths.length === 0) {
      return;
    }

    await this.runGitAction(
      (repository) => this.repositoryService.stageFiles(repository.path, paths),
      this.translationService.translate("changes.stagedAll"),
    );
  }

  async unstageAll(files: GitFile[]): Promise<void> {
    const paths = this.stagedFiles(files).map((file) => file.path);
    if (paths.length === 0) {
      return;
    }

    await this.runGitAction(
      (repository) => this.repositoryService.unstageFiles(repository.path, paths),
      this.translationService.translate("changes.unstagedAll"),
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
        this.toastService.warning(this.translationService.translate("changes.commitMessageRequired"));
        return;
      }
    }
    if (this.isLoadingAmendMessage()) {
      return;
    }
    if (this.stagedFiles(files).length === 0) {
      this.toastService.warning(this.translationService.translate("changes.stageRequired"));
      return;
    }
    if (this.conflictFiles(files).length > 0) {
      this.toastService.warning(this.translationService.translate("changes.conflictRequired"));
      return;
    }

    const committed = await this.runGitAction(
      () => this.repositoryService.commit(repository.path, message, this.amendLastCommit()),
      this.amendLastCommit()
        ? this.translationService.translate("changes.amendSuccess")
        : this.translationService.translate("changes.commitSuccess"),
    );
    if (committed) {
      this.commitMessage.set("");
      this.amendLastCommit.set(false);
      this.repositoryService.clearCachedCommitDraft(repository.path);
      void this.router.navigate(["/overview"]);
    }
  }

  async toggleAmend(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    this.amendLastCommit.set(enabled);
    this.persistCommitDraft();
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
      this.persistCommitDraft();
    } catch (error: unknown) {
      this.amendLastCommit.set(false);
      this.persistCommitDraft();
      (event.target as HTMLInputElement).checked = false;
      this.toastService.error(this.getGitErrorMessage(error), this.translationService.translate("changes.amendErrorTitle"));
    } finally {
      this.isLoadingAmendMessage.set(false);
    }
  }

  async generateCommitWithAi(files: GitFile[]): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.stagedFiles(files).length === 0) {
      this.toastService.warning(this.translationService.translate("changes.aiStageRequired"));
      return;
    }

    this.aiPreparing.set(true);
    this.commitAiService.prepareForAnalysis();

    try {
      const diff = await this.repositoryService.getStagedDiff(repository.path);
      if (!diff.trim()) {
        this.toastService.warning(this.translationService.translate("changes.aiNoDiff"));
        return;
      }

      if (!(await this.commitAiService.isModelCached())) {
        this.pendingAiDiff = diff;
        this.showAiDownloadConfirm.set(true);
        return;
      }

      this.aiPreparing.set(false);
      await this.generateFromDiff(diff);
    } catch (error: unknown) {
      this.toastService.error(this.getAiErrorMessage(error), this.translationService.translate("changes.aiToastTitle"));
    } finally {
      this.aiPreparing.set(false);
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
      this.toastService.warning(this.translationService.translate("changes.stashConflicts"));
      return;
    }
    if (files.length > 0 && selectedPaths.length === 0) {
      this.toastService.warning(this.translationService.translate("changes.stashSelection"));
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
      this.translationService.translate("changes.stashSaved"),
    );
    if (saved) {
      await this.repositoryService.getReferences(repository.path);
      this.closeStashForm();
    }
  }

  statusLabel(status: GitFileStatus): string {
    switch (status) {
      case "added":
        return this.translationService.translate("diff.added");
      case "deleted":
        return this.translationService.translate("diff.deleted");
      case "renamed":
        return this.translationService.translate("diff.renamed");
      case "untracked":
        return this.translationService.translate("diff.untracked");
      case "conflicted":
        return this.translationService.translate("diff.conflicted");
      case "modified":
        return this.translationService.translate("diff.modified");
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
      this.setCommitMessage(generatedMessage);
      this.toastService.success(
        this.translationService.translate("changes.aiSuggested"),
        this.translationService.translate("changes.aiToastTitle"),
      );
    } catch (error: unknown) {
      this.toastService.error(this.getAiErrorMessage(error), this.translationService.translate("changes.aiToastTitle"));
    }
  }

  private getAiErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return this.translationService.translate("changes.aiError", { message: error.trim() });
    }

    if (error instanceof Error && error.message) {
      return this.translationService.translate("changes.aiError", { message: error.message });
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = String(error.message).trim();
      if (message) {
        return this.translationService.translate("changes.aiError", { message });
      }
    }

    return this.translationService.translate("changes.aiGenericError");
  }

  private getGitErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return this.translationService.translate("changes.fileLoadError");
  }

  private modelKey(modelId: AiModelId): string {
    if (modelId.includes("0.5B")) {
      return "qwen05";
    }
    if (modelId.includes("1.5B")) {
      return "qwen15";
    }
    if (modelId.includes("3B")) {
      return "qwen3";
    }
    return "qwen7";
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
        typeof error === "string" ? error : this.translationService.translate("changes.actionError"),
        this.translationService.translate("changes.actionErrorTitle"),
      );
      return false;
    } finally {
      this.isSaving.set(false);
    }
  }
}
