import { Component, EventEmitter, Input, Output } from "@angular/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WorkspaceMenuComponent } from "../../features/workspaces/components/workspace-menu.component";
import { TranslatePipe } from "../../shared/pipes/translate.pipe";

@Component({
  selector: "app-topbar",
  imports: [WorkspaceMenuComponent, TranslatePipe],
  templateUrl: "./topbar.component.html",
  styleUrl: "./topbar.component.css",
})
export class TopbarComponent {
  @Input() showMainSidebarButton = false;
  @Input() showCodexButton = false;
  @Input() codexOpen = false;
  @Input() showTerminalButton = false;
  @Input() terminalOpen = false;
  @Input() updateAvailable = false;
  @Output() mainSidebarRequested = new EventEmitter<void>();
  @Output() codexRequested = new EventEmitter<void>();
  @Output() terminalRequested = new EventEmitter<void>();
  @Output() updateRequested = new EventEmitter<void>();

  minimize(): Promise<void> {
    return this.runWindowAction((appWindow) => appWindow.minimize());
  }

  toggleMaximize(): Promise<void> {
    return this.runWindowAction((appWindow) => appWindow.toggleMaximize());
  }

  close(): Promise<void> {
    return this.runWindowAction((appWindow) => appWindow.close());
  }

  startDragging(event: MouseEvent): Promise<void> {
    const target = event.target;

    if (
      event.button !== 0 ||
      (target instanceof Element && target.closest("button, input, textarea, select, a"))
    ) {
      return Promise.resolve();
    }

    if (event.detail === 2) {
      return this.toggleMaximize();
    }

    return this.runWindowAction((appWindow) => appWindow.startDragging());
  }

  private runWindowAction(
    action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<void>,
  ): Promise<void> {
    if (!("__TAURI_INTERNALS__" in window)) {
      return Promise.resolve();
    }

    return action(getCurrentWindow()).catch((error: unknown) => {
      console.error("Não foi possível controlar a janela.", error);
    });
  }
}
