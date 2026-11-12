import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  computed,
  inject,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ConflictFile, RepositoryOperation } from "../../../core/models/repository.model";
import { GitFile } from "../../../core/models/git-file.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { TranslatePipe } from "../../pipes/translate.pipe";
import {
  buildConflictContent,
  ConflictChoice,
  ConflictDocument,
  ConflictHunk,
  ConflictResolution,
  parseConflictMarkers,
  resolutionLines,
} from "../../utils/conflict-hunks";

type ConflictSide = "ours" | "theirs";

interface HunkState extends ConflictHunk {
  choice?: ConflictChoice;
  custom: string;
  editing: boolean;
  showBase: boolean;
}

@Component({
  selector: "app-conflict-resolver",
  imports: [FormsModule, TranslatePipe],
  templateUrl: "./conflict-resolver.component.html",
  styleUrl: "./conflict-resolver.component.css",
})
export class ConflictResolverComponent implements AfterViewInit, OnChanges {
  private readonly repositoryService = inject(RepositoryService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;

  @Input() repositoryPath = "";
  @Input() file!: GitFile;

  @Output() closed = new EventEmitter<void>();
  @Output() resolved = new EventEmitter<void>();

  readonly conflict = signal<ConflictFile | undefined>(undefined);
  readonly operation = signal<RepositoryOperation | undefined>(undefined);
  readonly document = signal<ConflictDocument | undefined>(undefined);
  readonly hunks = signal<HunkState[]>([]);
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly error = signal("");
  readonly resultContent = signal("");
  readonly resultExists = signal(true);

  readonly unresolvedHunks = computed(
    () => this.hunks().filter((hunk) => !hunk.choice).length,
  );

  readonly assembledContent = computed(() => {
    const document = this.document();

    if (!document) {
      return undefined;
    }

    const resolutions: Record<number, ConflictResolution> = {};

    for (const hunk of this.hunks()) {
      resolutions[hunk.id] = {
        choice: hunk.choice,
        custom: hunk.custom,
      };
    }

    return buildConflictContent(document, resolutions);
  });

  ngAfterViewInit(): void {
    this.dialog.nativeElement.showModal();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes["file"] || changes["repositoryPath"]) && this.file?.path && this.repositoryPath) {
      void this.loadConflict();
    }
  }

  async loadConflict(): Promise<void> {
    this.isLoading.set(true);
    this.error.set("");
    this.conflict.set(undefined);
    this.operation.set(undefined);
    this.document.set(undefined);
    this.hunks.set([]);
    this.resultContent.set("");
    this.resultExists.set(true);

    try {
      const [conflicts, operation] = await Promise.all([
        this.repositoryService.getConflicts(this.repositoryPath),
        this.repositoryService
          .getOperation(this.repositoryPath)
          .catch(() => null),
      ]);
      const conflict = conflicts.find((item) => item.path === this.file.path);
      if (!conflict) {
        throw new Error("Este conflito já foi resolvido ou o arquivo não está mais disponível.");
      }

      this.operation.set(operation ?? undefined);
      this.conflict.set(conflict);
      this.resultContent.set(conflict.result);
      this.resultExists.set(conflict.resultExists);

      const document = conflict.isBinary
        ? undefined
        : parseConflictMarkers(conflict.result);
      this.document.set(document);
      this.hunks.set(
        document
          ? document.hunks.map((hunk) => ({
              ...hunk,
              choice: undefined,
              custom: "",
              editing: false,
              showBase: false,
            }))
          : [],
      );
    } catch (error: unknown) {
      this.error.set(this.getErrorMessage(error));
    } finally {
      this.isLoading.set(false);
    }
  }

  oursVersionKicker(): string {
    return this.translationService.translate(
      this.operation()?.kind === "rebase" ? "conflict.baseVersion" : "conflict.yourVersion",
    );
  }

  theirsVersionKicker(): string {
    return this.translationService.translate(
      this.operation()?.kind === "rebase" ? "conflict.yourBranchVersion" : "conflict.receivedVersion",
    );
  }

  oursVersionLabel(): string {
    const operation = this.operation();

    return (
      operation?.targetBranch ??
      operation?.currentBranch ??
      this.translationService.translate("conflict.currentBranch")
    );
  }

  theirsVersionLabel(): string {
    const operation = this.operation();

    if (operation?.kind === "cherry-pick" && operation.sourceCommit) {
      return operation.sourceSubject
        ? `${operation.sourceCommit} · ${operation.sourceSubject}`
        : operation.sourceCommit;
    }

    return (
      operation?.sourceBranch ??
      this.translationService.translate("conflict.otherBranch")
    );
  }

  useAll(choice: "ours" | "theirs"): void {
    if (this.hunks().length === 0) {
      return;
    }

    this.hunks.update((hunks) =>
      hunks.map((hunk) => ({ ...hunk, choice, editing: false })),
    );
  }

  chooseHunk(hunkId: number, choice: Exclude<ConflictChoice, "custom">): void {
    this.updateHunk(hunkId, { choice, editing: false });
  }

  chooseBase(hunkId: number): void {
    const hunk = this.hunks().find((item) => item.id === hunkId);

    if (!hunk || hunk.base.length === 0) {
      return;
    }

    this.updateHunk(hunkId, {
      choice: "custom",
      custom: hunk.base.join("\n"),
      editing: false,
    });
  }

  toggleHunkBase(hunkId: number): void {
    const hunk = this.hunks().find((item) => item.id === hunkId);

    if (hunk) {
      this.updateHunk(hunkId, { showBase: !hunk.showBase });
    }
  }

  editHunk(hunkId: number): void {
    const hunk = this.hunks().find((item) => item.id === hunkId);

    if (!hunk) {
      return;
    }

    if (hunk.editing) {
      this.updateHunk(hunkId, { editing: false });
      return;
    }

    this.updateHunk(hunkId, {
      choice: "custom",
      custom: hunk.choice ? this.hunkContent(hunk) : hunk.ours.join("\n"),
      editing: true,
    });
  }

  updateHunkCustom(hunkId: number, event: Event): void {
    this.updateHunk(hunkId, {
      choice: "custom",
      custom: (event.target as HTMLTextAreaElement).value,
    });
  }

  hunkDisplay(lines: string[]): string {
    return lines.length > 0
      ? lines.join("\n")
      : this.translationService.translate("conflict.deletedVersion");
  }

  hunkResult(hunk: HunkState): string {
    return this.hunkContent(hunk) || this.translationService.translate("conflict.emptyPart");
  }

  hunkContent(hunk: HunkState): string {
    const lines = resolutionLines(hunk, {
      choice: hunk.choice,
      custom: hunk.custom,
    });

    return (lines ?? []).join("\n");
  }

  hunkChoiceLabel(hunk: HunkState): string {
    switch (hunk.choice) {
      case "ours":
        return this.translationService.translate("conflict.choiceOurs");
      case "theirs":
        return this.translationService.translate("conflict.choiceTheirs");
      case "both":
        return this.translationService.translate("conflict.choiceBoth");
      case "custom":
        return this.translationService.translate("conflict.choiceCustom");
      default:
        return this.translationService.translate("conflict.chooseHunk");
    }
  }

  useSide(side: ConflictSide): void {
    const conflict = this.conflict();
    if (!conflict) {
      return;
    }

    if (conflict.isBinary) {
      void this.resolveBinarySide(side);
      return;
    }

    const content = side === "ours" ? conflict.ours : conflict.theirs;
    const exists = side === "ours" ? conflict.oursExists : conflict.theirsExists;
    this.resultContent.set(content);
    this.resultExists.set(exists);
  }

  useBase(): void {
    const conflict = this.conflict();
    if (!conflict || conflict.isBinary || !conflict.baseExists) {
      return;
    }

    this.resultContent.set(conflict.base);
    this.resultExists.set(true);
  }

  markAsResolved(): void {
    if (this.isSaving() || this.conflict()?.isBinary) {
      return;
    }

    const document = this.document();
    const content = document ? this.assembledContent() : this.resultContent();
    const keepFile = document ? true : this.resultExists();

    if (document && content === undefined) {
      this.toastService.warning(
        this.translationService.translate("conflict.chooseAllParts"),
        this.translationService.translate("conflict.title"),
      );
      return;
    }

    this.isSaving.set(true);
    void this.repositoryService
      .resolveConflict(
        this.repositoryPath,
        this.file.path,
        content ?? "",
        keepFile,
      )
      .then(() => {
        this.toastService.success(
          this.translationService.translate("conflict.resolvedMessage", { path: this.file.path }),
          this.translationService.translate("conflict.resolvedTitle"),
        );
        this.resolved.emit();
        this.closed.emit();
      })
      .catch((error: unknown) => {
        this.toastService.error(this.getErrorMessage(error), this.translationService.translate("conflict.resolveErrorTitle"));
      })
      .finally(() => this.isSaving.set(false));
  }

  displayContent(content: string, exists: boolean): string {
    if (!exists) {
      return this.translationService.translate("conflict.deletedVersion");
    }

    return content || this.translationService.translate("conflict.emptyFile");
  }

  sideLabel(side: ConflictSide, exists: boolean): string {
    if (!exists) {
      return this.translationService.translate("conflict.keepDeletion");
    }

    return this.translationService.translate(side === "ours" ? "conflict.useYourVersion" : "conflict.useReceivedVersion");
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closed.emit();
    }
  }

  private updateHunk(hunkId: number, patch: Partial<HunkState>): void {
    this.hunks.update((hunks) =>
      hunks.map((hunk) => (hunk.id === hunkId ? { ...hunk, ...patch } : hunk)),
    );
  }

  private async resolveBinarySide(side: ConflictSide): Promise<void> {
    this.isSaving.set(true);
    try {
      await this.repositoryService.resolveConflictSide(this.repositoryPath, this.file.path, side);
      this.toastService.success(
        this.translationService.translate("conflict.resolvedMessage", { path: this.file.path }),
        this.translationService.translate("conflict.resolvedTitle"),
      );
      this.resolved.emit();
      this.closed.emit();
    } catch (error: unknown) {
      this.toastService.error(this.getErrorMessage(error), this.translationService.translate("conflict.resolveErrorTitle"));
    } finally {
      this.isSaving.set(false);
    }
  }

  private getErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return this.translationService.translate("conflict.loadError");
  }
}
