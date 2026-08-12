import { Injectable, inject, signal } from "@angular/core";
import { SettingsService } from "./settings.service";
import { TranslationService } from "./translation.service";

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
  private readonly settingsService = inject(SettingsService);
  private readonly translationService = inject(TranslationService);
  private readonly toastsState = signal<ToastItem[]>([]);
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private audioContext: AudioContext | null = null;
  private nextId = 0;

  readonly toasts = this.toastsState.asReadonly();

  success(message: string, title?: string): void {
    this.show(message, "success", title ?? this.translationService.translate("common.toastSuccess"), 4200);
  }

  error(message: string, title?: string): void {
    this.show(message, "error", title ?? this.translationService.translate("common.toastError"), 7000);
  }

  warning(message: string, title?: string): void {
    this.show(message, "warning", title ?? this.translationService.translate("common.toastWarning"), 5200);
  }

  info(message: string, title?: string): void {
    this.show(message, "info", title ?? this.translationService.translate("common.toastInfo"), 4200);
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
    this.playNotificationSound(kind);

    const timer = setTimeout(() => this.dismiss(id), duration);
    this.timers.set(id, timer);
  }

  private playNotificationSound(kind: ToastKind): void {
    if (typeof window === "undefined" || !this.settingsService.notificationSounds()) {
      return;
    }

    try {
      this.audioContext ??= new AudioContext();
      const context = this.audioContext;
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const frequency = this.soundFrequency(kind);

      oscillator.type = kind === "error" ? "sawtooth" : "sine";
      oscillator.frequency.setValueAtTime(frequency, now);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.88, now + 0.14);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.045, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.16);

      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
    } catch {
      // O som é opcional e não deve impedir a exibição da notificação.
    }
  }

  private soundFrequency(kind: ToastKind): number {
    switch (kind) {
      case "success":
        return 660;
      case "error":
        return 240;
      case "warning":
        return 420;
      case "info":
        return 540;
    }
  }
}
