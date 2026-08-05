import {
  AfterViewInit,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  OnInit,
  signal,
  ViewChild,
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
type CommitKindFilter = "all" | "merge" | "regular";
type CommitDateFilter = "all" | "7d" | "30d" | "year";
type HistoryScope = "current" | "all";
type HistoryFilterMenu = "author" | "kind" | "date" | "scope" | null;

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
  private readonly historyPageSize = 100;
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
  readonly pendingRevertCommit = signal<Commit | undefined>(undefined);
  readonly isRevertingCommit = signal(false);
  readonly commitContextMenu = signal<CommitContextMenu | undefined>(undefined);
  readonly historyQuery = signal("");
  readonly authorFilter = signal("");
  readonly commitKindFilter = signal<CommitKindFilter>("all");
  readonly commitDateFilter = signal<CommitDateFilter>("all");
  readonly historyScope = signal<HistoryScope>("all");
  readonly isLoadingMore = signal(false);
  readonly hasMoreCommits = signal(false);
  readonly openFilterMenu = signal<HistoryFilterMenu>(null);
  readonly showHistoryFilters = signal(false);
  readonly authors = computed(() =>
    [...new Set(this.commits().map((commit) => commit.authorName.trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR"),
    ),
  );
  private historyOffset = 0;
  readonly filteredCommits = computed(() => {
    const query = this.historyQuery().trim().toLocaleLowerCase("pt-BR");
    const author = this.authorFilter();
    const kind = this.commitKindFilter();
    const dateFilter = this.commitDateFilter();
    const cutoff = dateFilter === "all"
      ? undefined
      : Date.now() - ({ "7d": 7, "30d": 30, year: 365 }[dateFilter] * 24 * 60 * 60 * 1000);

    return this.commits().filter((commit) => {
      if (author && commit.authorName !== author) {
        return false;
      }
      if (kind === "merge" && commit.parents.length < 2) {
        return false;
      }
      if (kind === "regular" && commit.parents.length >= 2) {
        return false;
      }
      if (cutoff !== undefined && new Date(commit.date).getTime() < cutoff) {
        return false;
      }
      if (!query) {
        return true;
      }

      return [commit.subject, commit.authorName, commit.authorEmail, commit.hash]
        .some((value) => value.toLocaleLowerCase("pt-BR").includes(query));
    });
  });
  @ViewChild("historySearch") historySearch?: ElementRef<HTMLInputElement>;

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
      this.hasMoreCommits.set(false);
      return;
    }

    this.isLoading.set(true);
    try {
      const [commits, references, status] = await Promise.all([
        this.repositoryService.getCommits(
          repository.path,
          this.historyScope() === "all",
          0,
          this.historyPageSize,
        ),
        this.repositoryService.getReferences(repository.path),
        this.repositoryService.getStatus(repository.path),
      ]);
      const commitsWithAvatars = await this.enrichCommitAvatars(commits);
      this.commits.set(commitsWithAvatars);
      this.historyOffset = commits.length;
      this.hasMoreCommits.set(commits.length === this.historyPageSize);
      this.currentBranch.set(references.currentBranch || "HEAD destacado");
      this.aheadCount.set(status.aheadCount);
      this.behindCount.set(status.behindCount);
      if (this.selectedCommit() && !commitsWithAvatars.some((commit) => commit.hash === this.selectedCommit()?.hash)) {
        this.selectedCommit.set(undefined);
        this.selectedCommitFiles.set([]);
      }
    } catch (error: unknown) {
      this.hasMoreCommits.set(false);
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

  closeCommitDetails(): void {
    this.selectedCommit.set(undefined);
    this.selectedCommitFiles.set([]);
    this.closeCommitFile();
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
    this.openFilterMenu.set(null);
  }

  @HostListener("document:keydown.escape")
  onEscapeKeydown(): void {
    this.closeCommitContextMenu();
  }

  @HostListener("window:keydown", ["$event"])
  onKeyboardShortcut(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const isTyping = target?.tagName === "INPUT"
      || target?.tagName === "TEXTAREA"
      || target?.tagName === "SELECT"
      || target?.isContentEditable;
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.openHistorySearch();
      return;
    }

    if (event.key === "/" && !isTyping) {
      event.preventDefault();
      this.openHistorySearch();
      return;
    }

    if (event.key === "Escape") {
      if (this.openFilterMenu()) {
        this.openFilterMenu.set(null);
        return;
      }
      if (this.commitContextMenu()) {
        this.closeCommitContextMenu();
      }
      if (this.hasHistoryFilters()) {
        this.clearHistoryFilters();
      }
      return;
    }

    if (this.openFilterMenu() && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      this.focusAdjacentFilterOption(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (isTyping || this.isLoading() || this.isCheckingOut() || this.syncAction()) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.selectAdjacentVisibleCommit(event.key === "ArrowDown" ? 1 : -1);
    }
  }

  revertFromContextMenu(): void {
    const commit = this.commitContextMenu()?.commit;
    this.closeCommitContextMenu();
    if (commit) {
      this.pendingRevertCommit.set(commit);
    }
  }

  cancelRevertCommit(): void {
    this.pendingRevertCommit.set(undefined);
  }

  async confirmRevertCommit(): Promise<void> {
    const commit = this.pendingRevertCommit();
    this.pendingRevertCommit.set(undefined);
    const repository = this.activeRepository();
    if (!repository || !commit || this.isRevertingCommit()) {
      return;
    }

    this.isRevertingCommit.set(true);
    try {
      await this.repositoryService.revertCommit(repository.path, commit.hash);
      this.toastService.success(
        `Commit ${commit.shortHash} desfeito com sucesso.`,
        "Revert concluído",
      );
      await this.loadOverview();
    } catch (error: unknown) {
      this.toastService.error(this.getCommitRevertErrorMessage(error), "Desfazer commit");
    } finally {
      this.isRevertingCommit.set(false);
    }
  }

  async loadMoreCommits(): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.isLoading() || this.isLoadingMore() || !this.hasMoreCommits()) {
      return;
    }

    this.isLoadingMore.set(true);
    try {
      const commits = await this.repositoryService.getCommits(
        repository.path,
        this.historyScope() === "all",
        this.historyOffset,
        this.historyPageSize,
      );
      const commitsWithAvatars = await this.enrichCommitAvatars(commits);
      this.commits.update((currentCommits) => {
        const knownHashes = new Set(currentCommits.map((commit) => commit.hash));
        return [
          ...currentCommits,
          ...commitsWithAvatars.filter((commit) => !knownHashes.has(commit.hash)),
        ];
      });
      this.historyOffset += commits.length;
      this.hasMoreCommits.set(commits.length === this.historyPageSize);
    } catch (error: unknown) {
      this.toastService.error(
        "NÃ£o foi possÃ­vel carregar mais commits deste repositÃ³rio.",
        "HistÃ³rico",
      );
    } finally {
      this.isLoadingMore.set(false);
    }
  }

  setHistoryQuery(event: Event): void {
    this.historyQuery.set((event.target as HTMLInputElement).value);
  }

  setAuthorFilter(event: Event): void {
    this.authorFilter.set((event.target as HTMLSelectElement).value);
  }

  setCommitKindFilter(event: Event): void {
    this.commitKindFilter.set((event.target as HTMLSelectElement).value as CommitKindFilter);
  }

  setCommitDateFilter(event: Event): void {
    this.commitDateFilter.set((event.target as HTMLSelectElement).value as CommitDateFilter);
  }

  toggleFilterMenu(menu: Exclude<HistoryFilterMenu, null>, event: MouseEvent): void {
    event.stopPropagation();
    this.openFilterMenu.set(this.openFilterMenu() === menu ? null : menu);
  }

  isFilterMenuOpen(menu: Exclude<HistoryFilterMenu, null>): boolean {
    return this.openFilterMenu() === menu;
  }

  selectAuthorFilter(value: string, event: MouseEvent): void {
    event.stopPropagation();
    this.authorFilter.set(value);
    this.openFilterMenu.set(null);
  }

  selectHistoryScope(value: HistoryScope, event: MouseEvent): void {
    event.stopPropagation();
    this.openFilterMenu.set(null);
    if (this.historyScope() === value) {
      return;
    }

    this.historyScope.set(value);
    this.closeCommitDetails();
    void this.loadOverview();
  }

  selectCommitKindFilter(value: CommitKindFilter, event: MouseEvent): void {
    event.stopPropagation();
    this.commitKindFilter.set(value);
    this.openFilterMenu.set(null);
  }

  selectCommitDateFilter(value: CommitDateFilter, event: MouseEvent): void {
    event.stopPropagation();
    this.commitDateFilter.set(value);
    this.openFilterMenu.set(null);
  }

  commitKindLabel(): string {
    switch (this.commitKindFilter()) {
      case "merge":
        return "Somente merges";
      case "regular":
        return "Sem merge";
      default:
        return "Todos";
    }
  }

  commitDateLabel(): string {
    switch (this.commitDateFilter()) {
      case "7d":
        return "Últimos 7 dias";
      case "30d":
        return "Últimos 30 dias";
      case "year":
        return "Último ano";
      default:
        return "Qualquer período";
    }
  }

  historyScopeLabel(): string {
    return this.historyScope() === "all"
      ? "Todas as branches"
      : (this.currentBranch() === "HEAD destacado" ? "Branch atual" : this.currentBranch());
  }

  formatReference(reference: string): string {
    return reference.replace(/^HEAD\s*->\s*/, "");
  }

  hasHistoryFilters(): boolean {
    return Boolean(
      this.historyQuery().trim()
      || this.authorFilter()
      || this.commitKindFilter() !== "all"
      || this.commitDateFilter() !== "all",
    );
  }

  clearHistoryFilters(): void {
    this.historyQuery.set("");
    this.authorFilter.set("");
    this.commitKindFilter.set("all");
    this.commitDateFilter.set("all");
  }

  focusHistorySearch(): void {
    queueMicrotask(() => this.historySearch?.nativeElement.focus());
  }

  toggleHistoryFilters(): void {
    const shouldShow = !this.showHistoryFilters();
    this.showHistoryFilters.set(shouldShow);
    this.openFilterMenu.set(null);
    if (shouldShow) {
      this.focusHistorySearch();
    }
  }

  private openHistorySearch(): void {
    this.showHistoryFilters.set(true);
    this.openFilterMenu.set(null);
    this.focusHistorySearch();
  }

  private selectAdjacentVisibleCommit(direction: 1 | -1): void {
    const visibleCommits = this.filteredCommits();
    if (visibleCommits.length === 0) {
      return;
    }

    const selectedHash = this.selectedCommit()?.hash;
    const currentIndex = visibleCommits.findIndex((commit) => commit.hash === selectedHash);
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : visibleCommits.length - 1
      : Math.max(0, Math.min(visibleCommits.length - 1, currentIndex + direction));

    this.selectCommit(visibleCommits[nextIndex]);
  }

  private focusAdjacentFilterOption(direction: 1 | -1): void {
    const menu = this.openFilterMenu();
    if (!menu) {
      return;
    }

    const options = Array.from(
      (this.elementRef.nativeElement as HTMLElement).querySelectorAll(
        `[data-filter-menu="${menu}"]`,
      ),
    ) as HTMLButtonElement[];
    if (options.length === 0) {
      return;
    }

    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : options.length - 1
      : Math.max(0, Math.min(options.length - 1, currentIndex + direction));
    options[nextIndex]?.focus();
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
    const menuHeight = 150;

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
      case "conflicted":
        return "!";
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

  formatCompactDate(date: string): string {
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
      return date;
    }

    const now = new Date();
    const isToday = parsedDate.getFullYear() === now.getFullYear()
      && parsedDate.getMonth() === now.getMonth()
      && parsedDate.getDate() === now.getDate();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = parsedDate.getFullYear() === yesterday.getFullYear()
      && parsedDate.getMonth() === yesterday.getMonth()
      && parsedDate.getDate() === yesterday.getDate();

    if (isToday) {
      return `Hoje, ${parsedDate.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    }

    if (isYesterday) {
      return `Ontem, ${parsedDate.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    }

    return parsedDate.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  commitInitial(authorName: string): string {
    return authorName.trim().charAt(0).toUpperCase() || "?";
  }

  avatarColor(authorName: string): string {
    const colors = ["#ea580c", "#0891b2", "#7c3aed", "#059669", "#db2777", "#ca8a04", "#4f46e5"];
    let hash = 0;

    for (const character of authorName.trim().toLowerCase()) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }

    return colors[hash % colors.length];
  }

  hideAvatar(event: Event): void {
    (event.currentTarget as HTMLImageElement).hidden = true;
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

  private async enrichCommitAvatars(commits: Commit[]): Promise<Commit[]> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      return commits;
    }

    const hashes = new Map<string, string>();

    return Promise.all(
      commits.map(async (commit) => {
        const email = commit.authorEmail.trim().toLowerCase();
        if (!email) {
          return commit;
        }

        try {
          let hash = hashes.get(email);
          if (!hash) {
            const digest = await subtle.digest("SHA-256", new TextEncoder().encode(email));
            hash = Array.from(new Uint8Array(digest))
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            hashes.set(email, hash);
          }

          return {
            ...commit,
            avatarUrl: `https://www.gravatar.com/avatar/${hash}?s=64&d=404`,
          };
        } catch {
          return commit;
        }
      }),
    );
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

  private getCommitRevertErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return `Não foi possível desfazer este commit: ${error.trim()}`;
    }

    if (error instanceof Error && error.message) {
      return `Não foi possível desfazer este commit: ${error.message}`;
    }

    return "Não foi possível desfazer este commit.";
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
