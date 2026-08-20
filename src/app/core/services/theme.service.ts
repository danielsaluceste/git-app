import { Injectable, signal } from "@angular/core";
import {
  DEFAULT_THEME_ID,
  THEME_OPTIONS,
  ThemeId,
} from "../models/theme.model";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";

const THEME_STORAGE_KEY = "git-app.theme";

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly themeState = signal<ThemeId>(this.loadTheme());

  readonly theme = this.themeState.asReadonly();
  readonly themes = THEME_OPTIONS;

  constructor() {
    const themeId = this.themeState();
    this.applyTheme(themeId);
    void this.applyNativeWindowEffect(themeId);
  }

  setTheme(themeId: ThemeId): void {
    if (!THEME_OPTIONS.some((theme) => theme.id === themeId)) {
      return;
    }

    this.themeState.set(themeId);
    this.applyTheme(themeId);
    void this.applyNativeWindowEffect(themeId);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, themeId);
    }
  }

  private applyTheme(themeId: ThemeId): void {
    if (typeof document !== "undefined") {
      document.documentElement.dataset["theme"] = themeId;
    }
  }

  /**
   * Aplica materiais nativos de janela (Acrylic no Windows, Vibrancy no macOS)
   * no tema glassmorphism quando executado via Tauri Desktop.
   */
  private async applyNativeWindowEffect(themeId: ThemeId): Promise<void> {
    if (
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window)
    ) {
      return;
    }

    try {
      const currentWindow = getCurrentWindow();

      if (themeId === "glassmorphism") {
        await currentWindow.setEffects({
          effects: [
            Effect.Acrylic,
            Effect.HudWindow,
            Effect.ContentBackground,
          ],
          state: EffectState.Active,
          radius: 18,
        });
      } else {
        await currentWindow.clearEffects();
      }
    } catch (error) {
      console.debug("Native window effect not available on this platform", error);
    }
  }

  private loadTheme(): ThemeId {
    if (typeof localStorage === "undefined") {
      return DEFAULT_THEME_ID;
    }

    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_OPTIONS.some((theme) => theme.id === savedTheme)
      ? (savedTheme as ThemeId)
      : DEFAULT_THEME_ID;
  }
}
