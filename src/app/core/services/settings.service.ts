import { Injectable, signal } from "@angular/core";
import { AppLanguage } from "../models/language.model";
import {
  AI_MODEL_OPTIONS,
  AiModelId,
  DEFAULT_AI_MODEL_ID,
} from "../models/ai-model.model";

@Injectable({ providedIn: "root" })
export class SettingsService {
  private readonly languageState = signal<AppLanguage>(this.loadLanguage());
  private readonly aiEnabledState = signal(this.loadAiEnabled());
  private readonly aiModelState = signal<AiModelId>(this.loadAiModel());
  private readonly gitCommandNotificationsState = signal(
    this.loadBoolean("git-app.git-command-notifications", true),
  );
  private readonly notificationSoundsState = signal(
    this.loadBoolean("git-app.notification-sounds", false),
  );
  private readonly codexEnabledState = signal(
    this.loadBoolean("git-app.codex-enabled", false),
  );

  readonly language = this.languageState.asReadonly();
  readonly aiEnabled = this.aiEnabledState.asReadonly();
  readonly aiModel = this.aiModelState.asReadonly();
  readonly gitCommandNotifications = this.gitCommandNotificationsState.asReadonly();
  readonly notificationSounds = this.notificationSoundsState.asReadonly();
  readonly codexEnabled = this.codexEnabledState.asReadonly();

  setLanguage(language: AppLanguage): void {
    this.languageState.set(language);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem("git-app.language", language);
    }
  }

  setAiEnabled(enabled: boolean): void {
    this.aiEnabledState.set(enabled);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem("git-app.ai-enabled", String(enabled));
    }
  }

  setAiModel(modelId: AiModelId): void {
    if (!AI_MODEL_OPTIONS.some((model) => model.id === modelId)) {
      return;
    }

    this.aiModelState.set(modelId);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem("git-app.ai-model", modelId);
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

  setCodexEnabled(enabled: boolean): void {
    this.codexEnabledState.set(enabled);
    this.saveBoolean("git-app.codex-enabled", enabled);
  }

  private loadAiEnabled(): boolean {
    if (typeof localStorage === "undefined") {
      return false;
    }

    return localStorage.getItem("git-app.ai-enabled") === "true";
  }

  private loadLanguage(): AppLanguage {
    if (typeof localStorage === "undefined") {
      return "pt-BR";
    }

    return localStorage.getItem("git-app.language") === "en" ? "en" : "pt-BR";
  }

  private loadAiModel(): AiModelId {
    if (typeof localStorage === "undefined") {
      return DEFAULT_AI_MODEL_ID;
    }

    const saved = localStorage.getItem("git-app.ai-model");
    return AI_MODEL_OPTIONS.some((model) => model.id === saved)
      ? (saved as AiModelId)
      : DEFAULT_AI_MODEL_ID;
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
