import { Injectable, computed, signal } from "@angular/core";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

@Injectable({ providedIn: "root" })
export class UpdateService {
  private readonly checkInterval = 24 * 60 * 60 * 1000;
  private pendingUpdate: Update | null = null;
  private checkPromise: Promise<void> | null = null;
  private lastCheckAt = 0;
  private downloadedBytes = 0;
  private contentLength: number | undefined;

  private readonly stateState = signal<UpdateState>("idle");
  private readonly availableVersionState = signal<string | null>(null);
  private readonly notesState = signal<string | null>(null);
  private readonly progressState = signal(0);

  readonly state = this.stateState.asReadonly();
  readonly availableVersion = this.availableVersionState.asReadonly();
  readonly notes = this.notesState.asReadonly();
  readonly progress = this.progressState.asReadonly();
  readonly updateAvailable = computed(() => this.availableVersion() !== null);

  async check(options: { force?: boolean } = {}): Promise<void> {
    if (!this.canUseUpdater()) {
      return;
    }

    if (this.checkPromise) {
      return this.checkPromise;
    }

    if (!options.force && Date.now() - this.lastCheckAt < this.checkInterval) {
      return;
    }

    this.lastCheckAt = Date.now();
    this.checkPromise = this.performCheck().finally(() => {
      this.checkPromise = null;
    });

    return this.checkPromise;
  }

  async install(): Promise<void> {
    if (!this.canUseUpdater()) {
      throw new Error("O atualizador só está disponível no aplicativo instalado.");
    }

    if (!this.pendingUpdate) {
      await this.check({ force: true });
    }

    if (!this.pendingUpdate) {
      return;
    }

    this.stateState.set("downloading");
    this.progressState.set(0);
    this.downloadedBytes = 0;
    this.contentLength = undefined;

    try {
      await this.pendingUpdate.downloadAndInstall((event) => this.handleDownloadEvent(event));
      this.progressState.set(100);
      this.stateState.set("ready");
    } catch (error) {
      this.stateState.set("available");
      throw error;
    }
  }

  async relaunch(): Promise<void> {
    if (!this.canUseUpdater()) {
      return;
    }

    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }

  private async performCheck(): Promise<void> {
    this.stateState.set("checking");

    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 15_000 });

      if (!update) {
        this.pendingUpdate = null;
        this.availableVersionState.set(null);
        this.notesState.set(null);
        this.stateState.set("idle");
        return;
      }

      this.pendingUpdate = update;
      this.availableVersionState.set(update.version);
      this.notesState.set(update.body?.trim() || null);
      this.stateState.set("available");
    } catch (error) {
      this.stateState.set("error");
      console.warn("Não foi possível verificar atualizações do GitLuna.", error);
    }
  }

  private handleDownloadEvent(event: DownloadEvent): void {
    if (event.event === "Started") {
      this.contentLength = event.data.contentLength;
      this.downloadedBytes = 0;
      this.progressState.set(0);
      return;
    }

    if (event.event === "Progress") {
      this.downloadedBytes += event.data.chunkLength;

      if (this.contentLength && this.contentLength > 0) {
        this.progressState.set(
          Math.min(99, Math.round((this.downloadedBytes / this.contentLength) * 100)),
        );
      }
    }
  }

  private canUseUpdater(): boolean {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return false;
    }

    const hostname = window.location.hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  }
}
