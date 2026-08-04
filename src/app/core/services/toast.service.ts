import { Injectable, signal } from "@angular/core";

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message: string;
  duration: number;
}

@Injectable({ providedIn: "root" })
export class ToastService {
  private readonly toastsState = signal<ToastItem[]>([]);
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 0;

  readonly toasts = this.toastsState.asReadonly();

  success(message: string, title = "Tudo certo"): void {
    this.show(message, "success", title, 4200);
  }

  error(message: string, title = "Algo deu errado"): void {
    this.show(message, "error", title, 7000);
  }

  warning(message: string, title = "Atenção"): void {
    this.show(message, "warning", title, 5200);
  }

  info(message: string, title = "Informação"): void {
    this.show(message, "info", title, 4200);
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    this.toastsState.update((toasts) => toasts.filter((toast) => toast.id !== id));
  }

  private show(message: string, kind: ToastKind, title: string, duration: number): void {
    const id = ++this.nextId;
    const toast: ToastItem = { id, kind, title, message, duration };

    this.toastsState.update((toasts) => [...toasts, toast].slice(-4));

    const timer = setTimeout(() => this.dismiss(id), duration);
    this.timers.set(id, timer);
  }
}
