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
  private attachedKey: string | undefined;

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    const path = route.routeConfig?.path;
    return !!path && REUSABLE_ROUTES.has(path);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.getRouteKey(route);
    if (!key) {
      return;
    }

    if (this.attachedKey === key) {
      this.attachedKey = undefined;
    }

    if (!handle) {
      this.handles.delete(key);
      return;
    }

    const previousHandle = this.handles.get(key);
    if (previousHandle && previousHandle !== handle) {
      // Substituir um handle sem destruir o anterior deixava componentes
      // antigos vivos (com efeitos e assinaturas de rota) para sempre.
      this.destroyHandle(previousHandle);
    }

    this.handles.set(key, handle);
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const key = this.getRouteKey(route);
    return !!key && this.handles.has(key);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const key = this.getRouteKey(route);
    if (!key) {
      return null;
    }

    this.attachedKey = key;
    return this.handles.get(key) ?? null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }

  /**
   * Descarta as páginas guardadas, destruindo as que estão soltas. O handle
   * atualmente exibido é preservado, pois ainda está ligado ao router-outlet.
   */
  clearHandles(): void {
    for (const [key, handle] of this.handles) {
      if (key !== this.attachedKey) {
        this.destroyHandle(handle);
      }
    }

    this.handles.clear();
  }

  clearHandle(path: string): void {
    const handle = this.handles.get(path);

    if (handle && path !== this.attachedKey) {
      this.destroyHandle(handle);
    }

    this.handles.delete(path);
  }

  private destroyHandle(handle: DetachedRouteHandle | null): void {
    const componentRef = (handle as unknown as { componentRef?: { destroy(): void } } | null)
      ?.componentRef;

    componentRef?.destroy();
  }

  private getRouteKey(route: ActivatedRouteSnapshot): string | undefined {
    return route.routeConfig?.path;
  }
}
