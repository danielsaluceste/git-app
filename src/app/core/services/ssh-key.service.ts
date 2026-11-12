import { computed, inject, Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  SshConnection,
  SshConnectionTest,
  SshKey,
  SshKeyList,
} from "../models/ssh-key.model";
import { WorkspaceService } from "./workspace.service";

const STORAGE_KEY = "git-app.ssh-connections";

@Injectable({ providedIn: "root" })
export class SshKeyService {
  private readonly workspaceService = inject(WorkspaceService);
  private readonly connectionsState = signal<SshConnection[]>(this.loadConnections());

  readonly workspaceConnections = computed(() => {
    const workspaceId = this.workspaceService.activeWorkspace().id;
    return this.connectionsState().filter(
      (connection) => connection.workspaceId === workspaceId,
    );
  });

  listKeys(): Promise<SshKeyList> {
    return invoke<SshKeyList>("list_ssh_keys");
  }

  inspectKey(path: string): Promise<SshKey> {
    return invoke<SshKey>("inspect_ssh_key", { path });
  }

  createKey(name: string, comment?: string): Promise<SshKey> {
    return invoke<SshKey>("create_ssh_key", {
      name,
      comment: comment?.trim() || null,
    });
  }

  testConnection(keyPath: string): Promise<SshConnectionTest> {
    return invoke<SshConnectionTest>("test_ssh_connection", { keyPath });
  }

  addConnection(key: SshKey, login?: string): SshConnection {
    const workspaceId = this.workspaceService.activeWorkspace().id;
    const connection: SshConnection = {
      workspaceId,
      keyPath: key.path,
      keyName: key.name,
      fingerprint: key.fingerprint,
      publicKey: key.publicKey,
      connectedAt: new Date().toISOString(),
      login,
    };

    this.save([
      ...this.connectionsState().filter(
        (item) =>
          !(item.workspaceId === workspaceId && item.keyPath === key.path),
      ),
      connection,
    ]);

    return connection;
  }

  updateLogin(connection: SshConnection, login?: string): void {
    this.save(
      this.connectionsState().map((item) =>
        item.workspaceId === connection.workspaceId &&
        item.keyPath === connection.keyPath
          ? { ...item, login, connectedAt: new Date().toISOString() }
          : item,
      ),
    );
  }

  removeConnection(connection: SshConnection): void {
    this.save(
      this.connectionsState().filter(
        (item) =>
          !(
            item.workspaceId === connection.workspaceId &&
            item.keyPath === connection.keyPath
          ),
      ),
    );
  }

  private loadConnections(): SshConnection[] {
    if (typeof localStorage === "undefined") {
      return [];
    }

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsed = saved ? (JSON.parse(saved) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as SshConnection[]) : [];
    } catch {
      return [];
    }
  }

  private save(connections: SshConnection[]): void {
    this.connectionsState.set(connections);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
    }
  }
}
