import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from "@angular/core";
import { GitFile, GitFileStatus } from "../../../core/models/git-file.model";

@Component({
  selector: "app-file-diff-dialog",
  templateUrl: "./file-diff-dialog.component.html",
  styleUrl: "./file-diff-dialog.component.css",
})
export class FileDiffDialogComponent implements AfterViewInit {
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
        return "Adicionado";
      case "deleted":
        return "Excluído";
      case "renamed":
        return "Renomeado";
      case "untracked":
        return "Não rastreado";
      case "modified":
        return "Modificado";
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
