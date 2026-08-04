import { Component, inject, OnInit, signal } from "@angular/core";
import { Commit } from "../../../core/models/commit.model";
import { RepositoryService } from "../../../core/services/repository.service";

@Component({
  selector: "app-history-page",
  templateUrl: "./history-page.component.html",
  styleUrl: "./history-page.component.css",
})
export class HistoryPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly commits = signal<Commit[]>([]);
  readonly isLoading = signal(true);
  readonly errorMessage = signal("");

  ngOnInit(): void {
    void this.loadCommits();
  }

  async loadCommits(): Promise<void> {
    const repository = this.activeRepository();
    if (!repository) {
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set("");

    try {
      this.commits.set(await this.repositoryService.getCommits(repository.path));
    } catch {
      this.errorMessage.set("Não foi possível carregar o histórico deste repositório.");
    } finally {
      this.isLoading.set(false);
    }
  }

  formatDate(date: string): string {
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
      return date;
    }

    return parsedDate.toLocaleString("pt-BR", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
}
