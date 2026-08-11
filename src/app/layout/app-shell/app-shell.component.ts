import { Component, DestroyRef, HostListener, inject, OnDestroy } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router, RouterOutlet } from "@angular/router";
import { filter } from "rxjs";
import { LayoutService } from "../../core/services/layout.service";
import { RepositoryService } from "../../core/services/repository.service";
import { SessionService } from "../../core/services/session.service";
import { RepositorySidebarComponent } from "../repository-sidebar/repository-sidebar.component";
import { RepositoryTabsComponent } from "../repository-tabs/repository-tabs.component";
import { SidebarComponent } from "../sidebar/sidebar.component";
import { TopbarComponent } from "../topbar/topbar.component";
import { ToastContainerComponent } from "../../shared/components/toast-container/toast-container.component";

@Component({
  selector: "app-shell",
  imports: [
    RepositorySidebarComponent,
    RepositoryTabsComponent,
    RouterOutlet,
    SidebarComponent,
    TopbarComponent,
    ToastContainerComponent,
  ],
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.css",
})
export class AppShellComponent implements OnDestroy {
  private readonly repositoryRefreshInterval = 30_000;
  private readonly layoutService = inject(LayoutService);
  private readonly repositoryService = inject(RepositoryService);
  private readonly sessionService = inject(SessionService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly storedLastRoute = this.sessionService.lastRoute();
  private readonly repositoryRefreshTimer: ReturnType<typeof setInterval>;
  private repositoryRefreshInFlight = false;
  private sessionRestored = false;

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly mainSidebarOpen = this.layoutService.mainSidebarOpen;

  constructor() {
    this.repositoryRefreshTimer = setInterval(
      () => this.refreshActiveRepository(),
      this.repositoryRefreshInterval,
    );

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        if (!this.sessionRestored) {
          this.sessionRestored = true;
          this.restoreSession();
        }

        this.sessionService.rememberLastRoute(event.urlAfterRedirects);
        const repository = this.activeRepository();

        if (repository) {
          this.sessionService.rememberRepositoryRoute(repository, event.urlAfterRedirects);
        }
      });
  }

  ngOnDestroy(): void {
    clearInterval(this.repositoryRefreshTimer);
  }

  @HostListener("window:focus")
  onWindowFocus(): void {
    this.refreshActiveRepository();
  }

  @HostListener("document:visibilitychange")
  onVisibilityChange(): void {
    if (document.visibilityState === "visible") {
      this.refreshActiveRepository();
    }
  }

  openMainSidebar(): void {
    this.layoutService.openMainSidebar();
  }

  closeMainSidebar(): void {
    this.layoutService.closeMainSidebar();
  }

  private refreshActiveRepository(): void {
    if (document.visibilityState === "hidden" || this.repositoryRefreshInFlight) {
      return;
    }

    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.repositoryRefreshInFlight = true;
    void this.repositoryService
      .refreshAfterRepositoryOpened(repository)
      .catch(() => undefined)
      .finally(() => {
        this.repositoryRefreshInFlight = false;
      });
  }

  private restoreSession(): void {
    const lastRoute = this.storedLastRoute;

    if (!lastRoute || !this.sessionService.isRepositoryRoute(lastRoute)) {
      return;
    }

    const repository = this.repositoryService.restoreActiveRepository();

    if (!repository) {
      return;
    }

    this.layoutService.closeMainSidebar();

    if (this.router.url !== lastRoute) {
      void this.router.navigateByUrl(lastRoute)
        .then(() => this.repositoryService.refreshAfterRepositoryOpened(repository))
        .catch(() => undefined);
    } else {
      void this.repositoryService.refreshAfterRepositoryOpened(repository).catch(() => undefined);
    }
  }
}
