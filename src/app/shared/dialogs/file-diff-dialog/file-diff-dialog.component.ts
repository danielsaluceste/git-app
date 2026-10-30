import { AfterViewInit, Component, ElementRef, EventEmitter, inject, Input, Output, ViewChild } from "@angular/core";
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
  private segmentsCache?: { diff: string; segments: DiffSegments };
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;

  @Input() file!: GitFile;
  @Input() diff = "";
  @Input() loading = false;
  @Input() error = "";
  @Input() contextLabel = "";
  /** Quando definido, cada trecho do diff ganha o botão para preparar/despreparar. */
  @Input() hunkAction: DiffHunkAction = "";
  @Input() pendingHunk: number | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() hunkActionRequested = new EventEmitter<{ index: number; action: Exclude<DiffHunkAction, ""> }>();

  ngAfterViewInit(): void {
    this.dialog.nativeElement.showModal();
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
