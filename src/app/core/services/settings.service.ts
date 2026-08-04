import { Injectable, signal } from "@angular/core";

@Injectable({ providedIn: "root" })
export class SettingsService {
  private readonly aiEnabledState = signal(this.loadAiEnabled());
  private readonly gitCommandNotificationsState = signal(
    this.loadBoolean("git-app.git-command-notifications", true),
  );
  private readonly notificationSoundsState = signal(
    this.loadBoolean("git-app.notification-sounds", false),
  );

  readonly aiEnabled = this.aiEnabledState.asReadonly();
  readonly gitCommandNotifications = this.gitCommandNotificationsState.asReadonly();
  readonly notificationSounds = this.notificationSoundsState.asReadonly();

  setAiEnabled(enabled: boolean): void {
    this.aiEnabledState.set(enabled);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem("git-app.ai-enabled", String(enabled));
    }
  }

  setGitCommandNotifications(enabled: boolean): void {
    this.gitCommandNotificationsState.set(enabled);
    this.saveBoolean("git-app.git-command-notifications", enabled);
  }

  setNotificationSounds(enabled: boolean): void {
    this.notificationSoundsState.set(enabled);
    this.saveBoolean("git-app.notification-sounds", enabled);
  }

  private loadAiEnabled(): boolean {
    if (typeof localStorage === "undefined") {
      return false;
    }

    return localStorage.getItem("git-app.ai-enabled") === "true";
  }

  private loadBoolean(key: string, defaultValue: boolean): boolean {
    if (typeof localStorage === "undefined") {
      return defaultValue;
    }

    const saved = localStorage.getItem(key);
    return saved === null ? defaultValue : saved === "true";
  }

  private saveBoolean(key: string, value: boolean): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, String(value));
    }
  }
}
