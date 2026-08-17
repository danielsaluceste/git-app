import { effect, inject, Injectable, signal, untracked } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Subject } from "rxjs";
import { ShellInfo, TerminalExitPayload, TerminalOutputPayload, TerminalTab } from "../models/terminal.model";
import { RepositoryService } from "./repository.service";

const DRAWER_HEIGHT_STORAGE_KEY = "git-app.terminal.drawer-height";
const DEFAULT_DRAWER_HEIGHT = 280;
const MIN_DRAWER_HEIGHT = 160;
const MAX_DRAWER_HEIGHT = 700;

@Injectable({ providedIn: "root" })
export class TerminalService {
  private readonly repositoryService = inject(RepositoryService);

  readonly isDrawerOpen = signal(false);
  readonly drawerHeight = signal(this.getStoredDrawerHeight());
  readonly isMaximized = signal(false);
  readonly availableShells = signal<ShellInfo[]>([]);
  readonly selectedShellId = signal<string | undefined>(undefined);
  readonly tabs = signal<TerminalTab[]>([]);
  readonly activeTabId = signal<string | null>(null);

  readonly output$ = new Subject<TerminalOutputPayload>();
  readonly exit$ = new Subject<TerminalExitPayload>();

  private unlistenOutput?: UnlistenFn;
  private unlistenExit?: UnlistenFn;
  private isInitialized = false;
  private tabCounter = 1;

  constructor() {
    void this.init();

    // When active repository changes and drawer is open but no tabs exist, create a tab in new cwd
    effect(() => {
      const repo = this.repositoryService.activeRepository();
      const open = this.isDrawerOpen();
      untracked(() => {
        if (open && repo && this.tabs().length === 0) {
          void this.createTab(repo.path);
        }
      });
    });
  }

  async init(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;

    try {
      this.unlistenOutput = await listen<TerminalOutputPayload>("terminal-output", (event) => {
        this.output$.next(event.payload);
      });

      this.unlistenExit = await listen<TerminalExitPayload>("terminal-exit", (event) => {
        this.exit$.next(event.payload);
        this.tabs.update((tabs) =>
          tabs.map((tab) =>
            tab.sessionId === event.payload.sessionId ? { ...tab, isAlive: false } : tab
          )
        );
      });

      await this.loadShells();
    } catch (error) {
      console.warn("Falha ao inicializar serviço de terminal:", error);
    }
  }

  async loadShells(): Promise<ShellInfo[]> {
    try {
      const shells = await invoke<ShellInfo[]>("get_available_shells");
      this.availableShells.set(shells);
      const defaultShell = shells.find((s) => s.isDefault);
      if (defaultShell && !this.selectedShellId()) {
        this.selectedShellId.set(defaultShell.id);
      }
      return shells;
    } catch (error) {
      console.warn("Falha ao listar shells disponíveis:", error);
      return [];
    }
  }

  toggleDrawer(): void {
    if (this.isDrawerOpen()) {
      this.closeDrawer();
    } else {
      this.openDrawer();
    }
  }

  openDrawer(): void {
    this.isDrawerOpen.set(true);
    if (this.tabs().length === 0) {
      const currentPath = this.repositoryService.activeRepository()?.path || "";
      void this.createTab(currentPath);
    }
  }

  closeDrawer(): void {
    this.isDrawerOpen.set(false);
  }

  toggleMaximize(): void {
    this.isMaximized.update((v) => !v);
  }

  setDrawerHeight(height: number): void {
    const clamped = Math.max(MIN_DRAWER_HEIGHT, Math.min(MAX_DRAWER_HEIGHT, height));
    this.drawerHeight.set(clamped);
    try {
      localStorage.setItem(DRAWER_HEIGHT_STORAGE_KEY, String(clamped));
    } catch {
      // ignore
    }
  }

  async createTab(cwd?: string, shellId?: string, rows?: number, cols?: number): Promise<TerminalTab | undefined> {
    const effectiveCwd = cwd || this.repositoryService.activeRepository()?.path || "";
    const effectiveShell = shellId || this.selectedShellId();
    const tabNum = this.tabCounter++;

    try {
      const sessionId = await invoke<string>("create_terminal_session", {
        path: effectiveCwd,
        rows: rows ?? 24,
        cols: cols ?? 80,
        shell: effectiveShell ?? null,
      });

      const shells = this.availableShells();
      const shellObj = shells.find((s) => s.id === effectiveShell);
      const shellName = shellObj ? shellObj.name : "Terminal";

      const tab: TerminalTab = {
        id: `tab-${Date.now()}-${tabNum}`,
        sessionId,
        title: `${shellName} ${tabNum}`,
        shell: effectiveShell,
        cwd: effectiveCwd,
        isAlive: true,
      };

      this.tabs.update((tabs) => [...tabs, tab]);
      this.activeTabId.set(tab.id);
      return tab;
    } catch (error) {
      console.error("Erro ao criar sessão de terminal:", error);
      return undefined;
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const currentTabs = this.tabs();
    const tab = currentTabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }

    try {
      await invoke("close_terminal", { sessionId: tab.sessionId });
    } catch (error) {
      console.warn("Erro ao encerrar sessão de terminal:", error);
    }

    const remaining = currentTabs.filter((t) => t.id !== tabId);
    this.tabs.set(remaining);

    if (this.activeTabId() === tabId) {
      this.activeTabId.set(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }

    if (remaining.length === 0 && this.isDrawerOpen()) {
      this.closeDrawer();
    }
  }

  setActiveTab(tabId: string): void {
    this.activeTabId.set(tabId);
  }

  async write(sessionId: string, data: string): Promise<void> {
    try {
      await invoke("write_terminal", { sessionId, data });
    } catch (error) {
      console.warn("Erro ao enviar dados para o terminal:", error);
    }
  }

  async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    try {
      await invoke("resize_terminal", { sessionId, rows, cols });
    } catch (error) {
      console.warn("Erro ao redimensionar terminal:", error);
    }
  }

  async restartTab(tabId: string): Promise<void> {
    const tab = this.tabs().find((t) => t.id === tabId);
    if (!tab) {
      return;
    }

    try {
      await invoke("close_terminal", { sessionId: tab.sessionId });
    } catch {
      // ignore
    }

    try {
      const newSessionId = await invoke<string>("create_terminal_session", {
        path: tab.cwd,
        rows: 24,
        cols: 80,
        shell: tab.shell ?? null,
      });

      this.tabs.update((tabs) =>
        tabs.map((t) => (t.id === tabId ? { ...t, sessionId: newSessionId, isAlive: true } : t))
      );
    } catch (error) {
      console.error("Erro ao reiniciar terminal:", error);
    }
  }

  private getStoredDrawerHeight(): number {
    try {
      const stored = localStorage.getItem(DRAWER_HEIGHT_STORAGE_KEY);
      if (stored) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= MIN_DRAWER_HEIGHT && val <= MAX_DRAWER_HEIGHT) {
          return val;
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_DRAWER_HEIGHT;
  }
}
