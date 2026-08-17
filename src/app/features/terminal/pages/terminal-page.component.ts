import {
  Component,
  HostListener,
  inject,
  OnInit,
  QueryList,
  signal,
  ViewChildren,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { RepositoryService } from "../../../core/services/repository.service";
import { TerminalService } from "../../../core/services/terminal.service";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";
import { TerminalViewComponent } from "../components/terminal-view/terminal-view.component";

@Component({
  selector: "app-terminal-page",
  imports: [FormsModule, TerminalViewComponent, TranslatePipe],
  templateUrl: "./terminal-page.component.html",
  styleUrl: "./terminal-page.component.css",
})
export class TerminalPageComponent implements OnInit {
  private readonly repositoryService = inject(RepositoryService);
  private readonly terminalService = inject(TerminalService);

  @ViewChildren(TerminalViewComponent)
  terminalViews!: QueryList<TerminalViewComponent>;

  readonly activeRepository = this.repositoryService.activeRepository;
  readonly tabs = this.terminalService.tabs;
  readonly activeTabId = this.terminalService.activeTabId;
  readonly availableShells = this.terminalService.availableShells;

  readonly showShellMenu = signal(false);

  ngOnInit(): void {
    // If no tabs exist, create one in the active repository
    if (this.tabs().length === 0) {
      const path = this.activeRepository()?.path || "";
      void this.terminalService.createTab(path);
    }
  }

  selectTab(tabId: string): void {
    this.terminalService.setActiveTab(tabId);
    setTimeout(() => this.fitActiveTerminal(), 50);
  }

  closeTab(tabId: string, event?: Event): void {
    event?.stopPropagation();
    void this.terminalService.closeTab(tabId);
  }

  createTab(shellId?: string): void {
    this.showShellMenu.set(false);
    const path = this.activeRepository()?.path || "";
    void this.terminalService.createTab(path, shellId);
  }

  toggleShellMenu(event: Event): void {
    event.stopPropagation();
    this.showShellMenu.update((v) => !v);
  }

  restartActiveTab(): void {
    const activeId = this.activeTabId();
    if (activeId) {
      void this.terminalService.restartTab(activeId);
    }
  }

  clearActiveTab(): void {
    const activeId = this.activeTabId();
    const activeView = this.terminalViews.find((v) => v.tab.id === activeId);
    activeView?.clear();
  }

  @HostListener("document:click")
  onDocumentClick(): void {
    if (this.showShellMenu()) {
      this.showShellMenu.set(false);
    }
  }

  private fitActiveTerminal(): void {
    const activeId = this.activeTabId();
    const activeView = this.terminalViews.find((v) => v.tab.id === activeId);
    activeView?.fit();
    activeView?.focus();
  }
}
