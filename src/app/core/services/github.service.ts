import { computed, inject, Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  GithubConnection,
  GithubConnectionMode,
  GithubDeviceFlowPoll,
  GithubDeviceFlowStart,
  GithubRepository,
  GithubSshDetails,
  GithubSshKey,
  GithubSshProbe,
  GithubUser,
} from "../models/github.model";
import { WorkspaceService } from "./workspace.service";

const STORAGE_KEY = "git-app.github-connections";
export const GITHUB_APP_CLIENT_ID = "Iv23li0fn5GF5PxdgV0v";

/**
 * Conexões SSH não têm o id numérico do GitHub (o App é quem fornece esse id).
 * Para manter o mesmo formato de identificador, o id é derivado do login dentro
 * de uma faixa alta, que fica acima dos ids reais do GitHub.
 */
const SSH_CONNECTION_ID_OFFSET = 9_000_000_000;

@Injectable({ providedIn: "root" })
export class GithubService {
  private readonly workspaceService = inject(WorkspaceService);
  private readonly connectionsState = signal<GithubConnection[]>(this.loadConnections());

  readonly connections = this.connectionsState.asReadonly();
  readonly workspaceConnections = computed(() => {
    const workspaceId = this.workspaceService.activeWorkspace().id;
    return this.connectionsState().filter((connection) => connection.workspaceId === workspaceId);
  });
  readonly appConnections = computed(() =>
    this.workspaceConnections().filter((connection) => connection.mode === "app"),
  );
  readonly sshConnections = computed(() =>
    this.workspaceConnections().filter((connection) => connection.mode === "ssh"),
  );

  startDeviceFlow(): Promise<GithubDeviceFlowStart> {
    return invoke<GithubDeviceFlowStart>("start_device_flow", {
      clientId: GITHUB_APP_CLIENT_ID,
    });
  }

  pollDeviceFlow(
    deviceCode: string,
    workspaceId: string,
  ): Promise<GithubDeviceFlowPoll> {
    return invoke<GithubDeviceFlowPoll>("poll_device_flow", {
      clientId: GITHUB_APP_CLIENT_ID,
      deviceCode,
      workspaceId,
    });
  }

  listRepositories(workspaceId: string, userId: number): Promise<GithubRepository[]> {
    return invoke<GithubRepository[]>("list_repositories", { workspaceId, userId });
  }

  listSshKeys(): Promise<GithubSshKey[]> {
    return invoke<GithubSshKey[]>("list_ssh_keys");
  }

  generateSshKey(): Promise<GithubSshKey> {
    return invoke<GithubSshKey>("generate_ssh_key");
  }

  probeSsh(keyPath?: string): Promise<GithubSshProbe> {
    return invoke<GithubSshProbe>("probe_github_ssh", { keyPath: keyPath ?? null });
  }

  async deleteSshKey(path: string): Promise<void> {
    await invoke("delete_ssh_key", { path });
  }

  addConnection(workspaceId: string, user: GithubUser): GithubConnection {
    const existing = this.connectionsState().find(
      (connection) =>
        connection.workspaceId === workspaceId &&
        connection.mode === "app" &&
        connection.id === user.id,
    );

    if (existing) {
      return existing;
    }

    const connection: GithubConnection = {
      ...user,
      workspaceId,
      connectedAt: new Date().toISOString(),
      isDefault: this.isFirstConnection(workspaceId),
      mode: "app",
    };

    this.setConnections([...this.connectionsState(), connection]);
    return connection;
  }

  /**
   * Registra uma conexão SSH confirmada. A conta é identificada pelo login
   * devolvido pelo próprio OpenSSH, sem depender da API do GitHub.
   */
  addSshConnection(
    workspaceId: string,
    login: string,
    ssh: GithubSshDetails,
  ): GithubConnection {
    const normalizedLogin = login.trim();
    const id = this.sshConnectionId(normalizedLogin);
    const existing = this.connectionsState().find(
      (connection) =>
        connection.workspaceId === workspaceId &&
        connection.mode === "ssh" &&
        connection.id === id,
    );

    if (existing) {
      const updated: GithubConnection = {
        ...existing,
        login: normalizedLogin,
        avatarUrl: this.sshAvatarUrl(normalizedLogin),
        htmlUrl: `https://github.com/${normalizedLogin}`,
        ssh,
      };

      this.setConnections(
        this.connectionsState().map((connection) =>
          connection.workspaceId === workspaceId &&
          connection.mode === "ssh" &&
          connection.id === id
            ? updated
            : connection,
        ),
      );

      return updated;
    }

    const connection: GithubConnection = {
      id,
      login: normalizedLogin,
      avatarUrl: this.sshAvatarUrl(normalizedLogin),
      htmlUrl: `https://github.com/${normalizedLogin}`,
      workspaceId,
      connectedAt: new Date().toISOString(),
      isDefault: this.isFirstConnection(workspaceId),
      mode: "ssh",
      ssh,
    };

    this.setConnections([...this.connectionsState(), connection]);
    return connection;
  }

  findConnection(
    workspaceId: string,
    connectionId: number,
    mode: GithubConnectionMode,
  ): GithubConnection | undefined {
    return this.connectionsState().find(
      (connection) =>
        connection.workspaceId === workspaceId &&
        connection.mode === mode &&
        connection.id === connectionId,
    );
  }

  /** Caminho da chave privada usada por uma conexão SSH (vazio = SSH do computador). */
  sshKeyPathFor(workspaceId: string, connectionId: number): string | undefined {
    return this.findConnection(workspaceId, connectionId, "ssh")?.ssh?.keyPath;
  }

  setDefault(connection: GithubConnection): void {
    this.setConnections(
      this.connectionsState().map((item) =>
        item.workspaceId === connection.workspaceId
          ? {
              ...item,
              isDefault: item.mode === connection.mode && item.id === connection.id,
            }
          : item,
      ),
    );
  }

  async disconnect(connection: GithubConnection): Promise<void> {
    // Somente conexões do GitHub App têm token no keyring; a conexão SSH vive
    // apenas neste registro e a chave continua no computador.
    if (connection.mode === "app") {
      await invoke("disconnect_account", {
        workspaceId: connection.workspaceId,
        userId: connection.id,
      });
    }

    this.setConnections(
      this.connectionsState().filter(
        (item) =>
          !(
            item.workspaceId === connection.workspaceId &&
            item.mode === connection.mode &&
            item.id === connection.id
          ),
      ),
    );

    const remaining = this.connectionsState().filter(
      (item) => item.workspaceId === connection.workspaceId,
    );

    if (remaining.length > 0 && !remaining.some((item) => item.isDefault)) {
      this.setDefault(remaining[0]);
    }
  }

  private isFirstConnection(workspaceId: string): boolean {
    return !this.connectionsState().some(
      (connection) => connection.workspaceId === workspaceId,
    );
  }

  private sshConnectionId(login: string): number {
    let hash = 0;

    for (const char of login.toLowerCase()) {
      hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_000;
    }

    return SSH_CONNECTION_ID_OFFSET + hash;
  }

  private sshAvatarUrl(login: string): string {
    return `https://github.com/${login}.png?size=96`;
  }

  private loadConnections(): GithubConnection[] {
    if (typeof localStorage === "undefined") {
      return [];
    }

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsed = saved ? (JSON.parse(saved) as unknown) : [];

      if (!Array.isArray(parsed)) {
        return [];
      }

      return (parsed as GithubConnection[]).map((connection) => ({
        ...connection,
        // Registros antigos não tinham o modo: todos eram do GitHub App.
        mode: connection.mode === "ssh" ? "ssh" : "app",
        isDefault: connection.isDefault === true,
      }));
    } catch {
      return [];
    }
  }

  private setConnections(connections: GithubConnection[]): void {
    this.connectionsState.set(connections);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
    }
  }
}
