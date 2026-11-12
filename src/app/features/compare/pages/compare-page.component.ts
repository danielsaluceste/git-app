import { Component, computed, effect, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Repository, RepositoryReferences, BranchComparison } from "../../../core/models/repository.model";
import { GitFile, ImagePreviewPair } from "../../../core/models/git-file.model";
import { CommitFile } from "../../../core/models/commit-file.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { FileDiffDialogComponent } from "../../../shared/dialogs/file-diff-dialog/file-diff-dialog.component";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

@Component({
  selector: "app-compare-page",
  imports: [FormsModule, FileDiffDialogComponent, TranslatePipe],
  templateUrl: "./compare-page.component.html",
  styleUrl: "./compare-page.component.css",
})
export class ComparePageComponent {
  private readonly repositoryService = inject(RepositoryService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);
  private loadVersion = 0;
  private diffRequestId = 0;

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly references = signal<RepositoryReferences | undefined>(undefined);
  readonly isLoading = signal(true);
  readonly isComparing = signal(false);
  readonly baseBranch = signal("");
  readonly targetBranch = signal("");
  readonly comparison = signal<BranchComparison | undefined>(undefined);
  readonly compareError = signal("");
  readonly selectedFile = signal<GitFile | undefined>(undefined);
  readonly fileDiff = signal("");
  readonly filePreview = signal<ImagePreviewPair | null>(null);
  readonly fileDiffLoading = signal(false);
  readonly fileDiffError = signal("");
  readonly compareFiles = computed(() =>
    (this.comparison()?.files ?? []).map((file) => ({ ...file, isStaged: false })),
  );

  private readonly activeRepositoryEffect = effect(() => {
    void this.loadReferences(this.activeRepository());
  });

  async loadReferences(repository = this.activeRepository()): Promise<void> {
    const version = ++this.loadVersion;
    if (!repository) {
      this.references.set(undefined);
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    try {
      const references = await this.repositoryService.getReferences(repository.path);
      if (version !== this.loadVersion) {
        return;
      }
      this.references.set(references);
      const current = references.currentBranch || references.localBranches[0] || "";
      const tracking = references.remoteBranches.find((branch) => branch.endsWith(`/${current}`));
      const base = tracking || references.localBranches.find((branch) => branch !== current) || current;
      this.baseBranch.set(base);
      this.targetBranch.set(current);
      if (base && current && base !== current) {
        void this.compare();
      }
    } catch (error: unknown) {
      if (version === this.loadVersion) {
        this.compareError.set(this.errorMessage(error));
      }
    } finally {
      if (version === this.loadVersion) {
        this.isLoading.set(false);
      }
    }
  }

  branchOptions(): string[] {
    const references = this.references();
    return [...new Set([...(references?.localBranches ?? []), ...(references?.remoteBranches ?? [])])];
  }

  async compare(): Promise<void> {
    const repository = this.activeRepository();
    const base = this.baseBranch();
    const target = this.targetBranch();
    if (!repository || !base || !target || base === target) {
      this.compareError.set(this.translationService.translate("compare.chooseDifferentBranches"));
      return;
    }

    this.isComparing.set(true);
    this.compareError.set("");
    this.selectedFile.set(undefined);
    this.comparison.set(undefined);
    try {
      this.comparison.set(await this.repositoryService.compareBranches(repository.path, base, target));
    } catch (error: unknown) {
      this.compareError.set(this.errorMessage(error));
    } finally {
      this.isComparing.set(false);
    }
  }

  async openFile(file: GitFile): Promise<void> {
    const repository = this.activeRepository();
    const comparison = this.comparison();
    if (!repository || !comparison) {
      return;
    }

    const requestId = ++this.diffRequestId;
    this.selectedFile.set(file);
    this.fileDiff.set("");
    this.filePreview.set(null);
    this.fileDiffError.set("");
    this.fileDiffLoading.set(true);
    try {
      const [diff, preview] = await Promise.all([
        this.repositoryService.getBranchComparisonDiff(
          repository.path,
          comparison.baseBranch,
          comparison.targetBranch,
          file.path,
        ),
        this.repositoryService.getBranchComparisonPreview(
          repository.path,
          comparison.baseBranch,
          comparison.targetBranch,
          file.path,
        ).catch(() => null),
      ]);
      if (requestId === this.diffRequestId) {
        this.fileDiff.set(diff);
        this.filePreview.set(preview);
      }
    } catch (error: unknown) {
      if (requestId === this.diffRequestId) {
        this.fileDiffError.set(this.errorMessage(error));
      }
    } finally {
      if (requestId === this.diffRequestId) {
        this.fileDiffLoading.set(false);
      }
    }
  }

  openComparisonFile(file: CommitFile): void {
    void this.openFile({ ...file, isStaged: false });
  }

  closeFile(): void {
    this.diffRequestId += 1;
    this.selectedFile.set(undefined);
    this.fileDiff.set("");
    this.filePreview.set(null);
    this.fileDiffLoading.set(false);
    this.fileDiffError.set("");
  }

  statusCode(status: GitFile["status"]): string {
    switch (status) {
      case "added": return "A";
      case "deleted": return "D";
      case "renamed": return "R";
      case "untracked": return "?";
      case "conflicted": return "!";
      case "modified": return "M";
    }
  }

  private errorMessage(error: unknown): string {
    return typeof error === "string" && error.trim() ? error.trim() : this.translationService.translate("compare.error");
  }
}
