import { computed, Injectable, signal } from "@angular/core";
import { Workspace } from "../models/workspace.model";

const STORAGE_KEY = "git-app.workspaces";
const ACTIVE_WORKSPACE_KEY = "git-app.active-workspace";

@Injectable({ providedIn: "root" })
export class WorkspaceService {
  private readonly workspacesState = signal<Workspace[]>(this.loadWorkspaces());
  private readonly activeWorkspaceIdState = signal<string>(
    this.loadActiveWorkspaceId(this.workspacesState()),
  );

  readonly workspaces = this.workspacesState.asReadonly();
  readonly activeWorkspace = computed(() => {
    const workspaces = this.workspacesState();
    return (
      workspaces.find((workspace) => workspace.id === this.activeWorkspaceIdState()) ??
      workspaces[0]
    );
  });

  create(name: string, description: string): Workspace | undefined {
    const normalizedName = name.trim();

    if (!normalizedName) {
      return undefined;
    }

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: this.createId(),
      name: normalizedName,
      description: description.trim(),
      color: this.getNextColor(),
      repositoryPaths: [],
      createdAt: now,
      updatedAt: now,
    };

    this.setWorkspaces([...this.workspacesState(), workspace]);
    this.select(workspace.id);
    return workspace;
  }

  update(id: string, name: string, description: string): boolean {
    const normalizedName = name.trim();

    if (!normalizedName) {
      return false;
    }

    const exists = this.workspacesState().some((workspace) => workspace.id === id);

    if (!exists) {
      return false;
    }

    const now = new Date().toISOString();
    this.setWorkspaces(
      this.workspacesState().map((workspace) =>
        workspace.id === id
          ? { ...workspace, name: normalizedName, description: description.trim(), updatedAt: now }
          : workspace,
      ),
    );
    return true;
  }

  select(id: string): void {
    if (!this.workspacesState().some((workspace) => workspace.id === id)) {
      return;
    }

    this.activeWorkspaceIdState.set(id);
    this.persistActiveWorkspace(id);
  }

  remove(id: string): boolean {
    const workspaces = this.workspacesState();

    if (workspaces.length <= 1 || !workspaces.some((workspace) => workspace.id === id)) {
      return false;
    }

    const remaining = workspaces.filter((workspace) => workspace.id !== id);
    const activeId = this.activeWorkspaceIdState();
    this.setWorkspaces(remaining);

    if (activeId === id) {
      this.select(remaining[0].id);
    }

    return true;
  }

  private loadWorkspaces(): Workspace[] {
    if (typeof localStorage !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);

        if (saved) {
          const parsed = JSON.parse(saved) as unknown;

          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed as Workspace[];
          }
        }
      } catch {
        // Usa os workspaces iniciais quando o armazenamento estiver inválido.
      }
    }

    return this.createDefaultWorkspaces();
  }

  private loadActiveWorkspaceId(workspaces: Workspace[]): string {
    const savedId = typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_WORKSPACE_KEY) : null;
    return workspaces.some((workspace) => workspace.id === savedId) ? savedId! : workspaces[0].id;
  }

  private createDefaultWorkspaces(): Workspace[] {
    const now = new Date().toISOString();

    return [
      {
        id: "personal",
        name: "Pessoal",
        description: "Projetos e estudos pessoais",
        color: "#f97316",
        repositoryPaths: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "work",
        name: "Trabalho",
        description: "Projetos profissionais",
        color: "#38bdf8",
        repositoryPaths: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "projects",
        name: "Projetos",
        description: "Projetos paralelos",
        color: "#a78bfa",
        repositoryPaths: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private setWorkspaces(workspaces: Workspace[]): void {
    this.workspacesState.set(workspaces);

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
    }
  }

  private persistActiveWorkspace(id: string): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
    }
  }

  private createId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return `workspace-${Date.now()}`;
  }

  private getNextColor(): string {
    const colors = ["#f97316", "#38bdf8", "#a78bfa", "#34d399", "#f472b6"];
    return colors[this.workspacesState().length % colors.length];
  }
}
