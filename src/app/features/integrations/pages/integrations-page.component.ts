import { Component, OnDestroy, inject } from "@angular/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  GithubConnection,
  GithubDeviceFlowStart,
  GithubSshKey,
} from "../../../core/models/github.model";
import { GithubService } from "../../../core/services/github.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { WorkspaceService } from "../../../core/services/workspace.service";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

type ConnectionState = "idle" | "starting" | "waiting" | "success" | "error";
type SshBusyState = "idle" | "generating" | "verifying";

const GITHUB_SSH_KEYS_URL = "https://github.com/settings/ssh/new";
const COMPUTER_SSH_OPTION = "computer";

@Component({
  selector: "app-integrations-page",
  imports: [TranslatePipe],
  templateUrl: "./integrations-page.component.html",
  styleUrl: "./integrations-page.component.css",
})
export class IntegrationsPageComponent implements OnDestroy {
  private readonly githubService = inject(GithubService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  readonly activeWorkspace = this.workspaceService.activeWorkspace;
  readonly connections = this.githubService.workspaceConnections;
  readonly Math = Math;

  connectionState: ConnectionState = "idle";
  deviceFlow: GithubDeviceFlowStart | undefined;
  connectionMessage = "";
  errorMessage = "";
  copiedCode = false;

  methodChooserOpen = false;
  sshPanelOpen = false;
  sshKeys: GithubSshKey[] = [];
  sshKeysLoading = false;
  sshKeysError = "";
  sshSelectedPath: string = COMPUTER_SSH_OPTION;
  sshBusy: SshBusyState = "idle";
  sshError = "";
  sshCopied = false;
  sshProbeMessage = "";

  private flowCancelled = false;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  private sshCopyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  /** Abre a escolha do método: GitHub App ou chave SSH. */
  openMethodChooser(): void {
    if (this.connectionState === "starting" || this.connectionState === "waiting") {
      return;
    }

    this.methodChooserOpen = true;
    this.sshPanelOpen = false;
    this.connectionState = "idle";
    this.connectionMessage = "";
    this.errorMessage = "";
  }

  closeMethodChooser(): void {
    this.methodChooserOpen = false;
  }

  chooseAppMethod(): void {
    this.methodChooserOpen = false;
    this.sshPanelOpen = false;
    void this.connectGithub();
  }

  chooseSshMethod(): void {
    this.methodChooserOpen = false;
    this.openSshPanel();
  }

  openSshPanel(): void {
    this.sshPanelOpen = true;
    this.connectionState = "idle";
    this.deviceFlow = undefined;
    this.connectionMessage = "";
    this.errorMessage = "";
    this.sshError = "";
    this.sshProbeMessage = "";
    this.sshCopied = false;
    void this.loadSshKeys();
  }

  closeSshPanel(): void {
    this.sshPanelOpen = false;
    this.sshBusy = "idle";
    this.sshError = "";
    this.sshProbeMessage = "";
  }

  async loadSshKeys(): Promise<void> {
    this.sshKeysLoading = true;
    this.sshKeysError = "";

    try {
      this.sshKeys = await this.githubService.listSshKeys();

      if (
        this.sshSelectedPath !== COMPUTER_SSH_OPTION &&
        !this.sshKeys.some((key) => key.path === this.sshSelectedPath)
      ) {
        this.sshSelectedPath = COMPUTER_SSH_OPTION;
      }
    } catch (error: unknown) {
      this.sshKeys = [];
      this.sshKeysError = this.getErrorMessage(error);
    } finally {
      this.sshKeysLoading = false;
    }
  }

  async generateSshKey(): Promise<void> {
    if (this.sshBusy !== "idle") {
      return;
    }

    this.sshBusy = "generating";
    this.sshError = "";
    this.sshProbeMessage = "";

    try {
      const key = await this.githubService.generateSshKey();
      this.sshSelectedPath = key.path;
      this.sshCopied = false;
      await this.loadSshKeys();
      this.toastService.success(
        this.translationService.translate("integrations.sshKeyGenerated", { name: key.name }),
        this.translationService.translate("integrations.sshTitle"),
      );
    } catch (error: unknown) {
      this.sshError = this.getErrorMessage(error);
    } finally {
      this.sshBusy = "idle";
    }
  }

  selectSshKey(path: string): void {
    this.sshSelectedPath = path;
    this.sshCopied = false;
    this.sshError = "";
    this.sshProbeMessage = "";
  }

  selectedSshKey(): GithubSshKey | undefined {
    return this.sshKeys.find((key) => key.path === this.sshSelectedPath);
  }

  usesComputerSsh(): boolean {
    return this.sshSelectedPath === COMPUTER_SSH_OPTION;
  }

  copySshPublicKey(): void {
    const publicKey = this.selectedSshKey()?.publicKey;

    if (!publicKey || !navigator.clipboard) {
      return;
    }

    void navigator.clipboard.writeText(publicKey).then(() => {
      this.sshCopied = true;
      if (this.sshCopyFeedbackTimer) {
        clearTimeout(this.sshCopyFeedbackTimer);
      }
      this.sshCopyFeedbackTimer = setTimeout(() => (this.sshCopied = false), 1800);
    });
  }

  openGithubSshKeys(): void {
    void openUrl(GITHUB_SSH_KEYS_URL).catch(() => {
      this.sshError = this.translationService.translate("integrations.browserError");
    });
  }

  /** Confirma com o GitHub que a chave escolhida autentica e salva a conexão. */
  async verifySshConnection(): Promise<void> {
    if (this.sshBusy !== "idle") {
      return;
    }

    this.sshBusy = "verifying";
    this.sshError = "";
    this.sshProbeMessage = "";

    try {
      const selectedKey = this.selectedSshKey();
      const probe = await this.githubService.probeSsh(selectedKey?.path);

      if (!this.sshPanelOpen) {
        // O usuário fechou o painel enquanto a verificação acontecia.
        return;
      }

      if (!probe.authenticated || !probe.login) {
        this.sshProbeMessage = probe.message;
        this.sshError = this.translationService.translate("integrations.sshFailed");
        return;
      }

      const connection = this.githubService.addSshConnection(
        this.activeWorkspace().id,
        probe.login,
        {
          keyPath: selectedKey?.path,
          keyName: selectedKey?.name,
          algorithm: selectedKey?.algorithm,
          managed: selectedKey?.managed ?? false,
        },
      );

      this.sshPanelOpen = false;
      this.sshBusy = "idle";
      this.connectionState = "success";
      this.connectionMessage = this.translationService.translate("integrations.sshConnected", {
        login: connection.login,
      });
      this.toastService.success(
        this.translationService.translate("integrations.connectedToWorkspace", {
          login: connection.login,
        }),
        this.translationService.translate("integrations.githubConnected"),
      );
    } catch (error: unknown) {
      this.sshError = this.getErrorMessage(error);
    } finally {
      this.sshBusy = "idle";
    }
  }

  async testSshConnection(connection: GithubConnection): Promise<void> {
    if (this.sshBusy !== "idle") {
      return;
    }

    this.sshBusy = "verifying";

    try {
      const probe = await this.githubService.probeSsh(connection.ssh?.keyPath);

      if (probe.authenticated && probe.login) {
        this.toastService.success(
          this.translationService.translate("integrations.sshTestSuccess", { login: probe.login }),
          this.translationService.translate("integrations.sshTestTitle"),
        );
      } else {
        const detail = probe.message?.trim();

        this.toastService.error(
          detail
            ? this.translationService.translate("integrations.sshTestError", { message: detail })
            : this.translationService.translate("integrations.sshFailed"),
          this.translationService.translate("integrations.sshTestTitle"),
        );
      }
    } catch (error: unknown) {
      this.toastService.error(
        this.getErrorMessage(error),
        this.translationService.translate("integrations.sshTestTitle"),
      );
    } finally {
      this.sshBusy = "idle";
    }
  }

  async removeSshKey(connection: GithubConnection): Promise<void> {
    const keyPath = connection.ssh?.keyPath;

    if (!keyPath) {
      return;
    }

    const confirmed = window.confirm(
      this.translationService.translate("integrations.sshRemoveKeyConfirm", {
        name: connection.ssh?.keyName ?? keyPath,
      }),
    );

    if (!confirmed) {
      return;
    }

    try {
      await this.githubService.deleteSshKey(keyPath);
      await this.githubService.disconnect(connection);
      await this.loadSshKeys();
      this.toastService.success(
        this.translationService.translate("integrations.sshKeyRemoved"),
        this.translationService.translate("integrations.sshTitle"),
      );
    } catch (error: unknown) {
      this.toastService.error(
        this.getErrorMessage(error),
        this.translationService.translate("integrations.sshTitle"),
      );
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
      this.translationService.translate(
        connection.mode === "ssh"
          ? "integrations.sshDisconnectConfirm"
          : "integrations.disconnectConfirm",
        { login: connection.login },
      ),
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
    this.githubService.setDefault(connection);
    this.toastService.info(
      this.translationService.translate("integrations.defaultInfo", { login: connection.login }),
      this.translationService.translate("integrations.githubTitle"),
    );
  }

  trackConnection(_index: number, connection: GithubConnection): string {
    return `${connection.mode}:${connection.id}`;
  }

  connectionModeLabel(connection: GithubConnection): string {
    return connection.mode === "ssh"
      ? this.translationService.translate("integrations.modeSsh")
      : this.translationService.translate("integrations.modeApp");
  }

  connectionDetail(connection: GithubConnection): string {
    const login = `@${connection.login}`;

    if (connection.mode !== "ssh") {
      return login;
    }

    const keyName = connection.ssh?.keyName;

    return keyName
      ? `${login} · ${this.translationService.translate("integrations.sshKeyDetail", { name: keyName })}`
      : `${login} · ${this.translationService.translate("integrations.sshComputerDetail")}`;
  }

  ngOnDestroy(): void {
    this.flowCancelled = true;
    if (this.copyFeedbackTimer) {
      clearTimeout(this.copyFeedbackTimer);
    }
    if (this.sshCopyFeedbackTimer) {
      clearTimeout(this.sshCopyFeedbackTimer);
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
