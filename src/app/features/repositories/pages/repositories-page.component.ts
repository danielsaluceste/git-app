import { Component, computed, inject } from "@angular/core";
import { Router } from "@angular/router";
import { open } from "@tauri-apps/plugin-dialog";
import { LayoutService } from "../../../core/services/layout.service";
import { Repository } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { WorkspaceService } from "../../../core/services/workspace.service";

@Component({
  selector: "app-repositories-page",
  templateUrl: "./repositories-page.component.html",
  styleUrl: "./repositories-page.component.css",
})
export class RepositoriesPageComponent {
  private readonly repositoryService = inject(RepositoryService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly router = inject(Router);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);

  readonly activeWorkspace = this.workspaceService.activeWorkspace;
  readonly repositories = computed(() =>
    this.repositoryService
      .repositories()
      .filter((repository) => repository.workspaceId === this.activeWorkspace().id),
  );

  isLoading = false;

  async addLocalRepository(): Promise<void> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Adicionar repositório local",
      });

      if (typeof selected !== "string") {
        return;
      }

      this.isLoading = true;
      const repositoryInfo = await this.repositoryService.inspectLocalRepository(selected);
      const added = this.repositoryService.add({
        name: repositoryInfo.name,
        path: repositoryInfo.path,
        workspaceId: this.activeWorkspace().id,
      });

      if (!added) {
        this.toastService.warning("Este repositório já está adicionado neste workspace.", "Repositório duplicado");
      } else {
        this.toastService.success("Repositório adicionado ao workspace.", "Repositório adicionado");
      }
    } catch (error: unknown) {
      this.toastService.error(
        typeof error === "string"
          ? error
          : "Não foi possível adicionar a pasta. Selecione um repositório Git válido.",
        "Repositório local",
      );
    } finally {
      this.isLoading = false;
    }
  }

  openRepository(repository: Repository): void {
    this.repositoryService.setActive(repository);
    this.layoutService.closeMainSidebar();
    void this.router.navigate(["/overview"]);
  }

  trackRepository(_index: number, repository: Repository): string {
    return `${repository.workspaceId}:${repository.path}`;
  }
}
