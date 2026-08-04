import { Injectable, signal } from "@angular/core";

@Injectable({ providedIn: "root" })
export class LayoutService {
  readonly mainSidebarOpen = signal(true);

  openMainSidebar(): void {
    this.mainSidebarOpen.set(true);
  }

  closeMainSidebar(): void {
    this.mainSidebarOpen.set(false);
  }
}
