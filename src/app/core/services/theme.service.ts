import { Injectable, signal } from "@angular/core";
import {
  DEFAULT_THEME_ID,
  THEME_OPTIONS,
  ThemeId,
} from "../models/theme.model";

const THEME_STORAGE_KEY = "git-app.theme";

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly themeState = signal<ThemeId>(this.loadTheme());

  readonly theme = this.themeState.asReadonly();
  readonly themes = THEME_OPTIONS;

  constructor() {
    this.applyTheme(this.themeState());
  }

  setTheme(themeId: ThemeId): void {
    if (!THEME_OPTIONS.some((theme) => theme.id === themeId)) {
      return;
    }

    this.themeState.set(themeId);
    this.applyTheme(themeId);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, themeId);
    }
  }

  private applyTheme(themeId: ThemeId): void {
    if (typeof document !== "undefined") {
      document.documentElement.dataset["theme"] = themeId;
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
