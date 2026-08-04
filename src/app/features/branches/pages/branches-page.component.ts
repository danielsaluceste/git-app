import { Component, inject, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute } from "@angular/router";
import { RepositoryReferences, RepositoryStatus } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";

type BranchFormMode = "create" | "rename";

@Component({
  selector: "app-branches-page",
  imports: [ConfirmDialogComponent, FormsModule],
  templateUrl: "./branches-page.component.html",
  styleUrl: "./branches-page.component.css",
})
export class BranchesPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly route = inject(ActivatedRoute);
  private readonly toastService = inject(ToastService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly references = signal<RepositoryReferences | undefined>(undefined);
  readonly repositoryStatus = signal<RepositoryStatus | undefined>(undefined);
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly showBranchForm = signal(false);
  readonly branchFormMode = signal<BranchFormMode>("create");
  readonly branchName = signal("");
  readonly branchFormError = signal("");
  readonly renameTarget = signal("");
  readonly createFromCommit = signal<string | undefined>(undefined);
  readonly pendingCreateBranch = signal<{ name: string; startPoint?: string } | undefined>(undefined);
  readonly pendingCheckoutBranch = signal<string | undefined>(undefined);
  readonly pendingDeleteBranch = signal<string | undefined>(undefined);

  ngOnInit(): void {
    const commitHash = this.route.snapshot.queryParamMap.get("from") || undefined;
    this.createFromCommit.set(commitHash);
    if (commitHash) {
      this.openCreateBranch();
    }
    void this.loadReferences();
  }

  async loadReferences(): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    try {
      this.references.set(await this.repositoryService.getReferences(repository.path));
      try {
        this.repositoryStatus.set(await this.repositoryService.getStatus(repository.path));
      } catch {
        this.repositoryStatus.set(undefined);
      }
    } catch {
      this.toastService.error(
        "Não foi possível carregar as referências deste repositório.",
        "Branches",
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
      this.branchFormError.set("Informe um nome para a branch.");
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
          this.createFromCommit()
            ? `Branch "${name}" criada a partir do commit selecionado e ativada.`
            : `Branch "${name}" criada e ativada.`,
          "Branch criada",
        );
      } else {
        await this.repositoryService.renameBranch(repository.path, this.renameTarget(), name);
        this.toastService.success(`Branch renomeada para "${name}".`, "Branch renomeada");
      }

      this.createFromCommit.set(undefined);
      this.closeBranchForm();
      await this.loadReferences();
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Branch");
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
      this.toastService.success(`Branch "${branch}" excluída.`, "Branch excluída");
      await this.loadReferences();
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Branch");
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
      this.toastService.success(`Branch "${branch}" ativada.`, "Branch atualizada");
      await this.loadReferences();
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Branch");
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
    return "Não foi possível executar a operação na branch.";
  }
}
