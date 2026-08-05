import { Component, computed, inject } from "@angular/core";
import { Router } from "@angular/router";
import { Repository } from "../../core/models/repository.model";
import { LayoutService } from "../../core/services/layout.service";
import { RepositoryService } from "../../core/services/repository.service";
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
  private readonly router = inject(Router);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly repositories = computed(() => {
    const workspaceId = this.workspaceService.activeWorkspace()?.id;

    return this.repositoryService
      .openRepositories()
      .filter((repository) => repository.workspaceId === workspaceId);
  });

  selectRepository(repository: Repository): void {
    this.repositoryService.setActive(repository);
    this.layoutService.closeMainSidebar();
    void this.router.navigate(["/overview"]);
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
      void this.router.navigate(["/overview"]);
    } else {
      this.layoutService.openMainSidebar();
      void this.router.navigate(["/repositories"]);
    }
  }

  repositoryLocation(repository: Repository): string {
    const normalizedPath = repository.path.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalizedPath.split("/").at(-1) || repository.path;
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
