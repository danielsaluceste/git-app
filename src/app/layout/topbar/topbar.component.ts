import { Component, EventEmitter, Input, Output } from "@angular/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WorkspaceMenuComponent } from "../../features/workspaces/components/workspace-menu.component";

@Component({
  selector: "app-topbar",
  imports: [WorkspaceMenuComponent],
  templateUrl: "./topbar.component.html",
  styleUrl: "./topbar.component.css",
})
export class TopbarComponent {
  @Input() showMainSidebarButton = false;
  @Output() mainSidebarRequested = new EventEmitter<void>();

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
      event.buttons !== 1 ||
      (target instanceof HTMLElement && target.closest("button"))
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
