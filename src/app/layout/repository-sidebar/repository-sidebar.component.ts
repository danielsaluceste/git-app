import { Component, inject, Input, OnInit, signal } from "@angular/core";
import { Router, RouterLink, RouterLinkActive } from "@angular/router";
import { LayoutService } from "../../core/services/layout.service";
import { Repository, RepositoryReferences } from "../../core/models/repository.model";
import { RepositoryService } from "../../core/services/repository.service";

type ReferenceSection = "local" | "remote" | "tags" | "stashes";

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

  readonly references = signal<RepositoryReferences>({
    localBranches: [],
    remoteBranches: [],
    tags: [],
    stashes: [],
  });
  readonly isLoadingReferences = signal(true);
  readonly referenceError = signal("");
  expandedSections: Record<ReferenceSection, boolean> = {
    local: true,
    remote: false,
    tags: false,
    stashes: false,
  };

  async ngOnInit(): Promise<void> {
    try {
      this.references.set(await this.repositoryService.getReferences(this.repository.path));
    } catch {
      this.referenceError.set("Não foi possível carregar as referências do Git.");
    } finally {
      this.isLoadingReferences.set(false);
    }
  }

  toggleSection(section: ReferenceSection): void {
    this.expandedSections[section] = !this.expandedSections[section];
  }

  closeRepository(): void {
    this.repositoryService.setActive(undefined);
    this.layoutService.openMainSidebar();
    void this.router.navigate(["/repositories"]);
  }
}
