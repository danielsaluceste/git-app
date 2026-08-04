import { Component, EventEmitter, HostListener, Input, Output } from "@angular/core";

@Component({
  selector: "app-confirm-dialog",
  templateUrl: "./confirm-dialog.component.html",
  styleUrl: "./confirm-dialog.component.css",
})
export class ConfirmDialogComponent {
  @Input() title = "Confirmar ação";
  @Input() message = "Tem certeza que deseja continuar?";
  @Input() confirmLabel = "Confirmar";
  @Input() cancelLabel = "Cancelar";
  @Input() destructive = false;

  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  @HostListener("document:keydown.escape")
  onEscape(): void {
    this.cancelled.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.cancelled.emit();
    }
  }
}
