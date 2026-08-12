import { AfterViewInit, Component, ElementRef, EventEmitter, inject, Input, Output, ViewChild } from "@angular/core";
import { GitFile, GitFileStatus } from "../../../core/models/git-file.model";
import { TranslationService } from "../../../core/services/translation.service";
import { TranslatePipe } from "../../pipes/translate.pipe";

@Component({
  selector: "app-file-diff-dialog",
  imports: [TranslatePipe],
  templateUrl: "./file-diff-dialog.component.html",
  styleUrl: "./file-diff-dialog.component.css",
})
export class FileDiffDialogComponent implements AfterViewInit {
  private readonly translationService = inject(TranslationService);
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;

  @Input() file!: GitFile;
  @Input() diff = "";
  @Input() loading = false;
  @Input() error = "";
  @Input() contextLabel = "";

  @Output() closed = new EventEmitter<void>();

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

  diffLines(): string[] {
    return this.diff.split("\n");
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
