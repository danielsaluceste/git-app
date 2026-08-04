import { Component, computed, effect, HostListener, inject, OnInit, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { CommitFile } from "../../../core/models/commit-file.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";

@Component({
  selector: "app-stashes-page",
  imports: [ConfirmDialogComponent],
  templateUrl: "./stashes-page.component.html",
  styleUrl: "./stashes-page.component.css",
})
export class StashesPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly references = this.repositoryService.repositoryReferences;
  readonly stashes = computed(() => this.references()?.stashes ?? []);
  readonly isLoading = signal(true);
  readonly isApplying = signal(false);
  readonly pendingDeleteStash = signal<string | undefined>(undefined);
  readonly selectedStash = signal<string | undefined>(undefined);
  readonly stashFiles = signal<CommitFile[]>([]);
  readonly stashLoading = signal(false);
  readonly selectedFile = signal<CommitFile | undefined>(undefined);
  readonly fileDiff = signal("");
  readonly fileDiffLoading = signal(false);
  readonly fileDiffError = signal("");
  private fileDiffRequestId = 0;

  private readonly closeMissingSelection = effect(() => {
    const references = this.references();
    const selectedStash = this.selectedStash();
    if (
      references &&
      selectedStash &&
      !references.stashes.some((stash) => this.stashReference(stash) === selectedStash)
    ) {
      this.closeDetails();
    }
  });

  ngOnInit(): void {
    void this.loadReferences();
    this.route.queryParamMap.subscribe((params) => {
      const stashRef = params.get("stash") ?? undefined;
      if (!stashRef) {
        this.resetDetails();
      } else if (stashRef !== this.selectedStash()) {
        void this.loadStashDetails(stashRef);
      }
    });
  }

  async loadReferences(): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    try {
      await this.repositoryService.getReferences(repository.path);
    } catch (error: unknown) {
      this.toastService.error(this.getErrorMessage(error), "Stashes");
    } finally {
      this.isLoading.set(false);
    }
  }

  stashReference(stash: string): string {
    return stash.split("|", 1)[0] ?? stash;
  }

  stashDescription(stash: string): string {
    const description = this.rawStashDescription(stash);
    const separatorIndex = description.indexOf(":");
    const message = separatorIndex >= 0 ? description.slice(separatorIndex + 1).trim() : description;
    return message || "Sem mensagem";
  }

  stashBranch(stash: string): string {
    const description = this.rawStashDescription(stash);
    const separatorIndex = description.indexOf(":");
    return separatorIndex >= 0 ? description.slice(0, separatorIndex).trim() : "Branch desconhecida";
  }

  stashDescriptionByReference(stashRef: string): string {
    const stash = this.stashes().find((item) => this.stashReference(item) === stashRef);
    return stash ? this.stashDescription(stash) : stashRef;
  }

  stashBranchByReference(stashRef: string): string {
    const stash = this.stashes().find((item) => this.stashReference(item) === stashRef);
    return stash ? this.stashBranch(stash) : "Branch desconhecida";
  }

  openStash(stash: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { stash: this.stashReference(stash) },
      queryParamsHandling: "merge",
    });
  }

  closeDetails(): void {
    this.resetDetails();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { stash: null },
      queryParamsHandling: "merge",
    });
  }

  async applyStash(stashRef: string): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.isApplying()) {
      return;
    }

    this.isApplying.set(true);
    try {
      await this.repositoryService.applyStash(repository.path, stashRef);
      this.toastService.success("As alterações do stash foram aplicadas.", "Stash aplicado");
    } catch (error: unknown) {
      this.toastService.error(this.getErrorMessage(error), "Aplicar stash");
    } finally {
      this.isApplying.set(false);
    }
  }

  @HostListener("document:keydown", ["$event"])
  onArrowKeydown(event: KeyboardEvent): void {
    const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const files = this.stashFiles();

    if (!direction || !files.length || this.stashLoading() || this.pendingDeleteStash()) {
      return;
    }

    const activeElement = document.activeElement as HTMLElement | null;
    if (
      activeElement?.tagName === "INPUT" ||
      activeElement?.tagName === "TEXTAREA" ||
      activeElement?.tagName === "SELECT" ||
      activeElement?.isContentEditable
    ) {
      return;
    }

    const currentIndex = files.findIndex((file) => file.path === this.selectedFile()?.path);
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : files.length - 1
      : Math.min(Math.max(currentIndex + direction, 0), files.length - 1);

    if (nextIndex === currentIndex) {
      return;
    }

    event.preventDefault();
    void this.openStashFile(files[nextIndex]);
  }

  requestDeleteStash(): void {
    const stashRef = this.selectedStash();
    if (stashRef && !this.isApplying()) {
      this.pendingDeleteStash.set(stashRef);
    }
  }

  cancelDeleteStash(): void {
    this.pendingDeleteStash.set(undefined);
  }

  async confirmDeleteStash(): Promise<void> {
    const stashRef = this.pendingDeleteStash();
    const repository = this.activeRepository();
    this.pendingDeleteStash.set(undefined);

    if (!stashRef || !repository) {
      return;
    }

    this.isApplying.set(true);
    try {
      await this.repositoryService.dropStash(repository.path, stashRef);
      await this.loadReferences();
      this.toastService.success("O stash foi excluído.", "Stash excluído");
      this.closeDetails();
    } catch (error: unknown) {
      this.toastService.error(this.getErrorMessage(error), "Exclusão de stash");
    } finally {
      this.isApplying.set(false);
    }
  }

  async openStashFile(file: CommitFile): Promise<void> {
    const repository = this.activeRepository();
    const stashRef = this.selectedStash();
    if (!repository || !stashRef) {
      return;
    }

    const requestId = ++this.fileDiffRequestId;
    this.selectedFile.set(file);
    this.fileDiff.set("");
    this.fileDiffError.set("");
    this.fileDiffLoading.set(true);

    try {
      const diff = await this.repositoryService.getStashFileDiff(repository.path, stashRef, file.path);
      if (requestId === this.fileDiffRequestId) {
        this.fileDiff.set(diff);
      }
    } catch (error: unknown) {
      if (requestId === this.fileDiffRequestId) {
        this.fileDiffError.set(this.getErrorMessage(error));
      }
    } finally {
      if (requestId === this.fileDiffRequestId) {
        this.fileDiffLoading.set(false);
      }
    }
  }

  diffLines(): string[] {
    return this.fileDiff().split("\n");
  }

  diffLineClass(line: string): string {
    if (line.startsWith("@@")) {
      return "diff-hunk";
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      return "diff-file-header";
    }
    if (line.startsWith("+")) {
      return "diff-added";
    }
    if (line.startsWith("-")) {
      return "diff-removed";
    }

    return "diff-context";
  }

  statusCode(status: string): string {
    switch (status) {
      case "added":
        return "A";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "untracked":
        return "?";
      default:
        return "M";
    }
  }

  private async loadStashDetails(stashRef: string): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.selectedStash.set(stashRef);
    this.stashFiles.set([]);
    this.selectedFile.set(undefined);
    this.fileDiff.set("");
    this.fileDiffError.set("");
    this.stashLoading.set(true);

    try {
      const files = await this.repositoryService.getStashFiles(repository.path, stashRef);
      if (this.selectedStash() !== stashRef) {
        return;
      }

      this.stashFiles.set(files);
      if (files[0]) {
        await this.openStashFile(files[0]);
      }
    } catch (error: unknown) {
      this.toastService.error(this.getErrorMessage(error), "Detalhes do stash");
    } finally {
      this.stashLoading.set(false);
    }
  }

  private resetDetails(): void {
    this.selectedStash.set(undefined);
    this.stashFiles.set([]);
    this.stashLoading.set(false);
    this.selectedFile.set(undefined);
    this.fileDiff.set("");
    this.fileDiffLoading.set(false);
    this.fileDiffError.set("");
  }

  private rawStashDescription(stash: string): string {
    const [, ...parts] = stash.split("|");
    return parts.join("|").trim();
  }

  private getErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "Não foi possível executar a operação do stash.";
  }
}
