import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from "@angular/core";

@Component({
  selector: "app-confirm-dialog",
  templateUrl: "./confirm-dialog.component.html",
  styleUrl: "./confirm-dialog.component.css",
})
export class ConfirmDialogComponent implements AfterViewInit {
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;

  @Input() title = "Confirmar ação";
  @Input() message = "Tem certeza que deseja continuar?";
  @Input() messageHighlight = "";
  @Input() confirmLabel = "Confirmar";
  @Input() cancelLabel = "Cancelar";
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
