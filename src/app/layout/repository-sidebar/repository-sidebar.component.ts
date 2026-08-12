import { Component, computed, effect, HostListener, inject, Input, OnChanges, OnInit, signal, SimpleChanges } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink, RouterLinkActive } from "@angular/router";
import { LayoutService } from "../../core/services/layout.service";
import { Repository, RepositoryReferences } from "../../core/models/repository.model";
import { RepositoryService } from "../../core/services/repository.service";
import { ToastService } from "../../core/services/toast.service";
import { ConfirmDialogComponent } from "../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { TranslatePipe } from "../../shared/pipes/translate.pipe";

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

type BranchOperationKind = "merge" | "rebase";

interface BranchOperationMenu {
  source: string;
  target: string;
  x: number;
  y: number;
}

interface BranchOperationRequest {
  kind: BranchOperationKind;
  source: string;
  target: string;
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
  imports: [ConfirmDialogComponent, FormsModule, RouterLink, RouterLinkActive, TranslatePipe],
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
  readonly branchOperationMenu = signal<BranchOperationMenu | undefined>(undefined);
  readonly pendingBranchOperation = signal<BranchOperationRequest | undefined>(undefined);
  readonly draggingBranch = signal<string | undefined>(undefined);
  readonly dragOverBranch = signal<string | undefined>(undefined);
  readonly pendingCreateBranch = signal<
    { name: string; startPoint?: string } | undefined
  >(undefined);
  expandedSections: Record<ReferenceSection, boolean> = {
    local: true,
    remote: false,
    tags: false,
    stashes: false,
  };
  private pressedBranch: string | undefined;
  private branchDragStartX = 0;
  private branchDragStartY = 0;
  private suppressBranchClickUntil = 0;
  private ignoreNextDocumentClick = false;
  private repositoryLoadVersion = 0;
  private readonly repositoryRefreshEffect = effect(() => {
    this.repositoryService.repositoryRefreshVersion();
    const repository = this.repository;

    if (repository && this.repositoryService.getCachedReferences(repository.path)) {
      this.isLoadingReferences.set(false);
    }
  });

  async ngOnInit(): Promise<void> {
    await this.loadRepositoryData(this.repository);
    return;

    try {
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
      void this.loadRepositoryData(this.repository, true);
    }
  }

  private async loadRepositoryData(repository: Repository, cachedOnly = false): Promise<void> {
    const loadVersion = ++this.repositoryLoadVersion;
    const cachedReferences = this.repositoryService.getCachedReferences(repository.path);
    this.isLoadingReferences.set(!cachedReferences);

    if (cachedOnly) {
      return;
    }

    try {
      await Promise.all([
        this.repositoryService.getReferences(repository.path),
        this.repositoryService.getStatus(repository.path).catch(() => undefined),
      ]);

      if (!this.isCurrentRepositoryLoad(repository, loadVersion)) {
        return;
      }
    } catch {
      if (!this.isCurrentRepositoryLoad(repository, loadVersion)) {
        return;
      }

      this.toastService.error("Falha ao carregar as referencias do Git.", "Referencias do Git");
    } finally {
      if (this.isCurrentRepositoryLoad(repository, loadVersion)) {
        this.isLoadingReferences.set(false);
      }
    }
  }

  private isCurrentRepositoryLoad(repository: Repository, loadVersion: number): boolean {
    return loadVersion === this.repositoryLoadVersion &&
      this.repository.workspaceId === repository.workspaceId &&
      this.repository.path.replaceAll("\\", "/").toLowerCase() ===
        repository.path.replaceAll("\\", "/").toLowerCase();
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
    if (Date.now() < this.suppressBranchClickUntil || branch === this.references().currentBranch || this.isBranchActionRunning()) {
      return;
    }

    if (this.isDirty()) {
      this.pendingCheckoutBranch.set(branch);
      return;
    }

    void this.checkoutBranch(branch);
  }

  startBranchPointerDrag(branch: string, event: PointerEvent): void {
    if (event.button !== 0 || this.isBranchActionRunning()) {
      return;
    }

    this.pressedBranch = branch;
    this.branchDragStartX = event.clientX;
    this.branchDragStartY = event.clientY;
    this.draggingBranch.set(undefined);
    this.dragOverBranch.set(undefined);
    this.closeBranchContextMenu();
    this.closeBranchOperationMenu();
  }

  @HostListener("document:pointermove", ["$event"])
  onBranchPointerMove(event: PointerEvent): void {
    const pressedBranch = this.pressedBranch;
    if (!pressedBranch) {
      return;
    }

    const distance = Math.hypot(
      event.clientX - this.branchDragStartX,
      event.clientY - this.branchDragStartY,
    );
    if (!this.draggingBranch() && distance < 6) {
      return;
    }

    if (!this.draggingBranch()) {
      this.draggingBranch.set(pressedBranch);
    }

    event.preventDefault();
    const targetBranch = this.localBranchAtPoint(event.clientX, event.clientY);
    this.dragOverBranch.set(targetBranch && targetBranch !== pressedBranch ? targetBranch : undefined);
  }

  @HostListener("document:pointerup", ["$event"])
  onBranchPointerUp(event: PointerEvent): void {
    const sourceBranch = this.draggingBranch();
    const targetBranch = this.dragOverBranch();

    if (sourceBranch && targetBranch) {
      this.openBranchOperationMenu(sourceBranch, targetBranch, event.clientX, event.clientY);
      this.suppressBranchClickUntil = Date.now() + 300;
    }

    this.finishBranchPointerDrag();
  }

  @HostListener("document:pointercancel")
  onBranchPointerCancel(): void {
    this.finishBranchPointerDrag();
  }

  finishBranchPointerDrag(): void {
    this.pressedBranch = undefined;
    this.draggingBranch.set(undefined);
    this.dragOverBranch.set(undefined);
  }

  private localBranchAtPoint(clientX: number, clientY: number): string | undefined {
    const element = document.elementFromPoint(clientX, clientY);
    const branchElement = element instanceof Element
      ? element.closest<HTMLElement>("[data-local-branch-index]")
      : null;
    const index = branchElement ? Number(branchElement.dataset["localBranchIndex"]) : -1;

    return Number.isInteger(index) && index >= 0
      ? this.references().localBranches[index]
      : undefined;
  }

  private openBranchOperationMenu(source: string, target: string, clientX: number, clientY: number): void {
    const menuWidth = 292;
    const menuHeight = 190;
    this.branchOperationMenu.set({
      source,
      target,
      x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8)),
    });
    this.ignoreNextDocumentClick = true;
    window.setTimeout(() => {
      this.ignoreNextDocumentClick = false;
    }, 300);
  }

  closeBranchOperationMenu(): void {
    this.branchOperationMenu.set(undefined);
  }

  chooseBranchOperation(kind: BranchOperationKind): void {
    const menu = this.branchOperationMenu();
    this.closeBranchOperationMenu();

    if (!menu || this.isBranchActionRunning()) {
      return;
    }

    const request = { kind, source: menu.source, target: menu.target };
    if (this.isDirty()) {
      this.pendingBranchOperation.set(request);
      return;
    }

    void this.executeBranchOperation(request);
  }

  cancelBranchOperation(): void {
    this.pendingBranchOperation.set(undefined);
  }

  async confirmBranchOperation(): Promise<void> {
    const request = this.pendingBranchOperation();
    this.pendingBranchOperation.set(undefined);

    if (request) {
      await this.executeBranchOperation(request);
    }
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
    if (this.ignoreNextDocumentClick) {
      this.ignoreNextDocumentClick = false;
      return;
    }

    this.closeBranchContextMenu();
    this.closeStashContextMenu();
    this.closeBranchOperationMenu();
  }

  @HostListener("document:keydown.escape")
  handleEscape(): void {
    this.closeBranchContextMenu();
    this.closeStashContextMenu();
    this.closeBranchOperationMenu();
    this.cancelBranchOperation();
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
      try {
        const syncCredentials = this.getSyncCredentials();
        await this.repositoryService.fetch(
          this.repository.path,
          syncCredentials.workspaceId,
          syncCredentials.githubUserId,
        );
      } catch {
        // A troca de branch local continua mesmo quando o remoto está indisponível.
      }

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

  private async executeBranchOperation(request: BranchOperationRequest): Promise<void> {
    this.isBranchActionRunning.set(true);

    try {
      if (request.kind === "merge") {
        await this.repositoryService.mergeBranch(
          this.repository.path,
          request.source,
          request.target,
        );
        this.toastService.success(
          `Merge de "${request.source}" em "${request.target}" concluído.`,
          "Merge concluído",
        );
      } else {
        await this.repositoryService.rebaseBranch(
          this.repository.path,
          request.source,
          request.target,
        );
        this.toastService.success(
          `Rebase de "${request.source}" sobre "${request.target}" concluído.`,
          "Rebase concluído",
        );
      }
    } catch (error: unknown) {
      this.toastService.error(
        this.getGitErrorMessage(error),
        request.kind === "merge" ? "Falha no Merge" : "Falha no Rebase",
      );
    } finally {
      try {
        await this.refreshRepositoryData();
      } catch {
        // A tela pode exibir o erro detalhado no próximo carregamento.
      }
      this.isBranchActionRunning.set(false);
    }
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
