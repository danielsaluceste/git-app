import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ConflictFile } from "../../../core/models/repository.model";
import { GitFile } from "../../../core/models/git-file.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { TranslatePipe } from "../../pipes/translate.pipe";

type ConflictSide = "ours" | "theirs";

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
  readonly isLoading = signal(true);
  readonly isSaving = signal(false);
  readonly error = signal("");
  readonly resultContent = signal("");
  readonly resultExists = signal(true);

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

    try {
      const conflicts = await this.repositoryService.getConflicts(this.repositoryPath);
      const conflict = conflicts.find((item) => item.path === this.file.path);
      if (!conflict) {
        throw new Error("Este conflito já foi resolvido ou o arquivo não está mais disponível.");
      }

      this.conflict.set(conflict);
      this.resultContent.set(conflict.result);
      this.resultExists.set(conflict.resultExists);
    } catch (error: unknown) {
      this.error.set(this.getErrorMessage(error));
    } finally {
      this.isLoading.set(false);
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

    this.isSaving.set(true);
    void this.repositoryService
      .resolveConflict(
        this.repositoryPath,
        this.file.path,
        this.resultContent(),
        this.resultExists(),
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
