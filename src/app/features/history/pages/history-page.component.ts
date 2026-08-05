import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  OnInit,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { fromEvent } from "rxjs";
import { Router } from "@angular/router";
import { Commit } from "../../../core/models/commit.model";
import { CommitFile } from "../../../core/models/commit-file.model";
import { GitFile } from "../../../core/models/git-file.model";
import { Repository } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { FileDiffDialogComponent } from "../../../shared/dialogs/file-diff-dialog/file-diff-dialog.component";

type SyncAction = "fetch" | "pull" | "push" | "";

interface CommitContextMenu {
  commit: Commit;
  x: number;
  y: number;
}

@Component({
  selector: "app-history-page",
  imports: [ConfirmDialogComponent, FileDiffDialogComponent],
  templateUrl: "./history-page.component.html",
  styleUrl: "./history-page.component.css",
})
export class HistoryPageComponent implements OnInit, AfterViewInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly commits = signal<Commit[]>([]);
  readonly isLoading = signal(true);
  readonly selectedCommit = signal<Commit | undefined>(undefined);
  readonly currentBranch = signal("HEAD destacado");
  readonly aheadCount = signal(0);
  readonly behindCount = signal(0);
  readonly actionBarScrolled = signal(false);
  readonly syncAction = signal<SyncAction>("");
  readonly selectedCommitFiles = signal<CommitFile[]>([]);
  readonly commitFilesLoading = signal(false);
  readonly commitFilesError = signal("");
  readonly selectedCommitFile = signal<GitFile | undefined>(undefined);
  readonly commitFileDiff = signal("");
  readonly commitFileDiffLoading = signal(false);
  readonly commitFileDiffError = signal("");
  readonly isCheckingOut = signal(false);
  readonly pendingCheckoutCommit = signal<Commit | undefined>(undefined);
  readonly commitContextMenu = signal<CommitContextMenu | undefined>(undefined);

  ngOnInit(): void {
    void this.loadOverview();
  }

  ngAfterViewInit(): void {
    const scrollContainer = this.elementRef.nativeElement.closest(".content") as HTMLElement | null;
    if (!scrollContainer) {
      return;
    }

    this.actionBarScrolled.set(scrollContainer.scrollTop > 8);
    fromEvent(scrollContainer, "scroll", { passive: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.actionBarScrolled.set(scrollContainer.scrollTop > 8));
  }

  async loadOverview(): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    try {
      const [commits, references, status] = await Promise.all([
        this.repositoryService.getCommits(repository.path),
        this.repositoryService.getReferences(repository.path),
        this.repositoryService.getStatus(repository.path),
      ]);
      this.commits.set(commits);
      this.currentBranch.set(references.currentBranch || "HEAD destacado");
      this.aheadCount.set(status.aheadCount);
      this.behindCount.set(status.behindCount);
      if (this.selectedCommit() && !commits.some((commit) => commit.hash === this.selectedCommit()?.hash)) {
        this.selectedCommit.set(undefined);
        this.selectedCommitFiles.set([]);
      }
    } catch (error: unknown) {
      this.toastService.error(
        "Não foi possível carregar o histórico deste repositório.",
        "Visão geral",
      );
    } finally {
      this.isLoading.set(false);
    }
  }

  selectCommit(commit: Commit): void {
    this.closeCommitContextMenu();
    this.selectedCommit.set(commit);
    this.selectedCommitFiles.set([]);
    this.commitFilesError.set("");
    this.selectedCommitFile.set(undefined);
    void this.loadCommitFiles(commit);
  }

  createBranchFromSelectedCommit(): void {
    const commit = this.selectedCommit();
    if (commit) {
      void this.router.navigate(["/branches"], { queryParams: { from: commit.hash } });
    }
  }

  async requestCheckoutCommit(commit: Commit): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.isCheckingOut() || this.syncAction()) {
      return;
    }

    this.closeCommitContextMenu();
    this.isCheckingOut.set(true);

    try {
      const status = await this.repositoryService.getStatus(repository.path);
      if (status.isDirty) {
        this.pendingCheckoutCommit.set(commit);
        return;
      }

      await this.executeCheckoutCommit(commit, false);
    } catch (error: unknown) {
      this.toastService.error(this.getCommitCheckoutErrorMessage(error), "Checkout do commit");
    } finally {
      this.isCheckingOut.set(false);
    }
  }

  cancelCheckoutCommit(): void {
    this.pendingCheckoutCommit.set(undefined);
  }

  async confirmCheckoutCommit(): Promise<void> {
    const commit = this.pendingCheckoutCommit();
    this.pendingCheckoutCommit.set(undefined);
    if (commit) {
      await this.executeCheckoutCommit(commit, true);
    }
  }

  openCommitContextMenu(event: MouseEvent, commit: Commit): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectCommit(commit);
    const position = this.getCommitContextMenuPosition(event);
    this.commitContextMenu.set({
      commit,
      x: position.x,
      y: position.y,
    });
  }

  checkoutFromContextMenu(): void {
    const commit = this.commitContextMenu()?.commit;
    this.closeCommitContextMenu();
    if (commit) {
      void this.requestCheckoutCommit(commit);
    }
  }

  @HostListener("document:click")
  closeCommitContextMenu(): void {
    this.commitContextMenu.set(undefined);
  }

  @HostListener("document:keydown.escape")
  onEscapeKeydown(): void {
    this.closeCommitContextMenu();
  }

  private getCommitContextMenuPosition(event: MouseEvent): { x: number; y: number } {
    const target = event.currentTarget as HTMLElement | null;
    const page = target?.closest<HTMLElement>(".page");
    const pageRect = page?.getBoundingClientRect();
    const originX = pageRect?.left ?? 0;
    const originY = pageRect?.top ?? 0;
    const availableWidth = pageRect?.width ?? window.innerWidth;
    const availableHeight = pageRect?.height ?? window.innerHeight;
    const menuWidth = 224;
    const menuHeight = 96;

    return {
      x: Math.max(8, Math.min(event.clientX - originX, availableWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY - originY, availableHeight - menuHeight - 8)),
    };
  }

  async loadCommitFiles(commit: Commit): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.commitFilesLoading.set(true);
    this.commitFilesError.set("");

    try {
      this.selectedCommitFiles.set(await this.repositoryService.getCommitFiles(repository.path, commit.hash));
    } catch (error: unknown) {
      this.commitFilesError.set(this.getCommitFilesErrorMessage(error));
    } finally {
      this.commitFilesLoading.set(false);
    }
  }

  async openCommitFile(file: CommitFile): Promise<void> {
    const repository = this.activeRepository();
    const commit = this.selectedCommit();
    if (!repository || !commit) {
      return;
    }

    this.selectedCommitFile.set({
      path: file.path,
      status: file.status,
      isStaged: true,
    });
    this.commitFileDiff.set("");
    this.commitFileDiffError.set("");
    this.commitFileDiffLoading.set(true);

    try {
      this.commitFileDiff.set(
        await this.repositoryService.getCommitFileDiff(repository.path, commit.hash, file.path),
      );
    } catch (error: unknown) {
      this.commitFileDiffError.set(this.getCommitFilesErrorMessage(error));
    } finally {
      this.commitFileDiffLoading.set(false);
    }
  }

  closeCommitFile(): void {
    this.selectedCommitFile.set(undefined);
    this.commitFileDiff.set("");
    this.commitFileDiffError.set("");
    this.commitFileDiffLoading.set(false);
  }

  statusCode(status: GitFile["status"]): string {
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

  async runSync(action: Exclude<SyncAction, "">): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.syncAction()) {
      return;
    }

    this.syncAction.set(action);
    const syncCredentials = this.getSyncCredentials(repository);

    try {
      if (action === "fetch") {
        await this.repositoryService.fetch(
          repository.path,
          syncCredentials.workspaceId,
          syncCredentials.githubUserId,
        );
        this.toastService.success("Referências remotas atualizadas.", "Fetch concluído");
      } else if (action === "pull") {
        await this.repositoryService.pull(
          repository.path,
          syncCredentials.workspaceId,
          syncCredentials.githubUserId,
        );
        this.toastService.success("Alterações baixadas e aplicadas.", "Pull concluído");
      } else {
        await this.repositoryService.push(
          repository.path,
          syncCredentials.workspaceId,
          syncCredentials.githubUserId,
        );
        this.toastService.success("Alterações enviadas para o repositório remoto.", "Push concluído");
      }

      await this.loadOverview();
    } catch (error: unknown) {
      this.toastService.error(this.getSyncErrorMessage(error), "Sincronização");
    } finally {
      this.syncAction.set("");
    }
  }

  private async executeCheckoutCommit(commit: Commit, saveChanges: boolean): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.isCheckingOut.set(true);
    try {
      if (saveChanges) {
        await this.repositoryService.stash(repository.path, `Antes do checkout ${commit.shortHash}`);
      }

      await this.repositoryService.checkoutCommit(repository.path, commit.hash);
      this.toastService.success(
        saveChanges
          ? `Alterações guardadas em stash. Checkout no commit ${commit.shortHash} concluído.`
          : `Checkout no commit ${commit.shortHash} concluído. O repositório está em HEAD destacado.`,
        "Checkout do commit",
      );
      await this.loadOverview();
    } catch (error: unknown) {
      this.toastService.error(this.getCommitCheckoutErrorMessage(error), "Checkout do commit");
    } finally {
      this.isCheckingOut.set(false);
    }
  }

  formatDate(date: string): string {
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
      return date;
    }

    return parsedDate.toLocaleString("pt-BR", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  syncLabel(action: Exclude<SyncAction, "">): string {
    if (this.syncAction() === action) {
      return action === "fetch" ? "Buscando..." : action === "pull" ? "Baixando..." : "Enviando...";
    }

    return action === "fetch" ? "Fetch" : action === "pull" ? "Pull" : "Push";
  }

  private getSyncErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return `Não foi possível executar a sincronização: ${error.trim()}`;
    }

    if (error instanceof Error && error.message) {
      return `Não foi possível executar a sincronização: ${error.message}`;
    }

    return "Não foi possível executar a sincronização com o repositório remoto.";
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

  private getCommitCheckoutErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return `Não foi possível fazer checkout neste commit: ${error.trim()}`;
    }

    if (error instanceof Error && error.message) {
      return `Não foi possível fazer checkout neste commit: ${error.message}`;
    }

    return "Não foi possível fazer checkout neste commit.";
  }

  private getCommitFilesErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return "Não foi possível carregar os arquivos deste commit.";
  }
}
