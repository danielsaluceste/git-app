import { Component, inject, OnInit, signal } from "@angular/core";
import { Router } from "@angular/router";
import { Commit } from "../../../core/models/commit.model";
import { CommitFile } from "../../../core/models/commit-file.model";
import { GitFile } from "../../../core/models/git-file.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { FileDiffDialogComponent } from "../../../shared/dialogs/file-diff-dialog/file-diff-dialog.component";

type SyncAction = "fetch" | "pull" | "push" | "";

@Component({
  selector: "app-history-page",
  imports: [FileDiffDialogComponent],
  templateUrl: "./history-page.component.html",
  styleUrl: "./history-page.component.css",
})
export class HistoryPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly commits = signal<Commit[]>([]);
  readonly isLoading = signal(true);
  readonly selectedCommit = signal<Commit | undefined>(undefined);
  readonly currentBranch = signal("HEAD destacado");
  readonly aheadCount = signal(0);
  readonly behindCount = signal(0);
  readonly syncAction = signal<SyncAction>("");
  readonly selectedCommitFiles = signal<CommitFile[]>([]);
  readonly commitFilesLoading = signal(false);
  readonly commitFilesError = signal("");
  readonly selectedCommitFile = signal<GitFile | undefined>(undefined);
  readonly commitFileDiff = signal("");
  readonly commitFileDiffLoading = signal(false);
  readonly commitFileDiffError = signal("");

  ngOnInit(): void {
    void this.loadOverview();
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

    try {
      if (action === "fetch") {
        await this.repositoryService.fetch(repository.path);
        this.toastService.success("Referências remotas atualizadas.", "Fetch concluído");
      } else if (action === "pull") {
        await this.repositoryService.pull(repository.path);
        this.toastService.success("Alterações baixadas e aplicadas.", "Pull concluído");
      } else {
        await this.repositoryService.push(repository.path);
        this.toastService.success("Alterações enviadas para o repositório remoto.", "Push concluído");
      }

      await this.loadOverview();
    } catch (error: unknown) {
      this.toastService.error(this.getSyncErrorMessage(error), "Sincronização");
    } finally {
      this.syncAction.set("");
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
