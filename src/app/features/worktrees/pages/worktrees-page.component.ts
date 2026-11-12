import { Component, computed, DestroyRef, effect, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormsModule } from "@angular/forms";
import { NavigationEnd, Router } from "@angular/router";
import { filter } from "rxjs";
import { open } from "@tauri-apps/plugin-dialog";
import { Repository, RepositoryReferences, RepositoryWorktree } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

@Component({
  selector: "app-worktrees-page",
  imports: [FormsModule, ConfirmDialogComponent, TranslatePipe],
  templateUrl: "./worktrees-page.component.html",
  styleUrl: "./worktrees-page.component.css",
})
export class WorktreesPageComponent {
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);
  private readonly destroyRef = inject(DestroyRef);
  private loadVersion = 0;

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly references = signal<RepositoryReferences | undefined>(undefined);
  readonly worktrees = signal<RepositoryWorktree[]>([]);
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly formOpen = signal(false);
  readonly createNewBranch = signal(true);
  readonly selectedBranch = signal("");
  readonly newBranchName = signal("");
  readonly startPoint = signal("");
  readonly destinationParent = signal("");
  readonly folderName = signal("");
  readonly formError = signal("");
  readonly pendingRemoval = signal<RepositoryWorktree | undefined>(undefined);
  readonly destinationPath = computed(() => {
    const rawParent = this.destinationParent().trim();
    const trimmedParent = rawParent.replace(/[\\/]+$/, "");
    const parent = trimmedParent || (rawParent.startsWith("/") ? "/" : "");
    const folder = this.folderName().trim().replace(/^[\\/]+|[\\/]+$/g, "");
    if (!parent || !folder) {
      return "";
    }
    const separator = parent.includes("\\") ? "\\" : "/";
    const prefix = parent.endsWith("/") || parent.endsWith("\\") ? parent : `${parent}${separator}`;
    return `${prefix}${folder}`;
  });

  private readonly activeRepositoryEffect = effect(() => {
    const repository = this.activeRepository();
    if (this.isCurrentRoute()) {
      void this.load(repository);
    }
  });

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        if ((event.urlAfterRedirects.split(/[?#]/, 1)[0].endsWith("/worktrees") || event.urlAfterRedirects === "/worktrees")) {
          void this.load(this.activeRepository());
        }
      });
  }

  private isCurrentRoute(): boolean {
    const path = this.router.url.split(/[?#]/, 1)[0];
    return path.endsWith("/worktrees") || path === "/worktrees";
  }

  async load(repository: Repository | undefined): Promise<void> {
    const version = ++this.loadVersion;
    if (!repository) {
      this.worktrees.set([]);
      this.references.set(undefined);
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    try {
      const [worktrees, references] = await Promise.all([
        this.repositoryService.getWorktrees(repository.path),
        this.repositoryService.getReferences(repository.path),
      ]);
      if (version === this.loadVersion) {
        this.worktrees.set(worktrees);
        this.references.set(references);
        if (!this.startPointOptions().includes(this.startPoint())) {
          this.startPoint.set(references.currentBranch || references.localBranches[0] || references.remoteBranches[0] || references.tags[0] || "HEAD");
        }
        if (!references.localBranches.includes(this.selectedBranch())) {
          this.selectedBranch.set(references.localBranches[0] || "");
        }
      }
    } catch (error: unknown) {
      if (version === this.loadVersion) {
        this.toastService.error(this.errorMessage(error), this.translationService.translate("worktrees.title"));
      }
    } finally {
      if (version === this.loadVersion) {
        this.isLoading.set(false);
      }
    }
  }

  openCreateForm(): void {
    const currentBranch = this.references()?.currentBranch || "main";
    this.createNewBranch.set(true);
    this.newBranchName.set(`work/${currentBranch.replaceAll("/", "-")}-copy`);
    this.startPoint.set(currentBranch);
    this.folderName.set(`${currentBranch.replaceAll("/", "-")}-worktree`);
    this.destinationParent.set("");
    this.formError.set("");
    this.formOpen.set(true);
  }

  setNewBranchName(value: string): void {
    this.newBranchName.set(value);
    if (this.folderName().endsWith("-worktree") || !this.folderName()) {
      this.folderName.set(`${value.trim().replaceAll("/", "-")}-worktree`);
    }
  }

  startPointOptions(): string[] {
    const references = this.references();
    return [...new Set([
      ...(references?.localBranches ?? []),
      ...(references?.remoteBranches ?? []),
      ...(references?.tags ?? []),
      "HEAD",
    ])];
  }

  async chooseParentFolder(): Promise<void> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: this.translationService.translate("worktrees.chooseParent"),
      });
      if (typeof selected === "string") {
        this.destinationParent.set(selected);
      }
    } catch {
      this.formError.set(this.translationService.translate("worktrees.folderPickerError"));
    }
  }

  async createWorktree(): Promise<void> {
    const repository = this.activeRepository();
    const destination = this.destinationPath();
    const branch = this.createNewBranch() ? this.newBranchName().trim() : this.selectedBranch();
    const startPoint = this.createNewBranch() ? this.startPoint().trim() : branch;
    if (!repository || !destination || !branch) {
      this.formError.set(this.translationService.translate("worktrees.formRequired"));
      return;
    }

    this.isSaving.set(true);
    this.formError.set("");
    try {
      await this.repositoryService.addWorktree(
        repository.path,
        destination,
        branch,
        startPoint,
        this.createNewBranch(),
      );
      const info = await this.repositoryService.inspectLocalRepository(destination);
      const newRepository: Repository = {
        ...info,
        workspaceId: repository.workspaceId,
        cloneSource: "local",
        authenticationSource: "system",
      };
      this.repositoryService.add(newRepository);
      this.repositoryService.openRepository(newRepository);
      this.formOpen.set(false);
      void this.repositoryService.refreshAfterRepositoryOpened(newRepository).catch(() => undefined);
      await this.router.navigateByUrl("/overview");
    } catch (error: unknown) {
      this.formError.set(this.errorMessage(error));
    } finally {
      this.isSaving.set(false);
    }
  }

  cancelCreate(): void {
    if (!this.isSaving()) {
      this.formOpen.set(false);
    }
  }

  async openWorktree(worktree: RepositoryWorktree): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }
    try {
      const info = await this.repositoryService.inspectLocalRepository(worktree.path);
      const selected: Repository = {
        ...info,
        workspaceId: repository.workspaceId,
        cloneSource: "local",
        authenticationSource: "system",
      };
      this.repositoryService.add(selected);
      this.repositoryService.openRepository(selected);
      void this.repositoryService.refreshAfterRepositoryOpened(selected).catch(() => undefined);
      await this.router.navigateByUrl("/overview");
    } catch (error: unknown) {
      this.toastService.error(this.errorMessage(error), this.translationService.translate("worktrees.openErrorTitle"));
    }
  }

  requestRemoval(worktree: RepositoryWorktree): void {
    if (!worktree.isCurrent) {
      this.pendingRemoval.set(worktree);
    }
  }

  cancelRemoval(): void {
    this.pendingRemoval.set(undefined);
  }

  async removeWorktree(): Promise<void> {
    const repository = this.activeRepository();
    const worktree = this.pendingRemoval();
    if (!repository || !worktree || this.isSaving()) {
      return;
    }

    this.pendingRemoval.set(undefined);
    this.isSaving.set(true);
    try {
      await this.repositoryService.removeWorktree(repository.path, worktree.path);
      this.repositoryService.remove(repository.workspaceId, worktree.path);
      await this.load(repository);
    } catch (error: unknown) {
      this.toastService.error(this.errorMessage(error), this.translationService.translate("worktrees.removeErrorTitle"));
    } finally {
      this.isSaving.set(false);
    }
  }

  private errorMessage(error: unknown): string {
    return typeof error === "string" && error.trim() ? error.trim() : this.translationService.translate("worktrees.genericError");
  }
}
