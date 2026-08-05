import { computed, inject, Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  GithubConnection,
  GithubDeviceFlowPoll,
  GithubDeviceFlowStart,
  GithubRepository,
  GithubUser,
} from "../models/github.model";
import { WorkspaceService } from "./workspace.service";

const STORAGE_KEY = "git-app.github-connections";
export const GITHUB_APP_CLIENT_ID = "Iv23li0fn5GF5PxdgV0v";

@Injectable({ providedIn: "root" })
export class GithubService {
  private readonly workspaceService = inject(WorkspaceService);
  private readonly connectionsState = signal<GithubConnection[]>(this.loadConnections());

  readonly connections = this.connectionsState.asReadonly();
  readonly workspaceConnections = computed(() => {
    const workspaceId = this.workspaceService.activeWorkspace().id;
    return this.connectionsState().filter((connection) => connection.workspaceId === workspaceId);
  });

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

  addConnection(workspaceId: string, user: GithubUser): GithubConnection {
    const existing = this.connectionsState().find(
      (connection) => connection.workspaceId === workspaceId && connection.id === user.id,
    );

    if (existing) {
      return existing;
    }

    const workspaceConnections = this.connectionsState().filter(
      (connection) => connection.workspaceId === workspaceId,
    );
    const connection: GithubConnection = {
      ...user,
      workspaceId,
      connectedAt: new Date().toISOString(),
      isDefault: workspaceConnections.length === 0,
    };

    this.setConnections([...this.connectionsState(), connection]);
    return connection;
  }

  setDefault(workspaceId: string, userId: number): void {
    this.setConnections(
      this.connectionsState().map((connection) =>
        connection.workspaceId === workspaceId
          ? { ...connection, isDefault: connection.id === userId }
          : connection,
      ),
    );
  }

  async disconnect(connection: GithubConnection): Promise<void> {
    await invoke("disconnect_account", {
      workspaceId: connection.workspaceId,
      userId: connection.id,
    });

    this.setConnections(
      this.connectionsState().filter(
        (item) =>
          !(item.workspaceId === connection.workspaceId && item.id === connection.id),
      ),
    );

    const remaining = this.connectionsState().filter(
      (item) => item.workspaceId === connection.workspaceId,
    );

    if (remaining.length > 0 && !remaining.some((item) => item.isDefault)) {
      this.setDefault(connection.workspaceId, remaining[0].id);
    }
  }

  private loadConnections(): GithubConnection[] {
    if (typeof localStorage === "undefined") {
      return [];
    }

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsed = saved ? (JSON.parse(saved) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as GithubConnection[]) : [];
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
