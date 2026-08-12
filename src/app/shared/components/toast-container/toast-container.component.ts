import { Component, inject } from "@angular/core";
import { ToastItem, ToastService } from "../../../core/services/toast.service";
import { TranslatePipe } from "../../pipes/translate.pipe";

@Component({
  selector: "app-toast-container",
  imports: [TranslatePipe],
  templateUrl: "./toast-container.component.html",
  styleUrl: "./toast-container.component.css",
})
export class ToastContainerComponent {
  private readonly toastService = inject(ToastService);

  readonly toasts = this.toastService.toasts;

  dismiss(id: number): void {
    this.toastService.dismiss(id);
  }

  icon(toast: ToastItem): string {
    switch (toast.kind) {
      case "success":
        return "✓";
      case "error":
        return "!";
      case "warning":
        return "⌁";
      case "info":
        return "i";
    }
  }
}
