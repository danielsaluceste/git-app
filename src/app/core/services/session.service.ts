import { Injectable } from "@angular/core";
import { Repository } from "../models/repository.model";

const SESSION_KEY = "git-app.session";

interface StoredSession {
  lastRoute?: string;
  repositoryRoutes?: Record<string, string>;
}

@Injectable({ providedIn: "root" })
export class SessionService {
  private readonly session: StoredSession = this.loadSession();

  lastRoute(): string | undefined {
    return this.session.lastRoute;
  }

  rememberLastRoute(url: string): void {
    const route = this.normalizeRoute(url);

    if (!route || route === "/") {
      return;
    }

    this.session.lastRoute = route;
    this.persist();
  }

  routeFor(repository: Repository): string | undefined {
    const route = this.session.repositoryRoutes?.[this.repositoryKey(repository)];
    return route && this.isRepositoryRoute(route) ? route : undefined;
  }

  rememberRepositoryRoute(repository: Repository, url: string): void {
    const route = this.normalizeRoute(url);

    if (!this.isRepositoryRoute(route)) {
      return;
    }

    this.session.repositoryRoutes ??= {};
    this.session.repositoryRoutes[this.repositoryKey(repository)] = route;
    this.persist();
  }

  isRepositoryRoute(url: string): boolean {
    const route = this.normalizeRoute(url);
    return [
      "/overview",
      "/changes",
      "/stashes",
      "/branches",
      "/repository-settings",
    ].includes(route);
  }

  private repositoryKey(repository: Repository): string {
    return `${repository.workspaceId}:${this.normalizePath(repository.path)}`;
  }

  private normalizeRoute(url: string): string {
    const route = url.split(/[?#]/, 1)[0] || "/";
    return route.startsWith("/") ? route : `/${route}`;
  }

  private normalizePath(path: string): string {
    return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }

  private loadSession(): StoredSession {
    if (typeof localStorage === "undefined") {
      return {};
    }

    try {
      const saved = localStorage.getItem(SESSION_KEY);
      const parsed = saved ? (JSON.parse(saved) as unknown) : {};

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      const value = parsed as StoredSession;
      return {
        lastRoute: typeof value.lastRoute === "string" ? value.lastRoute : undefined,
        repositoryRoutes:
          value.repositoryRoutes && typeof value.repositoryRoutes === "object"
            ? value.repositoryRoutes
            : {},
      };
    } catch {
      return {};
    }
  }

  private persist(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    }
  }
}
