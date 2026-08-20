import { Component, computed, effect, inject, OnInit, signal, untracked } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute } from "@angular/router";
import { RepositoryReferences, RepositoryStatus } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

type BranchFormMode = "create" | "rename";

@Component({
  selector: "app-branches-page",
  imports: [ConfirmDialogComponent, FormsModule, TranslatePipe],
  templateUrl: "./branches-page.component.html",
  styleUrl: "./branches-page.component.css",
})
export class BranchesPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly route = inject(ActivatedRoute);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly references = signal<RepositoryReferences | undefined>(undefined);
  readonly repositoryStatus = signal<RepositoryStatus | undefined>(undefined);
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly branchSearch = signal("");
  readonly showBranchForm = signal(false);
  readonly branchFormMode = signal<BranchFormMode>("create");
  readonly branchName = signal("");
  readonly branchFormError = signal("");
  readonly renameTarget = signal("");
  readonly createFromCommit = signal<string | undefined>(undefined);
  readonly pendingCreateBranch = signal<{ name: string; startPoint?: string } | undefined>(undefined);
  readonly pendingCheckoutBranch = signal<string | undefined>(undefined);
  readonly pendingDeleteBranch = signal<string | undefined>(undefined);
  readonly filteredLocalBranches = computed(() => this.filterBranches(this.references()?.localBranches ?? []));
  readonly filteredRemoteBranches = computed(() => this.filterBranches(this.references()?.remoteBranches ?? []));
  private readonly activeRepositoryEffect = effect(() => {
    const repository = this.activeRepository();
    this.repositoryService.repositoryRefreshVersion();
    untracked(() => void this.loadReferences(repository));
  });

  ngOnInit(): void {
    const commitHash = this.route.snapshot.queryParamMap.get("from") || undefined;
    this.createFromCommit.set(commitHash);
    if (commitHash) {
      this.openCreateBranch();
    }
  }

  clearBranchSearch(): void {
    this.branchSearch.set("");
  }

  private filterBranches(branches: string[]): string[] {
    const query = this.branchSearch().trim().toLocaleLowerCase("pt-BR");
    if (!query) {
      return branches;
    }

    return branches.filter((branch) => branch.toLocaleLowerCase("pt-BR").includes(query));
  }

  async loadReferences(repository = this.activeRepository()): Promise<void> {
    if (!repository) {
      this.isLoading.set(false);
      return;
    }

    const cachedReferences = this.repositoryService.getCachedReferences(repository.path);
    const cachedStatus = this.repositoryService.getCachedStatus(repository.path);

    if (cachedReferences) {
      this.references.set(cachedReferences);
    } else {
      this.references.set(undefined);
    }
    if (cachedStatus) {
      this.repositoryStatus.set(cachedStatus);
    } else {
      this.repositoryStatus.set(undefined);
    }
    this.isLoading.set(!cachedReferences && !cachedStatus);
    try {
      this.references.set(await this.repositoryService.getReferences(repository.path));
      try {
        this.repositoryStatus.set(await this.repositoryService.getStatus(repository.path));
      } catch {
        this.repositoryStatus.set(undefined);
      }
    } catch {
      this.toastService.error(
        this.translationService.translate("branches.loadError"),
        this.translationService.translate("branches.errorTitle"),
      );
    } finally {
      this.isLoading.set(false);
    }
  }

  openCreateBranch(): void {
    this.branchFormMode.set("create");
    this.branchName.set("");
    this.renameTarget.set("");
    this.branchFormError.set("");
    this.showBranchForm.set(true);
  }

  openRenameBranch(branch: string, event?: Event): void {
    event?.stopPropagation();
    this.branchFormMode.set("rename");
    this.branchName.set(branch);
    this.renameTarget.set(branch);
    this.branchFormError.set("");
    this.showBranchForm.set(true);
  }

  closeBranchForm(): void {
    this.showBranchForm.set(false);
    this.branchFormError.set("");
  }

  async submitBranch(skipDirtyConfirmation = false): Promise<void> {
    const repository = this.activeRepository();
    const name = this.branchName().trim();
    if (!repository) {
      return;
    }
    if (!name) {
      this.branchFormError.set(this.translationService.translate("branches.invalidName"));
      return;
    }
    if (this.branchFormMode() === "create" && this.repositoryStatus()?.isDirty && !skipDirtyConfirmation) {
      this.pendingCreateBranch.set({ name, startPoint: this.createFromCommit() });
      return;
    }

    this.isSaving.set(true);
    this.branchFormError.set("");

    try {
      if (this.branchFormMode() === "create") {
        await this.repositoryService.createBranch(repository.path, name, this.createFromCommit());
        this.toastService.success(
          this.translationService.translate(
            this.createFromCommit() ? "branches.createdFromMessage" : "branches.createdMessage",
            { name },
          ),
          this.translationService.translate("branches.createdTitle"),
        );
      } else {
        await this.repositoryService.renameBranch(repository.path, this.renameTarget(), name);
        this.toastService.success(
          this.translationService.translate("branches.renamedMessage", { name }),
          this.translationService.translate("branches.renamedTitle"),
        );
      }

      this.createFromCommit.set(undefined);
      this.closeBranchForm();
      await this.loadReferences();
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), this.translationService.translate("branches.operationErrorTitle"));
    } finally {
      this.isSaving.set(false);
    }
  }

  cancelCreateBranch(): void {
    this.pendingCreateBranch.set(undefined);
  }

  async confirmCreateBranch(): Promise<void> {
    const request = this.pendingCreateBranch();
    this.pendingCreateBranch.set(undefined);
    if (!request) {
      return;
    }

    this.branchName.set(request.name);
    this.createFromCommit.set(request.startPoint);
    await this.submitBranch(true);
  }

  requestCheckout(branch: string): void {
    const currentBranch = this.references()?.currentBranch;
    if (branch === currentBranch || this.isSaving()) {
      return;
    }

    if (this.repositoryStatus()?.isDirty) {
      this.pendingCheckoutBranch.set(branch);
      return;
    }

    void this.checkoutBranch(branch);
  }

  cancelCheckout(): void {
    this.pendingCheckoutBranch.set(undefined);
  }

  async confirmCheckout(): Promise<void> {
    const branch = this.pendingCheckoutBranch();
    this.pendingCheckoutBranch.set(undefined);
    if (branch) {
      await this.checkoutBranch(branch);
    }
  }

  requestDeleteBranch(branch: string, event?: Event): void {
    event?.stopPropagation();
    if (branch === this.references()?.currentBranch || this.isSaving()) {
      return;
    }

    this.pendingDeleteBranch.set(branch);
  }

  cancelDeleteBranch(): void {
    this.pendingDeleteBranch.set(undefined);
  }

  async confirmDeleteBranch(): Promise<void> {
    const repository = this.activeRepository();
    const branch = this.pendingDeleteBranch();
    this.pendingDeleteBranch.set(undefined);
    if (!repository || !branch) {
      return;
    }

    this.isSaving.set(true);
    try {
      await this.repositoryService.deleteBranch(repository.path, branch);
      this.toastService.success(
        this.translationService.translate("branches.deletedMessage", { name: branch }),
        this.translationService.translate("branches.deletedTitle"),
      );
      await this.loadReferences();
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), this.translationService.translate("branches.operationErrorTitle"));
    } finally {
      this.isSaving.set(false);
    }
  }

  statusCode(status: string): string {
    return status === "current" ? "✓" : "⑂";
  }

  private async checkoutBranch(branch: string): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.isSaving.set(true);
    try {
      await this.repositoryService.checkoutBranch(repository.path, branch);
      this.toastService.success(
        this.translationService.translate("branches.activatedMessage", { name: branch }),
        this.translationService.translate("branches.updatedTitle"),
      );
      await this.loadReferences();
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), this.translationService.translate("branches.operationErrorTitle"));
    } finally {
      this.isSaving.set(false);
    }
  }

  private getGitErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return this.translationService.translate("branches.operationError");
  }
}
