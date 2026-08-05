import { Component, OnDestroy, inject } from "@angular/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GithubConnection, GithubDeviceFlowStart } from "../../../core/models/github.model";
import { GithubService } from "../../../core/services/github.service";
import { ToastService } from "../../../core/services/toast.service";
import { WorkspaceService } from "../../../core/services/workspace.service";

type ConnectionState = "idle" | "starting" | "waiting" | "success" | "error";

@Component({
  selector: "app-integrations-page",
  templateUrl: "./integrations-page.component.html",
  styleUrl: "./integrations-page.component.css",
})
export class IntegrationsPageComponent implements OnDestroy {
  private readonly githubService = inject(GithubService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly toastService = inject(ToastService);

  readonly activeWorkspace = this.workspaceService.activeWorkspace;
  readonly connections = this.githubService.workspaceConnections;
  readonly Math = Math;

  connectionState: ConnectionState = "idle";
  deviceFlow: GithubDeviceFlowStart | undefined;
  connectionMessage = "";
  errorMessage = "";
  copiedCode = false;
  private flowCancelled = false;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  async connectGithub(): Promise<void> {
    if (this.connectionState === "starting" || this.connectionState === "waiting") {
      return;
    }

    this.flowCancelled = false;
    this.deviceFlow = undefined;
    this.errorMessage = "";
    this.connectionMessage = "Preparando uma autorização segura com o GitHub...";
    this.connectionState = "starting";

    try {
      const flow = await this.githubService.startDeviceFlow();

      if (this.flowCancelled) {
        return;
      }

      this.deviceFlow = flow;
      this.connectionState = "waiting";
      this.connectionMessage = "Abra o GitHub, informe o código e autorize o OranGIT.";
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
      this.connectionMessage = "Não foi possível abrir o navegador. Use o endereço abaixo.";
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
      `Desconectar a conta @${connection.login} deste workspace?`,
    );

    if (!confirmed) {
      return;
    }

    try {
      await this.githubService.disconnect(connection);
      this.toastService.success(`@${connection.login} foi desconectado.`, "GitHub");
    } catch (error: unknown) {
      this.toastService.error(this.getErrorMessage(error), "GitHub");
    }
  }

  setDefault(connection: GithubConnection): void {
    this.githubService.setDefault(connection.workspaceId, connection.id);
    this.toastService.info(`@${connection.login} será usado como conta principal.`, "GitHub");
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
        this.connectionMessage = `Conta @${result.user.login} conectada com sucesso.`;
        this.deviceFlow = undefined;
        this.toastService.success(`@${result.user.login} está conectado ao workspace.`, "GitHub conectado");
        return;
      }

      if (result.status === "pending") {
        this.connectionMessage = "Ainda aguardando a autorização no GitHub...";
        continue;
      }

      if (result.status === "slowDown") {
        interval = Math.max((result.interval ?? interval / 1000) + 5, 5) * 1000;
        this.connectionMessage = "O GitHub pediu um intervalo maior entre as consultas...";
        continue;
      }

      throw new Error(this.deviceFlowError(result.status, result.message));
    }

    if (!this.flowCancelled) {
      throw new Error("O código de autorização expirou. Tente conectar novamente.");
    }
  }

  private deviceFlowError(status: string, message?: string): string {
    if (status === "denied") {
      return "A autorização foi cancelada no GitHub.";
    }

    if (status === "expired") {
      return "O código de autorização expirou. Tente conectar novamente.";
    }

    if (status === "disabled") {
      return "Ative o Device Flow nas configurações do GitHub App e tente novamente.";
    }

    return message ?? "Não foi possível concluir a autorização com o GitHub.";
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private getErrorMessage(error: unknown): string {
    return typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Não foi possível conectar ao GitHub.";
  }
}
