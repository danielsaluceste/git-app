import {
  AfterViewInit,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  signal,
  untracked,
  ViewChild,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { fromEvent, filter } from "rxjs";
import { NavigationEnd, Router } from "@angular/router";
import { Commit } from "../../../core/models/commit.model";
import { CommitFile } from "../../../core/models/commit-file.model";
import { GitFile } from "../../../core/models/git-file.model";
import { Repository } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { md5 } from "../../../shared/utils/md5";
import { formatCommitDate, localDayKey } from "../../../shared/utils/commit-date";
import { CreateTagRequest } from "../../../core/models/tag.model";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { FileDiffDialogComponent } from "../../../shared/dialogs/file-diff-dialog/file-diff-dialog.component";
import { TagDialogComponent } from "../../../shared/dialogs/tag-dialog/tag-dialog.component";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";
import {
  CommitGraphResult,
  CommitGraphRow,
  computeCommitGraph,
} from "../utils/git-graph";

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

const GRAVATAR_HASH_CACHE = new Map<string, string>();

function gravatarUrl(hash: string): string {
  return `https://www.gravatar.com/avatar/${hash}?s=64&d=404`;
}

@Component({
  selector: "app-history-page",
  imports: [ConfirmDialogComponent, FileDiffDialogComponent, TagDialogComponent, TranslatePipe],
  templateUrl: "./history-page.component.html",
  styleUrl: "./history-page.component.css",
})
export class HistoryPageComponent implements AfterViewInit {
  private readonly historyPageSize = 100;
  /** Mesmo limite aplicado pelo backend em `get_repository_commits`. */
  private readonly historyMaxPageSize = 500;
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly commits = signal<Commit[]>([]);
  readonly isLoading = signal(true);
  readonly selectedCommit = signal<Commit | undefined>(undefined);
  readonly currentBranch = signal(this.translationService.translate("repository.headDetached"));
  readonly isHeadDetached = signal(true);
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
  readonly isCherryPicking = signal(false);
  readonly pendingCherryPickCommit = signal<Commit | undefined>(undefined);
  readonly pendingCherryPickNeedsStash = signal(false);
  readonly pendingRevertCommit = signal<Commit | undefined>(undefined);
  readonly isRevertingCommit = signal(false);
  readonly pendingTagCommit = signal<Commit | undefined>(undefined);
  readonly isCreatingTag = signal(false);
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
  /**
   * Data de referência para os rótulos "Hoje"/"Ontem". Fica num signal para que
   * o histórico se atualize sozinho quando o dia vira com o app aberto, sem
   * precisar fechar e abrir a janela.
   */
  private readonly referenceDate = signal(new Date());
  readonly commitDateLabels = computed<ReadonlyMap<string, string>>(() => {
    const reference = this.referenceDate();
    const language = this.translationService.language();
    const labels = {
      today: this.translationService.translate("history.today"),
      yesterday: this.translationService.translate("history.yesterday"),
    };
    const byDate = new Map<string, string>();

    for (const commit of this.commits()) {
      if (!byDate.has(commit.date)) {
        byDate.set(commit.date, formatCommitDate(commit.date, language, reference, labels));
      }
    }

    return byDate;
  });
  private historyOffset = 0;
  private overviewLoadVersion = 0;
  private lastLoadedRepoKey = "";
  private lastLoadedRefreshVersion = -1;

  private readonly activeRepositoryEffect = effect(() => {
    const repository = this.activeRepository();
    const refreshVersion = this.repositoryService.repositoryRefreshVersion();

    if (!repository) {
      this.isLoading.set(false);
      this.hasMoreCommits.set(false);
      this.commits.set([]);
      this.lastLoadedRepoKey = "";
      return;
    }

    if (!this.isCurrentRoute()) {
      return;
    }

    const repoKey = `${repository.workspaceId}:${repository.path.toLowerCase()}`;
    const isNewRepo = repoKey !== this.lastLoadedRepoKey;
    const isNewVersion = refreshVersion !== this.lastLoadedRefreshVersion;

    if (isNewRepo || isNewVersion || this.commits().length === 0) {
      this.lastLoadedRepoKey = repoKey;
      this.lastLoadedRefreshVersion = refreshVersion;
      untracked(() => void this.loadOverview(repository, isNewRepo));
    }
  });
  private readonly repositoryStatusEffect = effect(() => {
    const status = this.repositoryService.repositoryStatus();
    if (!status) {
      return;
    }

    untracked(() => {
      this.setCurrentBranch(status.currentBranch);
      this.aheadCount.set(status.aheadCount);
      this.behindCount.set(status.behindCount);
    });
  });
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
  readonly commitGraph = computed<CommitGraphResult>(() => {
    return computeCommitGraph(this.filteredCommits(), this.currentBranch());
  });

  constructor() {
    // Mantém "Hoje"/"Ontem" corretos mesmo com o app aberto durante a virada do
    // dia. O timer é barato e só troca o signal quando a data local muda.
    const dateWatcher = setInterval(() => this.syncReferenceDate(), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(dateWatcher));

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        if (!this.isCurrentRoute(event.urlAfterRedirects)) {
          return;
        }

        const repository = this.activeRepository();
        if (!repository) {
          return;
        }

        const repoKey = `${repository.workspaceId}:${repository.path.toLowerCase()}`;
        const refreshVersion = this.repositoryService.repositoryRefreshVersion();
        if (repoKey === this.lastLoadedRepoKey &&
            refreshVersion === this.lastLoadedRefreshVersion &&
            this.commits().length > 0) {
          return;
        }

        this.lastLoadedRepoKey = repoKey;
        this.lastLoadedRefreshVersion = refreshVersion;
        void this.loadOverview(repository);
      });
  }
  readonly graphRows = computed<CommitGraphRow[]>(() => {
    return this.commitGraph().rows;
  });
  readonly graphSvgWidth = computed<number>(() => {
    return this.commitGraph().svgWidth;
  });
  @ViewChild("historySearch") historySearch?: ElementRef<HTMLInputElement>;

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

  @HostListener("window:focus")
  onWindowFocus(): void {
    this.syncReferenceDate();
  }

  @HostListener("document:visibilitychange")
  onVisibilityChange(): void {
    if (document.visibilityState === "visible") {
      this.syncReferenceDate();
    }
  }

  /** Recalcula os rótulos relativos apenas quando a data local virou. */
  private syncReferenceDate(): void {
    const now = new Date();
    if (localDayKey(now) === localDayKey(this.referenceDate())) {
      return;
    }

    this.referenceDate.set(now);
  }

  /** Guarda o nome cru da branch e mantém o rótulo de HEAD destacado traduzido. */
  private setCurrentBranch(branch: string | null | undefined): void {
    const name = branch?.trim();
    this.isHeadDetached.set(!name);
    this.currentBranch.set(
      name || this.translationService.translate("repository.headDetached"),
    );
  }

  private isCurrentRoute(url = this.router.url): boolean {
    const path = url.split(/[?#]/, 1)[0];
    return path.endsWith("/overview") || path === "/overview";
  }

  async loadOverview(repository = this.activeRepository(), resetPagination = false): Promise<void> {
    if (!repository) {
      this.isLoading.set(false);
      this.hasMoreCommits.set(false);
      return;
    }

    const loadVersion = ++this.overviewLoadVersion;
    const allBranches = this.historyScope() === "all";
    // Preserva a profundidade já carregada: uma atualização automática não deve
    // encolher a lista de volta para a primeira página.
    const requestedLimit = Math.min(
      this.historyMaxPageSize,
      Math.max(this.historyPageSize, resetPagination ? 0 : this.commits().length),
    );
    const cachedCommits = this.repositoryService.getCachedCommits(repository.path, allBranches);
    const cachedReferences = this.repositoryService.getCachedReferences(repository.path);
    const cachedStatus = this.repositoryService.getCachedStatus(repository.path);
    const hasCachedData = !!cachedCommits && cachedCommits.length > 0;

    if (cachedCommits && (this.commits().length === 0 || resetPagination)) {
      this.commits.set(cachedCommits);
      this.historyOffset = cachedCommits.length;
      this.hasMoreCommits.set(cachedCommits.length === this.historyPageSize);
    }
    if (cachedReferences) {
      this.setCurrentBranch(cachedReferences.currentBranch);
    }
    if (cachedStatus) {
      this.aheadCount.set(cachedStatus.aheadCount);
      this.behindCount.set(cachedStatus.behindCount);
    }

    this.isLoading.set(!hasCachedData);
    try {
      const [commits, references, status] = await Promise.all([
        this.repositoryService.getCommits(
          repository.path,
          allBranches,
          0,
          requestedLimit,
        ),
        this.repositoryService.getReferences(repository.path),
        this.repositoryService.getStatus(repository.path),
      ]);
      if (loadVersion !== this.overviewLoadVersion || !this.isSameRepository(repository, this.activeRepository())) {
        return;
      }

      this.setCurrentBranch(references.currentBranch);
      this.aheadCount.set(status.aheadCount);
      this.behindCount.set(status.behindCount);

      const currentList = this.commits();
      // Compara a lista inteira, não só as pontas: commits que entram no meio
      // (fetch, rebase, amend) também precisam aparecer sem reiniciar o app.
      const isIdentical =
        currentList.length === commits.length &&
        currentList.length > 0 &&
        currentList.every((commit, index) => commit.hash === commits[index]?.hash);

      if (!isIdentical) {
        const commitsWithAvatars = this.enrichCommitAvatars(commits);
        if (loadVersion !== this.overviewLoadVersion || !this.isSameRepository(repository, this.activeRepository())) {
          return;
        }

        this.commits.set(commitsWithAvatars);
        this.historyOffset = commits.length;
        this.hasMoreCommits.set(commits.length === requestedLimit);

        if (this.selectedCommit() && !commitsWithAvatars.some((commit) => commit.hash === this.selectedCommit()?.hash)) {
          this.selectedCommit.set(undefined);
          this.selectedCommitFiles.set([]);
        }
      }
    } catch (error: unknown) {
      if (loadVersion !== this.overviewLoadVersion) {
        return;
      }

      this.hasMoreCommits.set(false);
      this.toastService.error(
        this.translationService.translate("history.overviewLoadError"),
        this.translationService.translate("history.title"),
      );
    } finally {
      if (loadVersion === this.overviewLoadVersion) {
        this.isLoading.set(false);
      }
    }
  }

  private isSameRepository(
    first: Repository | undefined,
    second: Repository | undefined,
  ): boolean {
    return !!first && !!second && first.workspaceId === second.workspaceId &&
      first.path.replaceAll("\\", "/").toLowerCase() === second.path.replaceAll("\\", "/").toLowerCase();
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
      this.toastService.error(
        this.getCommitCheckoutErrorMessage(error),
        this.translationService.translate("history.checkoutTitle"),
      );
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

  cherryPickFromContextMenu(): void {
    const commit = this.commitContextMenu()?.commit;
    this.closeCommitContextMenu();
    if (commit) {
      void this.requestCherryPick(commit);
    }
  }

  private async requestCherryPick(commit: Commit): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.isCherryPicking() || this.isCheckingOut() || this.syncAction()) {
      return;
    }

    try {
      const status = await this.repositoryService.getStatus(repository.path);
      this.pendingCherryPickNeedsStash.set(status.isDirty);
      this.pendingCherryPickCommit.set(commit);
    } catch (error: unknown) {
      this.toastService.error(
        this.getCommitCherryPickErrorMessage(error),
        this.translationService.translate("history.cherryPickTitle"),
      );
    }
  }

  cancelCherryPick(): void {
    this.pendingCherryPickCommit.set(undefined);
    this.pendingCherryPickNeedsStash.set(false);
  }

  async confirmCherryPick(): Promise<void> {
    const commit = this.pendingCherryPickCommit();
    const saveChanges = this.pendingCherryPickNeedsStash();
    this.cancelCherryPick();

    if (commit) {
      await this.executeCherryPick(commit, saveChanges);
    }
  }

  private async executeCherryPick(commit: Commit, saveChanges: boolean): Promise<void> {
    const repository = this.activeRepository();
    if (!repository || this.isCherryPicking()) {
      return;
    }

    this.isCherryPicking.set(true);
    try {
      if (saveChanges) {
        await this.repositoryService.stash(repository.path, `Antes do cherry-pick ${commit.shortHash}`);
      }

      await this.repositoryService.cherryPickCommit(repository.path, commit.hash);
      this.toastService.success(
        saveChanges
          ? this.translationService.translate("history.cherryPickWithStash", { hash: commit.shortHash })
          : this.translationService.translate("history.cherryPickSuccess", { hash: commit.shortHash }),
        this.translationService.translate("history.cherryPickSuccessTitle"),
      );
      await this.loadOverview();
    } catch (error: unknown) {
      const operation = await this.repositoryService.getOperation(repository.path).catch(() => null);
      if (operation?.kind === "cherry-pick") {
        this.toastService.warning(
          this.translationService.translate(
            saveChanges
              ? "history.cherryPickConflictWithStashMessage"
              : "history.cherryPickConflictMessage",
          ),
          this.translationService.translate("history.cherryPickConflictTitle"),
        );
        await this.router.navigate(["/changes"]);
        return;
      }

      this.toastService.error(
        this.getCommitCherryPickErrorMessage(error),
        this.translationService.translate("history.cherryPickTitle"),
      );
    } finally {
      this.isCherryPicking.set(false);
    }
  }

  createTagFromContextMenu(): void {
    const commit = this.commitContextMenu()?.commit;
    this.closeCommitContextMenu();
    if (commit) {
      this.pendingTagCommit.set(commit);
    }
  }

  cancelCreateTag(): void {
    this.pendingTagCommit.set(undefined);
  }

  async confirmCreateTag(request: CreateTagRequest): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.isCreatingTag.set(true);
    try {
      await this.repositoryService.createTag(repository.path, request);
      this.toastService.success(
        this.translationService.translate("tags.createSuccess", { name: request.name }),
        this.translationService.translate("tags.title"),
      );
      this.pendingTagCommit.set(undefined);
      await this.loadOverview();
    } catch (error: unknown) {
      this.toastService.error(this.getSyncErrorMessage(error), this.translationService.translate("tags.title"));
    } finally {
      this.isCreatingTag.set(false);
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
        this.translationService.translate("history.revertSuccess", { hash: commit.shortHash }),
        this.translationService.translate("history.revertSuccessTitle"),
      );
      await this.loadOverview();
    } catch (error: unknown) {
      this.toastService.error(this.getCommitRevertErrorMessage(error), this.translationService.translate("history.revertErrorTitle"));
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
      const commitsWithAvatars = this.enrichCommitAvatars(commits);
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
        this.translationService.translate("history.loadMoreError"),
        this.translationService.translate("history.historyTitle"),
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
    void this.loadOverview(undefined, true);
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
        return this.translationService.translate("history.onlyMerges");
      case "regular":
        return this.translationService.translate("history.noMerge");
      default:
        return this.translationService.translate("history.all");
    }
  }

  commitDateLabel(): string {
    switch (this.commitDateFilter()) {
      case "7d":
        return this.translationService.translate("history.last7");
      case "30d":
        return this.translationService.translate("history.last30");
      case "year":
        return this.translationService.translate("history.lastYear");
      default:
        return this.translationService.translate("history.anyPeriod");
    }
  }

  historyScopeLabel(): string {
    return this.historyScope() === "all"
      ? this.translationService.translate("history.allBranches")
      : (this.isHeadDetached()
        ? this.translationService.translate("history.currentBranch")
        : this.currentBranch());
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
        this.toastService.success(
          this.translationService.translate("history.fetchSuccess"),
          this.translationService.translate("history.fetchSuccessTitle"),
        );
      } else if (action === "pull") {
        const pullResult = await this.repositoryService.pull(
          repository.path,
          syncCredentials.workspaceId,
          syncCredentials.githubUserId,
        );
        this.toastService.success(
          pullResult.autoStashed
            ? this.translationService.translate("history.pullAutoStash")
            : this.translationService.translate("history.pullSuccess"),
          this.translationService.translate("history.pullSuccessTitle"),
        );
      } else {
        await this.repositoryService.push(
          repository.path,
          syncCredentials.workspaceId,
          syncCredentials.githubUserId,
        );
        this.toastService.success(
          this.translationService.translate("history.pushSuccess"),
          this.translationService.translate("history.pushSuccessTitle"),
        );
      }

      await this.loadOverview();
    } catch (error: unknown) {
      if (action === "pull") {
        const operation = await this.repositoryService.getOperation(repository.path).catch(() => null);

        if (operation) {
          const operationName = operation.kind === "rebase" ? "Rebase" : "Merge";
          this.toastService.warning(
            this.translationService.translate("history.pullConflictMessage", { operation: operationName }),
            this.translationService.translate("history.pullConflictTitle"),
          );
          await this.router.navigate(["/changes"]);
          return;
        }
      }

      this.toastService.error(this.getSyncErrorMessage(error, action), this.translationService.translate("history.syncTitle"));
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
          ? this.translationService.translate("history.checkoutWithStash", { hash: commit.shortHash })
          : this.translationService.translate("history.checkoutDetached", { hash: commit.shortHash }),
        this.translationService.translate("history.checkoutTitle"),
      );
      await this.loadOverview();
    } catch (error: unknown) {
      this.toastService.error(this.getCommitCheckoutErrorMessage(error), this.translationService.translate("history.checkoutTitle"));
    } finally {
      this.isCheckingOut.set(false);
    }
  }

  formatDate(date: string): string {
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
      return date;
    }

    return parsedDate.toLocaleString(this.translationService.language(), {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  private readonly avatarColorCache = new Map<string, string>();

  /**
   * Rótulos pré-calculados em `commitDateLabels`. Nada de cache por data do
   * commit: "Hoje" de ontem continuaria "Hoje" enquanto o app ficasse aberto.
   */
  formatCompactDate(date: string): string {
    return this.commitDateLabels().get(date) ?? date;
  }

  commitInitial(authorName: string): string {
    return authorName.trim().charAt(0).toUpperCase() || "?";
  }

  avatarColor(authorName: string): string {
    const cached = this.avatarColorCache.get(authorName);
    if (cached !== undefined) {
      return cached;
    }

    const colors = ["#ea580c", "#0891b2", "#7c3aed", "#059669", "#db2777", "#ca8a04", "#4f46e5"];
    let hash = 0;

    for (const character of authorName.trim().toLowerCase()) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }

    const color = colors[hash % colors.length];
    this.avatarColorCache.set(authorName, color);
    return color;
  }

  hideAvatar(event: Event): void {
    (event.currentTarget as HTMLImageElement).hidden = true;
  }

  syncLabel(action: Exclude<SyncAction, "">): string {
    if (this.syncAction() === action) {
      return action === "fetch"
        ? this.translationService.translate("history.fetching")
        : action === "pull"
          ? this.translationService.translate("history.downloading")
          : this.translationService.translate("history.sending");
    }

    return action === "fetch"
      ? this.translationService.translate("history.fetch")
      : action === "pull"
        ? this.translationService.translate("history.pull")
        : this.translationService.translate("history.push");
  }

  private getSyncErrorMessage(error: unknown, action: SyncAction = ""): string {
    const message = typeof error === "string"
      ? error.trim()
      : error instanceof Error
        ? error.message.trim()
        : "";

    if (this.isDivergedSyncError(message)) {
      if (action === "push") {
        return this.translationService.translate("history.pushDivergedError");
      }

      if (action === "pull") {
        return this.translationService.translate("history.pullDivergedError");
      }

      return this.translationService.translate("history.syncDivergedError");
    }

    return message
      ? this.translationService.translate("history.syncError", { message })
      : this.translationService.translate("history.syncGenericError");
  }

  private isDivergedSyncError(message: string): boolean {
    const normalized = message.toLocaleLowerCase();
    return normalized.includes("non-fast-forward")
      || normalized.includes("non fast-forward")
      || normalized.includes("tip of your current branch is behind")
      || normalized.includes("failed to push some refs")
      || normalized.includes("fetch first")
      || normalized.includes("diverging branches can't be fast-forwarded");
  }

  private enrichCommitAvatars(commits: Commit[]): Commit[] {
    return commits.map((commit) => {
      if (commit.avatarUrl) {
        return commit;
      }

      const email = commit.authorEmail.trim().toLowerCase();
      if (!email) {
        return commit;
      }

      const cached = GRAVATAR_HASH_CACHE.get(email);
      if (cached) {
        return { ...commit, avatarUrl: gravatarUrl(cached) };
      }

      // O Gravatar exige o hash MD5 do e-mail em minúsculas. Um hash diferente
      // fazia cada linha do histórico disparar uma requisição que sempre
      // falhava com 404.
      const hash = md5(email);
      GRAVATAR_HASH_CACHE.set(email, hash);

      return { ...commit, avatarUrl: gravatarUrl(hash) };
    });
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
      return this.translationService.translate("history.checkoutError", { message: error.trim() });
    }

    if (error instanceof Error && error.message) {
      return this.translationService.translate("history.checkoutError", { message: error.message });
    }

    return this.translationService.translate("history.checkoutGenericError");
  }

  private getCommitRevertErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return this.translationService.translate("history.revertError", { message: error.trim() });
    }

    if (error instanceof Error && error.message) {
      return this.translationService.translate("history.revertError", { message: error.message });
    }

    return this.translationService.translate("history.revertGenericError");
  }

  private getCommitCherryPickErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return this.translationService.translate("history.cherryPickError", { message: error.trim() });
    }

    if (error instanceof Error && error.message) {
      return this.translationService.translate("history.cherryPickError", { message: error.message });
    }

    return this.translationService.translate("history.cherryPickGenericError");
  }

  private getCommitFilesErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return this.translationService.translate("history.filesError");
  }
}
