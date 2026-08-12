import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from "@angular/core";
import { TranslatePipe } from "../../pipes/translate.pipe";

@Component({
  selector: "app-confirm-dialog",
  imports: [TranslatePipe],
  templateUrl: "./confirm-dialog.component.html",
  styleUrl: "./confirm-dialog.component.css",
})
export class ConfirmDialogComponent implements AfterViewInit {
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;

  @Input() title = "";
  @Input() message = "";
  @Input() messageHighlight = "";
  @Input() confirmLabel = "";
  @Input() cancelLabel = "";
  @Input() destructive = false;

  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  ngAfterViewInit(): void {
    this.dialog.nativeElement.showModal();
  }

  get messageBeforeHighlight(): string {
    if (!this.messageHighlight) {
      return "";
    }

    const highlightIndex = this.message.indexOf(this.messageHighlight);
    return highlightIndex >= 0 ? this.message.slice(0, highlightIndex) : this.message;
  }

  get messageAfterHighlight(): string {
    if (!this.messageHighlight) {
      return "";
    }

    const highlightIndex = this.message.indexOf(this.messageHighlight);
    return highlightIndex >= 0
      ? this.message.slice(highlightIndex + this.messageHighlight.length)
      : "";
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.cancelled.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.cancelled.emit();
    }
  }
}
