import { Component, OnDestroy, OnInit, inject } from "@angular/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GithubConnection, GithubDeviceFlowStart } from "../../../core/models/github.model";
import { GithubService } from "../../../core/services/github.service";
import { CodexService } from "../../../core/services/codex.service";
import { SettingsService } from "../../../core/services/settings.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { WorkspaceService } from "../../../core/services/workspace.service";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

type ConnectionState = "idle" | "starting" | "waiting" | "success" | "error";

@Component({
  selector: "app-integrations-page",
  imports: [TranslatePipe],
  templateUrl: "./integrations-page.component.html",
  styleUrl: "./integrations-page.component.css",
})
export class IntegrationsPageComponent implements OnInit, OnDestroy {
  private readonly githubService = inject(GithubService);
  private readonly codexService = inject(CodexService);
  private readonly settingsService = inject(SettingsService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  readonly activeWorkspace = this.workspaceService.activeWorkspace;
  readonly connections = this.githubService.workspaceConnections;
  readonly Math = Math;
  readonly codexStatus = this.codexService.status;
  readonly codexChecking = this.codexService.isChecking;
  readonly codexEnabled = this.settingsService.codexEnabled;

  connectionState: ConnectionState = "idle";
  deviceFlow: GithubDeviceFlowStart | undefined;
  connectionMessage = "";
  errorMessage = "";
  copiedCode = false;
  private flowCancelled = false;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    void this.codexService.check();
  }

  toggleCodex(event: Event): void {
    this.settingsService.setCodexEnabled((event.target as HTMLInputElement).checked);
  }

  async checkCodex(): Promise<void> {
    await this.codexService.check();
  }

  async openCodexDocumentation(): Promise<void> {
    try {
      await openUrl("https://developers.openai.com/codex/cli/");
    } catch {
      window.open("https://developers.openai.com/codex/cli/", "_blank", "noopener,noreferrer");
    }
  }

  async connectGithub(): Promise<void> {
    if (this.connectionState === "starting" || this.connectionState === "waiting") {
      return;
    }

    this.flowCancelled = false;
    this.deviceFlow = undefined;
    this.errorMessage = "";
    this.connectionMessage = this.translationService.translate("integrations.preparing");
    this.connectionState = "starting";

    try {
      const flow = await this.githubService.startDeviceFlow();

      if (this.flowCancelled) {
        return;
      }

      this.deviceFlow = flow;
      this.connectionState = "waiting";
      this.connectionMessage = this.translationService.translate("integrations.authorizeHint");
      await this.openGithubAuthorization();
      await this.waitForAuthorization(flow);
    } catch (error: unknown) {
      if (this.flowCancelled) {
        return;
      }

      this.connectionState = "error";
      this.errorMessage = this.getErrorMessage(error);
    }
  }

  async openGithubAuthorization(): Promise<void> {
    const flow = this.deviceFlow;

    if (!flow) {
      return;
    }

    try {
      await openUrl(flow.verificationUriComplete ?? flow.verificationUri);
    } catch {
      this.connectionMessage = this.translationService.translate("integrations.browserError");
    }
  }

  copyDeviceCode(): void {
    const code = this.deviceFlow?.userCode;

    if (!code || !navigator.clipboard) {
      return;
    }

    void navigator.clipboard.writeText(code).then(() => {
      this.copiedCode = true;
      if (this.copyFeedbackTimer) {
        clearTimeout(this.copyFeedbackTimer);
      }
      this.copyFeedbackTimer = setTimeout(() => (this.copiedCode = false), 1800);
    });
  }

  cancelConnection(): void {
    this.flowCancelled = true;
    this.deviceFlow = undefined;
    this.connectionState = "idle";
    this.connectionMessage = "";
    this.errorMessage = "";
  }

  async disconnect(connection: GithubConnection): Promise<void> {
    const confirmed = window.confirm(
      this.translationService.translate("integrations.disconnectConfirm", { login: connection.login }),
    );

    if (!confirmed) {
      return;
    }

    try {
      await this.githubService.disconnect(connection);
      this.toastService.success(
        this.translationService.translate("integrations.disconnected", { login: connection.login }),
        this.translationService.translate("integrations.githubTitle"),
      );
    } catch (error: unknown) {
      this.toastService.error(this.getErrorMessage(error), this.translationService.translate("integrations.githubTitle"));
    }
  }

  setDefault(connection: GithubConnection): void {
    this.githubService.setDefault(connection.workspaceId, connection.id);
    this.toastService.info(
      this.translationService.translate("integrations.defaultInfo", { login: connection.login }),
      this.translationService.translate("integrations.githubTitle"),
    );
  }

  trackConnection(_index: number, connection: GithubConnection): number {
    return connection.id;
  }

  ngOnDestroy(): void {
    this.flowCancelled = true;
    if (this.copyFeedbackTimer) {
      clearTimeout(this.copyFeedbackTimer);
    }
  }

  private async waitForAuthorization(flow: GithubDeviceFlowStart): Promise<void> {
    const workspaceId = this.activeWorkspace().id;
    const deadline = Date.now() + flow.expiresIn * 1000;
    let interval = Math.max(flow.interval, 5) * 1000;

    while (!this.flowCancelled && Date.now() < deadline) {
      await this.delay(interval);

      if (this.flowCancelled) {
        return;
      }

      const result = await this.githubService.pollDeviceFlow(flow.deviceCode, workspaceId);

      if (result.status === "authorized" && result.user) {
        this.githubService.addConnection(workspaceId, result.user);
        this.connectionState = "success";
        this.connectionMessage = this.translationService.translate("integrations.connectedMessage", { login: result.user.login });
        this.deviceFlow = undefined;
        this.toastService.success(
          this.translationService.translate("integrations.connectedToWorkspace", { login: result.user.login }),
          this.translationService.translate("integrations.githubConnected"),
        );
        return;
      }

      if (result.status === "pending") {
        this.connectionMessage = this.translationService.translate("integrations.waiting");
        continue;
      }

      if (result.status === "slowDown") {
        interval = Math.max((result.interval ?? interval / 1000) + 5, 5) * 1000;
        this.connectionMessage = this.translationService.translate("integrations.slowDown");
        continue;
      }

      throw new Error(this.deviceFlowError(result.status, result.message));
    }

    if (!this.flowCancelled) {
      throw new Error(this.translationService.translate("integrations.expired"));
    }
  }

  private deviceFlowError(status: string, message?: string): string {
    if (status === "denied") {
      return this.translationService.translate("integrations.denied");
    }

    if (status === "expired") {
      return this.translationService.translate("integrations.expired");
    }

    if (status === "disabled") {
      return this.translationService.translate("integrations.disabled");
    }

    return message ?? this.translationService.translate("integrations.connectionError");
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private getErrorMessage(error: unknown): string {
    return typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : this.translationService.translate("integrations.connectError");
  }
}
