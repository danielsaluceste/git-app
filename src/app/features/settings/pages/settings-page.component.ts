import { Component, inject } from "@angular/core";
import { SettingsService } from "../../../core/services/settings.service";

@Component({
  selector: "app-settings-page",
  templateUrl: "./settings-page.component.html",
  styleUrl: "./settings-page.component.css",
})
export class SettingsPageComponent {
  private readonly settingsService = inject(SettingsService);
  readonly aiEnabled = this.settingsService.aiEnabled;
  readonly gitCommandNotifications = this.settingsService.gitCommandNotifications;
  readonly notificationSounds = this.settingsService.notificationSounds;

  toggleAi(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.settingsService.setAiEnabled(input.checked);
  }

  toggleGitCommandNotifications(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.settingsService.setGitCommandNotifications(input.checked);
  }

  toggleNotificationSounds(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.settingsService.setNotificationSounds(input.checked);
  }
}
