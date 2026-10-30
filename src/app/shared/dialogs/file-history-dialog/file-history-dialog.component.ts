import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  Input,
  OnInit,
  Output,
  signal,
  ViewChild,
} from "@angular/core";
import { BlameLine } from "../../../core/models/blame.model";
import { Commit } from "../../../core/models/commit.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { TranslationService } from "../../../core/services/translation.service";
import { TranslatePipe } from "../../pipes/translate.pipe";

type FileHistoryTab = "history" | "blame";

@Component({
  selector: "app-file-history-dialog",
  imports: [TranslatePipe],
  templateUrl: "./file-history-dialog.component.html",
  styleUrl: "./file-history-dialog.component.css",
})
export class FileHistoryDialogComponent implements OnInit, AfterViewInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly translationService = inject(TranslationService);
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;

  @Input({ required: true }) repositoryPath!: string;
  @Input({ required: true }) filePath!: string;

  @Output() closed = new EventEmitter<void>();

  readonly activeTab = signal<FileHistoryTab>("history");
  readonly commits = signal<Commit[]>([]);
  readonly commitsLoading = signal(true);
  readonly commitsError = signal("");
  readonly blame = signal<BlameLine[]>([]);
  readonly blameLoading = signal(false);
  readonly blameError = signal("");
  private blameLoaded = false;

  ngOnInit(): void {
    void this.loadHistory();
  }

  ngAfterViewInit(): void {
    this.dialog.nativeElement.showModal();
  }

  selectTab(tab: FileHistoryTab): void {
    this.activeTab.set(tab);
    if (tab === "blame" && !this.blameLoaded) {
      void this.loadBlame();
    }
  }

  retryHistory(): void {
    void this.loadHistory();
  }

  retryBlame(): void {
    this.blameLoaded = true;
    void this.loadBlame();
  }

  formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString(this.translationService.language(), {
          dateStyle: "medium",
          timeStyle: "short",
        });
  }

  formatBlameDate(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "";
    }

    return new Date(seconds * 1000).toLocaleString(this.translationService.language(), {
      dateStyle: "short",
      timeStyle: "short",
    });
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

  private async loadHistory(): Promise<void> {
    this.commitsLoading.set(true);
    this.commitsError.set("");

    try {
      this.commits.set(
        await this.repositoryService.getFileHistory(this.repositoryPath, this.filePath),
      );
    } catch (error: unknown) {
      this.commitsError.set(this.errorMessage(error));
    } finally {
      this.commitsLoading.set(false);
    }
  }

  private async loadBlame(): Promise<void> {
    this.blameLoading.set(true);
    this.blameError.set("");

    try {
      this.blame.set(await this.repositoryService.getFileBlame(this.repositoryPath, this.filePath));
    } catch (error: unknown) {
      this.blameError.set(this.errorMessage(error));
    } finally {
      this.blameLoading.set(false);
    }
  }

  private errorMessage(error: unknown): string {
    const detail = typeof error === "string" ? error.trim() : "";

    return detail || this.translationService.translate("fileHistory.error");
  }
}
