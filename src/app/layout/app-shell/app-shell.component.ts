import { Component, DestroyRef, HostListener, inject, OnDestroy, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router, RouterOutlet } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { filter } from "rxjs";
import { LayoutService } from "../../core/services/layout.service";
import { RepositoryService } from "../../core/services/repository.service";
import { SessionService } from "../../core/services/session.service";
import { TerminalService } from "../../core/services/terminal.service";
import { ToastService } from "../../core/services/toast.service";
import { TranslationService } from "../../core/services/translation.service";
import { UpdateService } from "../../core/services/update.service";
import { RepositorySidebarComponent } from "../repository-sidebar/repository-sidebar.component";
import { RepositoryTabsComponent } from "../repository-tabs/repository-tabs.component";
import { SidebarComponent } from "../sidebar/sidebar.component";
import { TopbarComponent } from "../topbar/topbar.component";
import { CommandPaletteComponent } from "../command-palette/command-palette.component";
import { ToastContainerComponent } from "../../shared/components/toast-container/toast-container.component";
import { TerminalDrawerComponent } from "../../features/terminal/components/terminal-drawer/terminal-drawer.component";
import { TranslatePipe } from "../../shared/pipes/translate.pipe";

@Component({
  selector: "app-shell",
  imports: [
    RepositorySidebarComponent,
    RepositoryTabsComponent,
    RouterOutlet,
    SidebarComponent,
    TopbarComponent,
    ToastContainerComponent,
    TerminalDrawerComponent,
    CommandPaletteComponent,
    TranslatePipe,
  ],
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.css",
})
export class AppShellComponent implements OnDestroy {
  private readonly repositoryRefreshInterval = 30_000;
  private readonly layoutService = inject(LayoutService);
  private readonly repositoryService = inject(RepositoryService);
  private readonly sessionService = inject(SessionService);
  private readonly terminalService = inject(TerminalService);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);
  private readonly updateService = inject(UpdateService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly storedLastRoute = this.sessionService.lastRoute();
  private readonly repositoryRefreshTimer: ReturnType<typeof setInterval>;
  private readonly initialUpdateCheckTimer: ReturnType<typeof setTimeout>;
  private readonly updateCheckTimer: ReturnType<typeof setInterval>;
  private readonly updateCheckInterval = 24 * 60 * 60 * 1000;
  private readonly minimumRefreshGap = 2_000;
  private repositoryRefreshInFlight = false;
  private lastRepositoryRefreshAt = 0;
  private sessionRestored = false;

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly mainSidebarOpen = this.layoutService.mainSidebarOpen;
  readonly terminalDrawerOpen = this.terminalService.isDrawerOpen;
  readonly updateAvailable = this.updateService.updateAvailable;
  readonly updateState = this.updateService.state;
  readonly updateVersion = this.updateService.availableVersion;
  readonly updateNotes = this.updateService.notes;
  readonly updateProgress = this.updateService.progress;
  readonly updateDialogOpen = signal(false);

  constructor() {
    this.repositoryRefreshTimer = setInterval(
      () => this.refreshActiveRepository(),
      this.repositoryRefreshInterval,
    );
    this.initialUpdateCheckTimer = setTimeout(() => void this.updateService.check(), 4_000);
    this.updateCheckTimer = setInterval(
      () => void this.updateService.check(),
      this.updateCheckInterval,
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
    clearTimeout(this.initialUpdateCheckTimer);
    clearInterval(this.updateCheckTimer);
  }

  @HostListener("window:focus")
  onWindowFocus(): void {
    this.refreshActiveRepository();
    void this.updateService.check();
  }

  @HostListener("document:visibilitychange")
  onVisibilityChange(): void {
    if (document.visibilityState === "visible") {
      this.refreshActiveRepository();
      void this.updateService.check();
    }
  }

  openMainSidebar(): void {
    this.layoutService.openMainSidebar();
  }

  closeMainSidebar(): void {
    this.layoutService.closeMainSidebar();
  }

  toggleTerminalDrawer(): void {
    if (this.activeRepository()) {
      this.terminalService.toggleDrawer();
    }
  }

  closeTerminalDrawer(): void {
    this.terminalService.closeDrawer();
  }

  openUpdateDialog(): void {
    if (this.updateAvailable()) {
      this.updateDialogOpen.set(true);
    }
  }

  closeUpdateDialog(): void {
    if (this.updateState() !== "downloading") {
      this.updateDialogOpen.set(false);
    }
  }

  async installUpdate(): Promise<void> {
    if (this.updateState() === "downloading") {
      return;
    }

    try {
      await this.updateService.install();
    } catch (error) {
      console.error("Não foi possível instalar a atualização do GitLuna.", error);
      this.toastService.error(
        this.translationService.translate("updates.installError"),
        this.translationService.translate("updates.title"),
      );
    }
  }

  async relaunchAfterUpdate(): Promise<void> {
    try {
      await this.updateService.relaunch();
    } catch (error) {
      console.error("Não foi possível reiniciar o GitLuna.", error);
      this.toastService.error(
        this.translationService.translate("updates.restartError"),
        this.translationService.translate("updates.title"),
      );
    }
  }

  @HostListener("window:keydown", ["$event"])
  onWindowKeydown(event: KeyboardEvent): void {
    const isModifier = event.ctrlKey || event.metaKey;

    if (event.key === "F12" || (isModifier && event.shiftKey && event.key.toLowerCase() === "i")) {
      event.preventDefault();
      void invoke("toggle_devtools").catch(() => undefined);
      return;
    }

    if (isModifier && (event.key === "`" || event.key === "'")) {
      if (this.activeRepository()) {
        event.preventDefault();
        this.toggleTerminalDrawer();
      }
    }
  }

  private refreshActiveRepository(): void {
    if (document.visibilityState === "hidden" || this.repositoryRefreshInFlight) {
      return;
    }

    const now = Date.now();
    if (now - this.lastRepositoryRefreshAt < this.minimumRefreshGap) {
      return;
    }

    const repository = this.activeRepository();
    if (!repository) {
      return;
    }

    this.lastRepositoryRefreshAt = now;
    this.repositoryRefreshInFlight = true;
    void this.repositoryService
      .refreshAutomatically(repository)
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
