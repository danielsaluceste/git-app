import { Component, inject, OnInit, signal } from "@angular/core";
import { RepositoryReferences } from "../../../core/models/repository.model";
import { RepositoryService } from "../../../core/services/repository.service";

@Component({
  selector: "app-branches-page",
  templateUrl: "./branches-page.component.html",
  styleUrl: "./branches-page.component.css",
})
export class BranchesPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly references = signal<RepositoryReferences | undefined>(undefined);
  readonly isLoading = signal(true);
  readonly errorMessage = signal("");

  ngOnInit(): void {
    void this.loadReferences();
  }

  async loadReferences(): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set("");

    try {
      this.references.set(await this.repositoryService.getReferences(repository.path));
    } catch {
      this.errorMessage.set("Não foi possível carregar as referências deste repositório.");
    } finally {
      this.isLoading.set(false);
    }
  }
}
