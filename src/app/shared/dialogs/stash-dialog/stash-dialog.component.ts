import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnInit, Output, ViewChild } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { GitFile } from "../../../core/models/git-file.model";
import { TranslatePipe } from "../../pipes/translate.pipe";

@Component({
  selector: "app-stash-dialog",
  imports: [FormsModule, TranslatePipe],
  templateUrl: "./stash-dialog.component.html",
  styleUrl: "./stash-dialog.component.css",
})
export class StashDialogComponent implements AfterViewInit, OnInit {
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;

  @Input() files: GitFile[] = [];
  @Input() message = "";
  @Input() isSaving = false;
  @Input() selectedPaths: string[] = [];

  @Output() messageChange = new EventEmitter<string>();
  @Output() selectedPathsChange = new EventEmitter<string[]>();
  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  private selectedFilePaths: string[] = [];

  ngOnInit(): void {
    this.selectedFilePaths = this.selectedPaths.length > 0
      ? [...this.selectedPaths]
      : this.stashableFiles().map((file) => file.path);
    this.emitSelectedPaths();
  }

  ngAfterViewInit(): void {
    this.dialog.nativeElement.showModal();
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.cancelled.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget && !this.isSaving) {
      this.cancelled.emit();
    }
  }

  stashableFiles(): GitFile[] {
    return this.files.filter((file) => !file.isConflicted && file.status !== "conflicted");
  }

  isFileSelected(filePath: string): boolean {
    return this.selectedFilePaths.includes(filePath);
  }

  allFilesSelected(): boolean {
    const files = this.stashableFiles();
    return files.length > 0 && this.selectedFilePaths.length === files.length;
  }

  toggleFile(file: GitFile): void {
    if (file.isConflicted || file.status === "conflicted") {
      return;
    }

    this.selectedFilePaths = this.isFileSelected(file.path)
      ? this.selectedFilePaths.filter((path) => path !== file.path)
      : [...this.selectedFilePaths, file.path];
    this.emitSelectedPaths();
  }

  toggleAllFiles(): void {
    this.selectedFilePaths = this.allFilesSelected()
      ? []
      : this.stashableFiles().map((file) => file.path);
    this.emitSelectedPaths();
  }

  statusCode(status: string): string {
    switch (status) {
      case "added":
        return "A";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "untracked":
        return "?";
      default:
        return "M";
    }
  }

  private emitSelectedPaths(): void {
    this.selectedPathsChange.emit([...this.selectedFilePaths]);
  }
}
