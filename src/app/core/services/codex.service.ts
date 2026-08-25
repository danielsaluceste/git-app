import { Injectable, inject, signal } from "@angular/core";
import {
  CodexCliStatus,
  CodexModelOption,
  CodexRunResult,
  CodexUsage,
} from "../models/codex.model";
import { TauriCommandsService } from "../tauri/tauri-commands.service";

@Injectable({ providedIn: "root" })
export class CodexService {
  private readonly tauriCommands = inject(TauriCommandsService);

  readonly status = signal<CodexCliStatus | undefined>(undefined);
  readonly isChecking = signal(false);
  readonly isRunning = signal(false);
  readonly models = signal<CodexModelOption[]>([]);
  readonly usage = signal<CodexUsage | undefined>(undefined);
  readonly isLoadingModels = signal(false);
  readonly isLoadingUsage = signal(false);

  async check(): Promise<CodexCliStatus> {
    if (!("__TAURI_INTERNALS__" in window)) {
      const status = { installed: false } satisfies CodexCliStatus;
      this.status.set(status);
      return status;
    }

    this.isChecking.set(true);
    try {
      const status = await this.tauriCommands.execute<CodexCliStatus>("check_codex_cli");
      this.status.set(status);
      return status;
    } catch (error: unknown) {
      const status: CodexCliStatus = {
        installed: false,
        error: this.errorMessage(error),
      };
      this.status.set(status);
      return status;
    } finally {
      this.isChecking.set(false);
    }
  }

  async run(
    repositoryPath: string,
    prompt: string,
    context: string,
    allowEdits: boolean,
    sessionId: string,
    model?: string,
    reasoningEffort?: string,
  ): Promise<CodexRunResult> {
    this.isRunning.set(true);
    try {
      return await this.tauriCommands.execute<CodexRunResult>("run_codex", {
        repositoryPath,
        prompt,
        context: context || null,
        allowEdits,
        codexCommand: this.status()?.command ?? null,
        sessionId,
        model: model ?? null,
        reasoningEffort: reasoningEffort ?? null,
      });
    } finally {
      this.isRunning.set(false);
    }
  }

  async loadModels(): Promise<void> {
    if (!this.status()?.installed || this.isLoadingModels()) {
      return;
    }

    this.isLoadingModels.set(true);
    try {
      const result = await this.tauriCommands.execute<{ models: CodexModelOption[] }>(
        "get_codex_models",
        { codexCommand: this.status()?.command ?? null },
      );
      this.models.set(result.models.filter((model) => !model.hidden));
    } catch {
      this.models.set([]);
    } finally {
      this.isLoadingModels.set(false);
    }
  }

  async loadUsage(): Promise<void> {
    if (!this.status()?.installed || this.isLoadingUsage()) {
      return;
    }

    this.isLoadingUsage.set(true);
    try {
      const usage = await this.tauriCommands.execute<CodexUsage>(
        "get_codex_usage",
        { codexCommand: this.status()?.command ?? null },
      );
      this.usage.set(usage);
    } catch {
      this.usage.set(undefined);
    } finally {
      this.isLoadingUsage.set(false);
    }
  }

  async cancel(): Promise<void> {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    await this.tauriCommands.execute<void>("cancel_codex");
  }

  private errorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return "Não foi possível verificar o Codex CLI.";
  }
}
