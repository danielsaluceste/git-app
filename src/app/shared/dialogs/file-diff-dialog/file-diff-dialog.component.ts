import { AfterViewInit, Component, ElementRef, EventEmitter, inject, Input, Output, QueryList, ViewChild, ViewChildren } from "@angular/core";
import { DomSanitizer, SafeUrl } from "@angular/platform-browser";
import { GitFile, GitFileStatus } from "../../../core/models/git-file.model";
import { TranslationService } from "../../../core/services/translation.service";
import { DiffSegments, splitDiffHunks } from "../../utils/diff-hunks";
import { TranslatePipe } from "../../pipes/translate.pipe";

export type DiffHunkAction = "stage" | "unstage" | "";

@Component({
  selector: "app-file-diff-dialog",
  imports: [TranslatePipe],
  templateUrl: "./file-diff-dialog.component.html",
  styleUrl: "./file-diff-dialog.component.css",
})
export class FileDiffDialogComponent implements AfterViewInit {
  private readonly translationService = inject(TranslationService);
  private readonly sanitizer = inject(DomSanitizer);
  private segmentsCache?: { diff: string; segments: DiffSegments };
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;
  @ViewChildren("fileButton") fileButtons!: QueryList<ElementRef<HTMLButtonElement>>;
  safeImagePreview: SafeUrl | null = null;

  @Input() file!: GitFile;
  @Input() files: GitFile[] = [];
  @Input() diff = "";
  @Input("imagePreview") set imagePreview(value: string) {
    this.safeImagePreview = value ? this.sanitizer.bypassSecurityTrustUrl(value) : null;
  }
  @Input() loading = false;
  @Input() error = "";
  @Input() contextLabel = "";
  /** Quando definido, cada trecho do diff ganha o botão para preparar/despreparar. */
  @Input() hunkAction: DiffHunkAction = "";
  @Input() pendingHunk: number | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() fileSelected = new EventEmitter<GitFile>();
  @Output() hunkActionRequested = new EventEmitter<{ index: number; action: Exclude<DiffHunkAction, ""> }>();

  ngAfterViewInit(): void {
    this.dialog.nativeElement.showModal();
    this.focusSelectedFile();
  }

  onDialogKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    // A página de histórico também usa as setas para navegar pelos commits.
    // Enquanto o modal estiver aberto, elas pertencem à lista de arquivos.
    event.preventDefault();
    event.stopPropagation();

    if (this.files.length < 2) {
      return;
    }

    const currentIndex = this.files.findIndex((file) => this.isSelectedFile(file));
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : this.files.length - 1)
      : currentIndex + direction;

    if (nextIndex < 0 || nextIndex >= this.files.length) {
      return;
    }

    this.selectFile(this.files[nextIndex]);
    this.fileButtons.get(nextIndex)?.nativeElement.focus({ preventScroll: true });
    this.fileButtons.get(nextIndex)?.nativeElement.scrollIntoView({ block: "nearest" });
  }

  isSelectedFile(file: GitFile): boolean {
    return file.path === this.file.path && file.isStaged === this.file.isStaged;
  }

  selectFile(file: GitFile): void {
    if (!this.isSelectedFile(file)) {
      this.fileSelected.emit(file);
    }
  }

  statusCode(status: GitFileStatus): string {
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

  private focusSelectedFile(): void {
    const index = this.files.findIndex((file) => this.isSelectedFile(file));
    this.fileButtons.get(index)?.nativeElement.focus({ preventScroll: true });
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.closed.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closed.emit();
    }
  }

  statusLabel(status: GitFileStatus): string {
    switch (status) {
      case "added":
        return this.translationService.translate("diff.added");
      case "deleted":
        return this.translationService.translate("diff.deleted");
      case "renamed":
        return this.translationService.translate("diff.renamed");
      case "untracked":
        return this.translationService.translate("diff.untracked");
      case "conflicted":
        return this.translationService.translate("diff.conflicted");
      case "modified":
        return this.translationService.translate("diff.modified");
    }
  }

  diffSegments(): DiffSegments {
    if (this.segmentsCache?.diff !== this.diff) {
      this.segmentsCache = { diff: this.diff, segments: splitDiffHunks(this.diff) };
    }

    return this.segmentsCache.segments;
  }

  requestHunkAction(index: number): void {
    if (!this.hunkAction || this.pendingHunk !== null) {
      return;
    }

    this.hunkActionRequested.emit({ index, action: this.hunkAction });
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
}
