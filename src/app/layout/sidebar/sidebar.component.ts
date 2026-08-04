import { Component, EventEmitter, HostBinding, inject, Input, Output } from "@angular/core";
import { RouterLink, RouterLinkActive } from "@angular/router";
import { RepositoryService } from "../../core/services/repository.service";

@Component({
  selector: "app-sidebar",
  imports: [RouterLink, RouterLinkActive],
  templateUrl: "./sidebar.component.html",
  styleUrl: "./sidebar.component.css",
})
export class SidebarComponent {
  private readonly repositoryService = inject(RepositoryService);

  @Input() collapsed = false;
  @Output() toggleRequested = new EventEmitter<void>();

  @HostBinding("class.collapsed")
  get collapsedClass(): boolean {
    return this.collapsed;
  }

  closeCurrentRepository(): void {
    this.repositoryService.setActive(undefined);
  }
}
