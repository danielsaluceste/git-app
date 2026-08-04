import { Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { LayoutService } from "../../core/services/layout.service";
import { RepositoryService } from "../../core/services/repository.service";
import { RepositorySidebarComponent } from "../repository-sidebar/repository-sidebar.component";
import { SidebarComponent } from "../sidebar/sidebar.component";
import { StatusBarComponent } from "../status-bar/status-bar.component";
import { TopbarComponent } from "../topbar/topbar.component";

@Component({
  selector: "app-shell",
  imports: [
    RepositorySidebarComponent,
    RouterOutlet,
    SidebarComponent,
    StatusBarComponent,
    TopbarComponent,
  ],
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.css",
})
export class AppShellComponent {
  private readonly layoutService = inject(LayoutService);
  private readonly repositoryService = inject(RepositoryService);

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly mainSidebarOpen = this.layoutService.mainSidebarOpen;

  openMainSidebar(): void {
    this.layoutService.openMainSidebar();
  }

  closeMainSidebar(): void {
    this.layoutService.closeMainSidebar();
  }
}
