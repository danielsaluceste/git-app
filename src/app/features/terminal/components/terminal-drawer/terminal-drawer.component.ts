import {
  Component,
  ElementRef,
  HostListener,
  inject,
  signal,
  ViewChildren,
  QueryList,
} from "@angular/core";
import { Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { TerminalService } from "../../../../core/services/terminal.service";
import { TranslatePipe } from "../../../../shared/pipes/translate.pipe";
import { TerminalViewComponent } from "../terminal-view/terminal-view.component";

@Component({
  selector: "app-terminal-drawer",
  imports: [FormsModule, TerminalViewComponent, TranslatePipe],
  templateUrl: "./terminal-drawer.component.html",
  styleUrl: "./terminal-drawer.component.css",
})
export class TerminalDrawerComponent {
  private readonly terminalService = inject(TerminalService);
  private readonly router = inject(Router);

  @ViewChildren(TerminalViewComponent)
  terminalViews!: QueryList<TerminalViewComponent>;

  readonly isDrawerOpen = this.terminalService.isDrawerOpen;
  readonly drawerHeight = this.terminalService.drawerHeight;
  readonly isMaximized = this.terminalService.isMaximized;
  readonly tabs = this.terminalService.tabs;
  readonly activeTabId = this.terminalService.activeTabId;
  readonly availableShells = this.terminalService.availableShells;

  readonly showShellMenu = signal(false);

  private isResizing = false;
  private resizeStartY = 0;
  private resizeStartHeight = 0;

  startResize(event: PointerEvent): void {
    if (this.isMaximized()) {
      return;
    }
    this.isResizing = true;
    this.resizeStartY = event.clientY;
    this.resizeStartHeight = this.drawerHeight();
    (event.target as HTMLElement)?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  @HostListener("document:pointermove", ["$event"])
  onPointerMove(event: PointerEvent): void {
    if (!this.isResizing) {
      return;
    }
    const deltaY = this.resizeStartY - event.clientY;
    const newHeight = this.resizeStartHeight + deltaY;
    this.terminalService.setDrawerHeight(newHeight);
  }

  @HostListener("document:pointerup")
  @HostListener("document:pointercancel")
  onPointerUp(): void {
    if (this.isResizing) {
      this.isResizing = false;
      this.fitActiveTerminal();
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
    void this.terminalService.createTab(undefined, shellId);
  }

  toggleShellMenu(event: Event): void {
    event.stopPropagation();
    this.showShellMenu.update((v) => !v);
  }

  closeShellMenu(): void {
    this.showShellMenu.set(false);
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

  toggleMaximize(): void {
    this.terminalService.toggleMaximize();
    setTimeout(() => this.fitActiveTerminal(), 100);
  }

  openFullScreenPage(): void {
    this.terminalService.closeDrawer();
    void this.router.navigate(["/terminal"]);
  }

  closeDrawer(): void {
    this.terminalService.closeDrawer();
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
