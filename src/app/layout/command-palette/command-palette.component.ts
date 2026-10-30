import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  signal,
} from "@angular/core";
import { Router } from "@angular/router";
import { Repository } from "../../core/models/repository.model";
import { UndoCandidate } from "../../core/models/undo.model";
import { RepositoryService } from "../../core/services/repository.service";
import { SessionService } from "../../core/services/session.service";
import { ToastService } from "../../core/services/toast.service";
import { TranslationService } from "../../core/services/translation.service";
import { ConfirmDialogComponent } from "../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { TranslatePipe } from "../../shared/pipes/translate.pipe";
import { filterPaletteItems } from "./palette-filter";

type PaletteGroup = "actions" | "navigation" | "repositories" | "branches";

interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  hint: string;
  symbol: string;
  run: () => void;
}

const MAX_RESULTS = 14;

@Component({
  selector: "app-command-palette",
  imports: [ConfirmDialogComponent, TranslatePipe],
  templateUrl: "./command-palette.component.html",
  styleUrl: "./command-palette.component.css",
})
export class CommandPaletteComponent {
  private readonly router = inject(Router);
  private readonly repositoryService = inject(RepositoryService);
  private readonly sessionService = inject(SessionService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);
  @ViewChild("search") searchInput?: ElementRef<HTMLInputElement>;

  readonly isOpen = signal(false);
  readonly query = signal("");
  readonly activeIndex = signal(0);
  readonly undoCandidate = signal<UndoCandidate | undefined>(undefined);
  readonly pendingUndo = signal(false);
  readonly isUndoing = signal(false);

  readonly items = computed<PaletteItem[]>(() => {
    const translate = (key: string, params?: Record<string, string>): string =>
      this.translationService.translate(key, params);
    const repository = this.repositoryService.activeRepository();
    const repositories = this.repositoryService.openRepositories();
    const references = this.repositoryService.repositoryReferences();
    const items: PaletteItem[] = [
      this.navigationItem("repositories", "nav.repositories", "▣", "/repositories"),
      this.navigationItem("changes", "changes.title", "±", "/changes"),
      this.navigationItem("overview", "history.title", "◎", "/overview"),
      this.navigationItem("branches", "repository.branches", "⑂", "/branches"),
      this.navigationItem("stashes", "stashes.title", "▤", "/stashes"),
      this.navigationItem("terminal", "terminal.title", ">_", "/terminal"),
      this.navigationItem("integrations", "nav.integrations", "⇄", "/integrations"),
      this.navigationItem("settings", "nav.settings", "⚙", "/settings"),
    ];

    for (const item of repositories) {
      items.push({
        id: `repo:${item.workspaceId}:${item.path}`,
        group: "repositories",
        label: item.name || item.path,
        hint: item.path,
        symbol: "▣",
        run: () => this.openRepository(item),
      });
    }

    if (repository && references) {
      for (const branch of references.localBranches) {
        items.push({
          id: `branch:${branch}`,
          group: "branches",
          label: branch,
          hint:
            references.currentBranch === branch
              ? translate("palette.currentBranch")
              : translate("palette.checkoutBranch"),
          symbol: "⑂",
          run: () => void this.checkoutBranch(repository, branch),
        });
      }
    }

    const undo = this.undoCandidate();
    if (undo) {
      items.push({
        id: "action:undo",
        group: "actions",
        label: translate("palette.undoCommit"),
        hint: `${undo.currentHash.slice(0, 7)} · ${undo.subject}`,
        symbol: "↶",
        run: () => this.pendingUndo.set(true),
      });
    }

    return items;
  });

  readonly filtered = computed<PaletteItem[]>(() =>
    filterPaletteItems(this.items(), this.query(), MAX_RESULTS),
  );

  @HostListener("window:keydown", ["$event"])
  onKeydown(event: KeyboardEvent): void {
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.toggle();
      return;
    }

    if (!this.isOpen()) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.move(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.move(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      this.run(this.filtered()[this.activeIndex()]);
    }
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
      return;
    }

    this.open();
  }

  open(): void {
    this.query.set("");
    this.activeIndex.set(0);
    this.undoCandidate.set(undefined);
    this.isOpen.set(true);
    // Deixa o Angular renderizar o diálogo antes de focar o campo.
    setTimeout(() => this.searchInput?.nativeElement.focus(), 0);
    void this.loadUndoCandidate();
  }

  close(): void {
    this.isOpen.set(false);
  }

  setQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.activeIndex.set(0);
  }

  run(item: PaletteItem | undefined): void {
    if (!item) {
      return;
    }

    this.close();
    item.run();
  }

  groupLabel(group: PaletteGroup): string {
    switch (group) {
      case "actions":
        return this.translationService.translate("palette.actions");
      case "navigation":
        return this.translationService.translate("palette.navigation");
      case "repositories":
        return this.translationService.translate("palette.repositories");
      case "branches":
        return this.translationService.translate("palette.branches");
    }
  }

  private navigationItem(
    id: string,
    labelKey: string,
    symbol: string,
    url: string,
  ): PaletteItem {
    return {
      id: `nav:${id}`,
      group: "navigation",
      label: this.translationService.translate(labelKey),
      hint: url,
      symbol,
      run: () => void this.router.navigateByUrl(url),
    };
  }

  private move(direction: 1 | -1): void {
    const total = this.filtered().length;
    if (total === 0) {
      return;
    }

    this.activeIndex.set(
      (this.activeIndex() + direction + total) % total,
    );
  }

  private openRepository(repository: Repository): void {
    this.repositoryService.setActive(repository);
    void this.router.navigateByUrl(this.sessionService.routeFor(repository) ?? "/overview");
    void this.repositoryService.refreshAfterRepositoryOpened(repository).catch(() => undefined);
  }

  cancelUndo(): void {
    this.pendingUndo.set(false);
  }

  async confirmUndo(): Promise<void> {
    const candidate = this.undoCandidate();
    const repository = this.repositoryService.activeRepository();
    this.pendingUndo.set(false);

    if (!candidate || !repository || this.isUndoing()) {
      return;
    }

    this.isUndoing.set(true);
    try {
      await this.repositoryService.undoLastOperation(
        repository.path,
        candidate.currentHash,
        candidate.previousHash,
      );
      this.toastService.success(
        this.translationService.translate("palette.undoSuccess"),
        this.translationService.translate("palette.title"),
      );
      this.undoCandidate.set(undefined);
      await this.repositoryService.refreshLocalState(repository);
    } catch (error: unknown) {
      this.toastService.error(
        this.getUndoErrorMessage(error),
        this.translationService.translate("palette.title"),
      );
    } finally {
      this.isUndoing.set(false);
    }
  }

  private async loadUndoCandidate(): Promise<void> {
    const repository = this.repositoryService.activeRepository();
    if (!repository) {
      this.undoCandidate.set(undefined);
      return;
    }

    try {
      const candidate = await this.repositoryService.getUndoCandidate(repository.path);
      this.undoCandidate.set(candidate ?? undefined);
    } catch {
      this.undoCandidate.set(undefined);
    }
  }

  private getUndoErrorMessage(error: unknown): string {
    const message = typeof error === "string" ? error.trim() : "";

    return message
      ? this.translationService.translate("palette.undoError", { message })
      : this.translationService.translate("palette.undoGenericError");
  }

  private async checkoutBranch(repository: Repository, branch: string): Promise<void> {
    try {
      await this.repositoryService.checkoutBranch(repository.path, branch);
      await this.repositoryService.refreshLocalState(repository);
      this.toastService.success(
        this.translationService.translate("palette.branchSwitched", { branch }),
        this.translationService.translate("branches.checkoutTitle", { branch }),
      );
    } catch (error: unknown) {
      this.toastService.error(
        typeof error === "string" && error.trim()
          ? error.trim()
          : this.translationService.translate("palette.error"),
        this.translationService.translate("palette.title"),
      );
    }
  }
}
