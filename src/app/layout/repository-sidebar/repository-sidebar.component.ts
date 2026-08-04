import { Component, computed, inject, Input, OnInit, signal } from "@angular/core";
import { Router, RouterLink, RouterLinkActive } from "@angular/router";
import { LayoutService } from "../../core/services/layout.service";
import { Repository, RepositoryReferences } from "../../core/models/repository.model";
import { RepositoryService } from "../../core/services/repository.service";
import { ToastService } from "../../core/services/toast.service";

type ReferenceSection = "local" | "remote" | "tags" | "stashes";

const EMPTY_REFERENCES: RepositoryReferences = {
  localBranches: [],
  remoteBranches: [],
  tags: [],
  stashes: [],
};

@Component({
  selector: "app-repository-sidebar",
  imports: [RouterLink, RouterLinkActive],
  templateUrl: "./repository-sidebar.component.html",
  styleUrl: "./repository-sidebar.component.css",
})
export class RepositorySidebarComponent implements OnInit {
  @Input({ required: true }) repository!: Repository;

  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);

  readonly references = computed(() => this.repositoryService.repositoryReferences() ?? EMPTY_REFERENCES);
  readonly isLoadingReferences = signal(true);
  readonly changesCount = computed(() => this.repositoryService.repositoryStatus()?.files.length ?? 0);
  readonly aheadCount = computed(() => this.repositoryService.repositoryStatus()?.aheadCount ?? 0);
  readonly behindCount = computed(() => this.repositoryService.repositoryStatus()?.behindCount ?? 0);
  expandedSections: Record<ReferenceSection, boolean> = {
    local: true,
    remote: false,
    tags: false,
    stashes: false,
  };

  async ngOnInit(): Promise<void> {
    try {
      await this.repositoryService.getReferences(this.repository.path);
    } catch {
      this.toastService.error("Não foi possível carregar as referências do Git.", "Referências do Git");
    } finally {
      this.isLoadingReferences.set(false);
    }

    try {
      await this.repositoryService.getStatus(this.repository.path);
    } catch {
      // A página de alterações exibirá o erro detalhado se o status falhar.
    }
  }

  toggleSection(section: ReferenceSection): void {
    this.expandedSections[section] = !this.expandedSections[section];
  }

  syncPendingLabel(): string {
    const pending: string[] = [];
    if (this.aheadCount() > 0) {
      pending.push(`${this.aheadCount()} para enviar`);
    }
    if (this.behindCount() > 0) {
      pending.push(`${this.behindCount()} para baixar`);
    }

    return pending.join(" · ");
  }

  closeRepository(): void {
    this.repositoryService.setActive(undefined);
    this.layoutService.openMainSidebar();
    void this.router.navigate(["/repositories"]);
  }
}
