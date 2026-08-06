import { Component, computed, HostListener, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { Repository } from "../../core/models/repository.model";
import { LayoutService } from "../../core/services/layout.service";
import { RepositoryService } from "../../core/services/repository.service";
import { SessionService } from "../../core/services/session.service";
import { WorkspaceService } from "../../core/services/workspace.service";

@Component({
  selector: "app-repository-tabs",
  templateUrl: "./repository-tabs.component.html",
  styleUrl: "./repository-tabs.component.css",
})
export class RepositoryTabsComponent {
  private readonly repositoryService = inject(RepositoryService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly layoutService = inject(LayoutService);
  private readonly sessionService = inject(SessionService);
  private readonly router = inject(Router);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly draggingRepository = signal<Repository | undefined>(undefined);
  readonly dragOverRepository = signal<Repository | undefined>(undefined);
  readonly dragOverAfter = signal(false);
  private pressedRepository: Repository | undefined;
  private dragStartX = 0;
  private dragStartY = 0;
  private suppressClickUntil = 0;
  readonly repositories = computed(() => {
    const workspaceId = this.workspaceService.activeWorkspace()?.id;

    return this.repositoryService
      .openRepositories()
      .filter((repository) => repository.workspaceId === workspaceId);
  });

  selectRepository(repository: Repository): void {
    if (Date.now() < this.suppressClickUntil) {
      return;
    }

    this.repositoryService.setActive(repository);
    this.layoutService.closeMainSidebar();
    void this.router.navigateByUrl(this.sessionService.routeFor(repository) ?? "/overview");
  }

  closeRepository(repository: Repository, event: Event): void {
    event.stopPropagation();

    const wasActive = this.isSameRepository(this.activeRepository(), repository);
    const nextRepository = this.repositoryService.closeOpenRepository(repository);

    if (!wasActive) {
      return;
    }

    if (nextRepository) {
      this.layoutService.closeMainSidebar();
      void this.router.navigateByUrl(this.sessionService.routeFor(nextRepository) ?? "/overview");
    } else {
      this.layoutService.openMainSidebar();
      void this.router.navigate(["/repositories"]);
    }
  }

  startPointerDrag(repository: Repository, event: PointerEvent): void {
    if (event.button !== 0 || this.isCloseButtonTarget(event.target)) {
      return;
    }

    this.pressedRepository = repository;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.draggingRepository.set(undefined);
    this.dragOverRepository.set(undefined);
    this.dragOverAfter.set(false);
  }

  @HostListener("document:pointermove", ["$event"])
  onPointerMove(event: PointerEvent): void {
    const pressedRepository = this.pressedRepository;
    if (!pressedRepository) {
      return;
    }

    const distance = Math.hypot(event.clientX - this.dragStartX, event.clientY - this.dragStartY);
    if (!this.draggingRepository() && distance < 6) {
      return;
    }

    if (!this.draggingRepository()) {
      this.draggingRepository.set(pressedRepository);
    }

    event.preventDefault();
    const targetTab = this.tabAtPoint(event.clientX, event.clientY);
    const targetRepository = this.repositoryForTab(targetTab);
    if (targetRepository && !this.isSameRepository(pressedRepository, targetRepository)) {
      this.dragOverRepository.set(targetRepository);
      const placeAfter = !!targetTab &&
        event.clientX >= targetTab.getBoundingClientRect().left + targetTab.offsetWidth / 2;
      this.dragOverAfter.set(placeAfter);
      this.repositoryService.reorderOpenRepository(pressedRepository, targetRepository, placeAfter);
    } else {
      this.dragOverRepository.set(undefined);
      this.dragOverAfter.set(false);
    }
  }

  @HostListener("document:pointerup", ["$event"])
  onPointerUp(_event: PointerEvent): void {
    const draggingRepository = this.draggingRepository();
    const wasDragging = !!draggingRepository;

    if (wasDragging) {
      this.suppressClickUntil = Date.now() + 300;
    }
    this.finishDragging();
  }

  @HostListener("document:pointercancel")
  onPointerCancel(): void {
    this.finishDragging();
  }

  finishDragging(): void {
    this.pressedRepository = undefined;
    this.draggingRepository.set(undefined);
    this.dragOverRepository.set(undefined);
    this.dragOverAfter.set(false);
  }

  private tabAtPoint(clientX: number, clientY: number): HTMLElement | undefined {
    const element = document.elementFromPoint(clientX, clientY);
    return element instanceof Element
      ? element.closest<HTMLElement>("[data-repository-tab-index]") ?? undefined
      : undefined;
  }

  private repositoryForTab(tab: HTMLElement | undefined): Repository | undefined {
    const index = tab ? Number(tab.dataset["repositoryTabIndex"]) : -1;

    return Number.isInteger(index) && index >= 0 ? this.repositories()[index] : undefined;
  }

  private isCloseButtonTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest(".repository-tab-close");
  }

  trackRepository(_index: number, repository: Repository): string {
    return `${repository.workspaceId}:${repository.path}`;
  }

  isSameRepository(
    first: Repository | undefined,
    second: Repository | undefined,
  ): boolean {
    return !!first && !!second && first.workspaceId === second.workspaceId &&
      first.path.replaceAll("\\", "/").toLowerCase() === second.path.replaceAll("\\", "/").toLowerCase();
  }
}
