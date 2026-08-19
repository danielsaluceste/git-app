import { Injectable } from "@angular/core";
import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from "@angular/router";

const REUSABLE_ROUTES = new Set([
  "overview",
  "changes",
  "branches",
  "stashes",
  "terminal",
]);

@Injectable({ providedIn: "root" })
export class AppRouteReuseStrategy implements RouteReuseStrategy {
  private readonly handles = new Map<string, DetachedRouteHandle>();

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    const path = route.routeConfig?.path;
    return !!path && REUSABLE_ROUTES.has(path);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.getRouteKey(route);
    if (!key) {
      return;
    }

    if (handle) {
      this.handles.set(key, handle);
    } else {
      this.handles.delete(key);
    }
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const key = this.getRouteKey(route);
    return !!key && this.handles.has(key);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const key = this.getRouteKey(route);
    return key ? (this.handles.get(key) ?? null) : null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }

  clearHandles(): void {
    this.handles.clear();
  }

  clearHandle(path: string): void {
    this.handles.delete(path);
  }

  private getRouteKey(route: ActivatedRouteSnapshot): string | undefined {
    return route.routeConfig?.path;
  }
}
