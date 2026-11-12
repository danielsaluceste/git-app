import { Component, computed, inject, OnDestroy } from "@angular/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { GithubConnection, GithubDeviceFlowStart } from "../../../core/models/github.model";
import { SshConnection, SshConnectionTest, SshKey } from "../../../core/models/ssh-key.model";
import { GithubService } from "../../../core/services/github.service";
import { SshKeyService } from "../../../core/services/ssh-key.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { WorkspaceService } from "../../../core/services/workspace.service";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

type ConnectionState = "idle" | "starting" | "waiting" | "success" | "error";
type ConnectionMethod = "account" | "ssh";
type SshTestState = "idle" | "success" | "error";

const GITHUB_SSH_SETTINGS_URL = "https://github.com/settings/ssh/new";
const SSH_KEY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

@Component({
  selector: "app-integrations-page",
  imports: [TranslatePipe],
  templateUrl: "./integrations-page.component.html",
  styleUrl: "./integrations-page.component.css",
})
export class IntegrationsPageComponent implements OnDestroy {
  private readonly githubService = inject(GithubService);
  private readonly sshKeyService = inject(SshKeyService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  readonly activeWorkspace = this.workspaceService.activeWorkspace;
  readonly connections = this.githubService.workspaceConnections;
  readonly sshConnections = this.sshKeyService.workspaceConnections;
  readonly hasGithubConnection = computed(
    () => this.connections().length > 0 || this.sshConnections().length > 0,
  );
  readonly Math = Math;

  connectionMethod: ConnectionMethod =
    this.connections().length === 0 && this.sshConnections().length > 0 ? "ssh" : "account";
  connectionState: ConnectionState = "idle";
  deviceFlow: GithubDeviceFlowStart | undefined;
  connectionMessage = "";
  errorMessage = "";
  copiedCode = false;

  sshKeys: SshKey[] = [];
  sshKeysDirectory = "";
  sshKeysLoading = false;
  sshKeysError = "";
  selectedSshKey: SshKey | undefined;
  sshSetupOpen = false;
  sshCopied = false;
  sshTesting = false;
  sshTestingKeyPath: string | undefined;
  sshTestState: SshTestState = "idle";
  sshTestMessage = "";
  sshTestDetail = "";
  sshCreatedKeyName = "";
  showCreateKeyForm = false;
  newKeyName = "id_ed25519";
  newKeyComment = "";
  creatingKey = false;
  createKeyError = "";

  private flowCancelled = false;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  private sshCopyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  selectMethod(method: ConnectionMethod): void {
    this.connectionMethod = method;
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

  startSshSetup(): void {
    this.sshSetupOpen = true;
    this.showCreateKeyForm = false;
    this.sshCreatedKeyName = "";
    this.selectedSshKey = undefined;
    this.resetSshTest();
    void this.loadSshKeys();
  }

  closeSshSetup(): void {
    this.sshSetupOpen = false;
    this.showCreateKeyForm = false;
    this.sshCreatedKeyName = "";
    this.resetSshTest();
  }

  async loadSshKeys(): Promise<void> {
    this.sshKeysLoading = true;
    this.sshKeysError = "";

    try {
      const result = await this.sshKeyService.listKeys();
      this.sshKeys = result.keys;
      this.sshKeysDirectory = result.directory;

      if (this.sshSetupOpen) {
        const connectedPaths = new Set(
          this.sshConnections().map((connection) => connection.keyPath),
        );
        const current = this.selectedSshKey;
        this.selectedSshKey =
          (current && result.keys.find((key) => key.path === current.path)) ??
          result.keys.find((key) => !connectedPaths.has(key.path)) ??
          result.keys[0];
      }
    } catch (error: unknown) {
      this.sshKeys = [];
      this.selectedSshKey = undefined;
      this.sshKeysError = this.getErrorMessage(error, "integrations.ssh.loadError");
    } finally {
      this.sshKeysLoading = false;
    }
  }

  isSshKeyConnected(key: SshKey): boolean {
    return this.sshConnections().some(
      (connection) => connection.keyPath === key.path,
    );
  }

  selectSshKey(key: SshKey): void {
    this.selectedSshKey = key;
    this.sshCopied = false;
    this.sshCreatedKeyName = "";
    this.resetSshTest();
  }

  async chooseSshKeyFile(): Promise<void> {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: this.translationService.translate("integrations.ssh.chooseFileTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      const key = await this.sshKeyService.inspectKey(selected);
      const existingIndex = this.sshKeys.findIndex((item) => item.path === key.path);
      this.sshKeys =
        existingIndex >= 0
          ? this.sshKeys.map((item, index) => (index === existingIndex ? key : item))
          : [...this.sshKeys, key];
      this.selectSshKey(key);
    } catch (error: unknown) {
      this.toastService.error(
        this.getErrorMessage(error, "integrations.ssh.inspectError"),
        this.translationService.translate("integrations.ssh.title"),
      );
    }
  }

  toggleCreateKeyForm(): void {
    this.showCreateKeyForm = !this.showCreateKeyForm;
    this.createKeyError = "";

    if (this.showCreateKeyForm) {
      this.newKeyName = this.nextKeyName();
      this.newKeyComment = "";
    }
  }

  updateNewKeyName(event: Event): void {
    this.newKeyName = (event.target as HTMLInputElement).value;
  }

  updateNewKeyComment(event: Event): void {
    this.newKeyComment = (event.target as HTMLInputElement).value;
  }

  async createSshKey(): Promise<void> {
    if (this.creatingKey) {
      return;
    }

    const name = this.newKeyName.trim();

    if (!SSH_KEY_NAME_PATTERN.test(name) || name.startsWith(".")) {
      this.createKeyError = this.translationService.translate("integrations.ssh.nameInvalid");
      return;
    }

    this.creatingKey = true;
    this.createKeyError = "";

    try {
      const key = await this.sshKeyService.createKey(name, this.newKeyComment);
      this.sshKeys = [...this.sshKeys, key].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      this.showCreateKeyForm = false;
      this.selectSshKey(key);
      this.sshCreatedKeyName = key.name;
      this.toastService.success(
        this.translationService.translate("integrations.ssh.created"),
        this.translationService.translate("integrations.ssh.title"),
      );
    } catch (error: unknown) {
      this.createKeyError = this.getErrorMessage(error, "integrations.ssh.createError");
    } finally {
      this.creatingKey = false;
    }
  }

  copySshPublicKey(): void {
    const key = this.selectedSshKey;

    if (!key) {
      return;
    }

    void this.writeClipboard(key.publicKey).then((copied) => {
      if (!copied) {
        this.toastService.error(
          this.translationService.translate("integrations.ssh.copyError"),
          this.translationService.translate("integrations.ssh.title"),
        );
        return;
      }

      this.sshCopied = true;

      if (this.sshCopyFeedbackTimer) {
        clearTimeout(this.sshCopyFeedbackTimer);
      }

      this.sshCopyFeedbackTimer = setTimeout(() => (this.sshCopied = false), 1800);
    });
  }

  async openGithubSshSettings(): Promise<void> {
    try {
      await openUrl(GITHUB_SSH_SETTINGS_URL);
    } catch {
      this.toastService.error(
        this.translationService.translate("integrations.browserError"),
        this.translationService.translate("integrations.ssh.title"),
      );
    }
  }

  async testSshKey(key: SshKey): Promise<void> {
    if (this.sshTesting || !key.hasPrivateKey) {
      return;
    }

    const workspaceId = this.activeWorkspace().id;
    this.sshTesting = true;
    this.sshTestingKeyPath = key.path;
    this.resetSshTest();

    try {
      const result = await this.sshKeyService.testConnection(key.path);

      if (workspaceId !== this.activeWorkspace().id) {
        return;
      }

      if (result.status === "authenticated") {
        this.sshKeyService.addConnection(key, result.login);
        this.sshSetupOpen = false;
        this.showCreateKeyForm = false;
        this.sshCreatedKeyName = "";
        this.toastService.success(
          this.translationService.translate("integrations.ssh.addedMessage", { name: key.name }),
          this.translationService.translate("integrations.ssh.addedToast"),
        );
        return;
      }

      this.sshTestState = "error";
      this.sshTestMessage = this.sshStatusMessage(result.status);
      this.sshTestDetail = result.message ?? "";
    } catch (error: unknown) {
      this.sshTestState = "error";
      this.sshTestMessage = this.getErrorMessage(error, "integrations.ssh.testError");
    } finally {
      this.sshTesting = false;
      this.sshTestingKeyPath = undefined;
    }
  }

  async retestSshConnection(connection: SshConnection): Promise<void> {
    if (this.sshTesting) {
      return;
    }

    this.sshTesting = true;
    this.sshTestingKeyPath = connection.keyPath;

    try {
      const result = await this.sshKeyService.testConnection(connection.keyPath);

      if (result.status === "authenticated") {
        this.sshKeyService.updateLogin(connection, result.login);
        this.toastService.success(
          this.authenticatedMessage(result.login),
          this.translationService.translate("integrations.ssh.title"),
        );
        return;
      }

      this.toastService.warning(
        this.sshStatusMessage(result.status),
        this.translationService.translate("integrations.ssh.title"),
      );
    } catch (error: unknown) {
      this.toastService.error(
        this.getErrorMessage(error, "integrations.ssh.testError"),
        this.translationService.translate("integrations.ssh.title"),
      );
    } finally {
      this.sshTesting = false;
      this.sshTestingKeyPath = undefined;
    }
  }

  removeSshConnection(connection: SshConnection): void {
    const confirmed = window.confirm(
      this.translationService.translate("integrations.ssh.removeConfirm", {
        name: connection.keyName,
      }),
    );

    if (!confirmed) {
      return;
    }

    this.sshKeyService.removeConnection(connection);
    this.toastService.info(
      this.translationService.translate("integrations.ssh.removed", { name: connection.keyName }),
      this.translationService.translate("integrations.ssh.title"),
    );
  }

  trackConnection(_index: number, connection: GithubConnection): number {
    return connection.id;
  }

  trackSshKey(_index: number, key: SshKey): string {
    return key.path;
  }

  trackSshConnection(_index: number, connection: SshConnection): string {
    return connection.keyPath;
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

  private nextKeyName(): string {
    const baseName = "id_ed25519";

    if (!this.sshKeys.some((key) => key.name === baseName)) {
      return baseName;
    }

    let index = 2;

    while (this.sshKeys.some((key) => key.name === `${baseName}_${index}`)) {
      index += 1;
    }

    return `${baseName}_${index}`;
  }

  private authenticatedMessage(login?: string): string {
    return login
      ? this.translationService.translate("integrations.ssh.authenticated", { login })
      : this.translationService.translate("integrations.ssh.authenticatedNoLogin");
  }

  private sshStatusMessage(status: SshConnectionTest["status"]): string {
    if (status === "permissionDenied") {
      return this.translationService.translate("integrations.ssh.permissionDenied");
    }

    if (status === "network") {
      return this.translationService.translate("integrations.ssh.network");
    }

    return this.translationService.translate("integrations.ssh.testError");
  }

  private resetSshTest(): void {
    this.sshTestState = "idle";
    this.sshTestMessage = "";
    this.sshTestDetail = "";
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Alguns webviews bloqueiam a Clipboard API; o fallback abaixo cobre isso.
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private getErrorMessage(error: unknown, fallbackKey = "integrations.connectError"): string {
    return typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : this.translationService.translate(fallbackKey);
  }
}
