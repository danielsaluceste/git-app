import { Component, computed, HostListener, inject, Input, OnChanges, OnInit, signal, SimpleChanges } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink, RouterLinkActive } from "@angular/router";
import { LayoutService } from "../../core/services/layout.service";
import { Repository, RepositoryReferences } from "../../core/models/repository.model";
import { RepositoryService } from "../../core/services/repository.service";
import { ToastService } from "../../core/services/toast.service";
import { ConfirmDialogComponent } from "../../shared/dialogs/confirm-dialog/confirm-dialog.component";

type ReferenceSection = "local" | "remote" | "tags" | "stashes";
type BranchReferenceType = "local" | "remote";

interface BranchContextMenu {
  branch: string;
  type: BranchReferenceType;
  x: number;
  y: number;
}

interface BranchDeletionRequest {
  branch: string;
  type: BranchReferenceType;
}

interface StashContextMenu {
  stashRef: string;
  label: string;
  x: number;
  y: number;
}

const EMPTY_REFERENCES: RepositoryReferences = {
  localBranches: [],
  remoteBranches: [],
  tags: [],
  stashes: [],
};

@Component({
  selector: "app-repository-sidebar",
  imports: [ConfirmDialogComponent, FormsModule, RouterLink, RouterLinkActive],
  templateUrl: "./repository-sidebar.component.html",
  styleUrl: "./repository-sidebar.component.css",
})
export class RepositorySidebarComponent implements OnInit, OnChanges {
  @Input({ required: true }) repository!: Repository;

  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);

  readonly references = computed(() => this.repositoryService.repositoryReferences() ?? EMPTY_REFERENCES);
  readonly isLoadingReferences = signal(true);
  readonly changesCount = computed(() => this.repositoryService.repositoryStatus()?.files.length ?? 0);
  readonly aheadCount = computed(() => this.repositoryService.repositoryStatus()?.aheadCount ?? 0);
  readonly behindCount = computed(() => this.repositoryService.repositoryStatus()?.behindCount ?? 0);
  readonly isDirty = computed(() => this.repositoryService.repositoryStatus()?.isDirty ?? false);
  readonly isBranchActionRunning = signal(false);
  readonly showCreateBranch = signal(false);
  readonly newBranchName = signal("");
  readonly createBranchStartPoint = signal<string | undefined>(undefined);
  readonly contextMenu = signal<BranchContextMenu | undefined>(undefined);
  readonly stashContextMenu = signal<StashContextMenu | undefined>(undefined);
  readonly pendingDeleteBranch = signal<BranchDeletionRequest | undefined>(undefined);
  readonly pendingDeleteStash = signal<string | undefined>(undefined);
  readonly pendingCheckoutBranch = signal<string | undefined>(undefined);
  readonly pendingCreateBranch = signal<
    { name: string; startPoint?: string } | undefined
  >(undefined);
  expandedSections: Record<ReferenceSection, boolean> = {
    local: true,
    remote: false,
    tags: false,
    stashes: false,
  };

  async ngOnInit(): Promise<void> {
    try {
      await this.repositoryService.getReferences(this.repository.path);
    } catch {
      this.toastService.error("Não foi possível carregar as referências do Git.", "Referências do Git");
    } finally {
      this.isLoadingReferences.set(false);
    }

    try {
      await this.repositoryService.getStatus(this.repository.path);
    } catch {
      // A página de alterações exibirá o erro detalhado se o status falhar.
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["repository"] && !changes["repository"].firstChange) {
      this.isLoadingReferences.set(true);
      void this.ngOnInit();
    }
  }

  toggleSection(section: ReferenceSection): void {
    this.expandedSections[section] = !this.expandedSections[section];
  }

  async refreshRemoteReferences(): Promise<void> {
    if (this.isBranchActionRunning()) {
      return;
    }

    this.isBranchActionRunning.set(true);
    try {
      const syncCredentials = this.getSyncCredentials();
      await this.repositoryService.fetch(
        this.repository.path,
        syncCredentials.workspaceId,
        syncCredentials.githubUserId,
      );
      await this.refreshRepositoryData();
      this.toastService.success("As referências remotas foram atualizadas.", "Fetch concluído");
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Fetch");
    } finally {
      this.isBranchActionRunning.set(false);
    }
  }

  requestCheckout(branch: string): void {
    if (branch === this.references().currentBranch || this.isBranchActionRunning()) {
      return;
    }

    if (this.isDirty()) {
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

  openCreateBranch(startPoint?: string): void {
    this.newBranchName.set("");
    this.createBranchStartPoint.set(startPoint);
    this.showCreateBranch.set(true);
  }

  closeCreateBranch(): void {
    this.newBranchName.set("");
    this.createBranchStartPoint.set(undefined);
    this.showCreateBranch.set(false);
  }

  submitCreateBranch(): void {
    this.requestCreateBranch(this.newBranchName().trim(), this.createBranchStartPoint());
  }

  requestCreateRemoteBranch(remoteBranch: string, event?: Event): void {
    event?.stopPropagation();
    const localBranch = this.localBranchName(remoteBranch);
    this.requestCreateBranch(localBranch, remoteBranch);
  }

  openBranchContextMenu(event: MouseEvent, branch: string, type: BranchReferenceType): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.isBranchActionRunning()) {
      return;
    }

    this.stashContextMenu.set(undefined);
    const menuWidth = 248;
    const menuHeight = 190;
    this.contextMenu.set({
      branch,
      type,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  }

  closeBranchContextMenu(): void {
    this.contextMenu.set(undefined);
  }

  openStashContextMenu(event: MouseEvent, stash: string): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.isBranchActionRunning()) {
      return;
    }

    this.contextMenu.set(undefined);
    const menuWidth = 248;
    const menuHeight = 118;
    this.stashContextMenu.set({
      stashRef: this.stashReference(stash),
      label: this.stashLabel(stash),
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  }

  closeStashContextMenu(): void {
    this.stashContextMenu.set(undefined);
  }

  bringContextBranchToLocal(): void {
    const menu = this.contextMenu();
    this.closeBranchContextMenu();

    if (menu?.type === "remote") {
      this.requestCreateRemoteBranch(menu.branch);
    }
  }

  requestDeleteBranch(branch: string, type: BranchReferenceType): void {
    this.closeBranchContextMenu();

    if (type === "local" && branch === this.references().currentBranch) {
      return;
    }

    this.pendingDeleteBranch.set({ branch, type });
  }

  cancelDeleteBranch(): void {
    this.pendingDeleteBranch.set(undefined);
  }

  async confirmDeleteBranch(): Promise<void> {
    const request = this.pendingDeleteBranch();
    this.pendingDeleteBranch.set(undefined);

    if (!request) {
      return;
    }

    this.isBranchActionRunning.set(true);
    try {
      if (request.type === "remote") {
        await this.repositoryService.deleteRemoteBranch(this.repository.path, request.branch);
      } else {
        await this.repositoryService.deleteBranch(this.repository.path, request.branch);
      }

      await this.refreshRepositoryData();
      this.toastService.success(
        request.type === "remote"
          ? `A branch remota "${request.branch}" foi excluída.`
          : `A branch local "${request.branch}" foi excluída.`,
        "Branch excluída",
      );
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Exclusão de branch");
    } finally {
      this.isBranchActionRunning.set(false);
    }
  }

  requestDeleteStash(): void {
    const menu = this.stashContextMenu();
    this.closeStashContextMenu();
    if (menu) {
      this.pendingDeleteStash.set(menu.stashRef);
    }
  }

  cancelDeleteStash(): void {
    this.pendingDeleteStash.set(undefined);
  }

  async confirmDeleteStash(): Promise<void> {
    const stashRef = this.pendingDeleteStash();
    this.pendingDeleteStash.set(undefined);
    if (!stashRef) {
      return;
    }

    this.isBranchActionRunning.set(true);
    try {
      await this.repositoryService.dropStash(this.repository.path, stashRef);
      await this.refreshRepositoryData();
      this.toastService.success(`O stash "${stashRef}" foi excluído.`, "Stash excluído");
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Exclusão de stash");
    } finally {
      this.isBranchActionRunning.set(false);
    }
  }

  createBranchFromContext(): void {
    const menu = this.contextMenu();
    this.closeBranchContextMenu();

    if (menu) {
      this.openCreateBranch(menu.branch);
    }
  }

  @HostListener("document:click")
  handleDocumentClick(): void {
    this.closeBranchContextMenu();
    this.closeStashContextMenu();
  }

  @HostListener("document:keydown.escape")
  handleEscape(): void {
    this.closeBranchContextMenu();
    this.closeStashContextMenu();
  }

  cancelCreateBranch(): void {
    this.pendingCreateBranch.set(undefined);
  }

  async confirmCreateBranch(): Promise<void> {
    const request = this.pendingCreateBranch();
    this.pendingCreateBranch.set(undefined);
    if (request) {
      await this.createBranch(request.name, request.startPoint);
    }
  }

  syncPendingLabel(): string {
    const pending: string[] = [];
    if (this.aheadCount() > 0) {
      pending.push(`${this.aheadCount()} para enviar`);
    }
    if (this.behindCount() > 0) {
      pending.push(`${this.behindCount()} para baixar`);
    }

    return pending.join(" · ");
  }

  closeRepository(): void {
    const nextRepository = this.repositoryService.closeOpenRepository(this.repository);
    this.layoutService.openMainSidebar();

    if (nextRepository) {
      this.layoutService.closeMainSidebar();
      void this.router.navigate(["/overview"]);
      return;
    }

    void this.router.navigate(["/repositories"]);
  }

  private requestCreateBranch(name: string, startPoint?: string): void {
    if (!name) {
      this.toastService.warning("Informe um nome para a nova branch.", "Nova branch");
      this.showCreateBranch.set(true);
      return;
    }

    if (this.isDirty()) {
      this.pendingCreateBranch.set({ name, startPoint });
      return;
    }

    void this.createBranch(name, startPoint);
  }

  private async checkoutBranch(branch: string): Promise<void> {
    this.isBranchActionRunning.set(true);
    try {
      await this.repositoryService.checkoutBranch(this.repository.path, branch);
      await this.refreshRepositoryData();
      this.toastService.success(`Branch "${branch}" ativada.`, "Branch atualizada");
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Troca de branch");
    } finally {
      this.isBranchActionRunning.set(false);
    }
  }

  private async createBranch(name: string, startPoint?: string): Promise<void> {
    this.isBranchActionRunning.set(true);
    try {
      await this.repositoryService.createBranch(this.repository.path, name, startPoint);
      await this.refreshRepositoryData();
      this.closeCreateBranch();
      this.toastService.success(
        startPoint
          ? `Branch "${name}" criada a partir de "${startPoint}".`
          : `Branch "${name}" criada e ativada.`,
        "Nova branch",
      );
    } catch (error: unknown) {
      this.toastService.error(this.getGitErrorMessage(error), "Nova branch");
    } finally {
      this.isBranchActionRunning.set(false);
    }
  }

  private async refreshRepositoryData(): Promise<void> {
    await Promise.all([
      this.repositoryService.getReferences(this.repository.path),
      this.repositoryService.getStatus(this.repository.path),
    ]);
  }

  private getSyncCredentials(): { workspaceId?: string; githubUserId?: number } {
    if (this.repository.authenticationSource !== "github" || this.repository.githubConnectionId === undefined) {
      return {};
    }

    return {
      workspaceId: this.repository.workspaceId,
      githubUserId: this.repository.githubConnectionId,
    };
  }

  private localBranchName(remoteBranch: string): string {
    const separatorIndex = remoteBranch.indexOf("/");
    return separatorIndex >= 0 ? remoteBranch.slice(separatorIndex + 1) : remoteBranch;
  }

  stashLabel(stash: string): string {
    const [, ...parts] = stash.split("|");
    const description = parts.join("|").trim();
    const separatorIndex = description.indexOf(":");

    if (separatorIndex < 0) {
      return description || "Sem mensagem";
    }

    const message = description.slice(separatorIndex + 1).trim() || "Sem mensagem";
    const branch = description
      .slice(0, separatorIndex)
      .trim()
      .replace(/^(?:On|WIP on|index on)\s+/i, "");

    return branch ? `${message}: ${branch}` : message;
  }

  stashReference(stash: string): string {
    return stash.split("|")[0] ?? stash;
  }

  openStash(stash: string): void {
    void this.router.navigate(["/stashes"], { queryParams: { stash: this.stashReference(stash) } });
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
