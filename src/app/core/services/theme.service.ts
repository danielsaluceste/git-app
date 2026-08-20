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
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      document.documentElement.dataset["tauriWindow"] = "true";
    }
    const themeId = this.themeState();
    this.applyTheme(themeId);
    void this.applyNativeWindowEffect(themeId);
    void this.initWindowMaximizedListener();
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
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_window_theme_effect", { theme: themeId });
    } catch (error) {
      console.debug("Native window effect command error:", error);
    }
  }

  private async initWindowMaximizedListener(): Promise<void> {
    if (
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window)
    ) {
      return;
    }

    try {
      const currentWindow = getCurrentWindow();
      const updateMaximized = async () => {
        try {
          const isMax = await currentWindow.isMaximized();
          if (typeof document !== "undefined") {
            document.documentElement.dataset["maximized"] = String(isMax);
            if (isMax) {
              document.documentElement.classList.add("is-maximized");
            } else {
              document.documentElement.classList.remove("is-maximized");
            }
          }
        } catch {
          // ignore
        }
      };

      await updateMaximized();
      await currentWindow.onResized(updateMaximized);
    } catch (error) {
      console.debug("Could not attach window resize listener", error);
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
