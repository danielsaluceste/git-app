import { Component, computed, inject } from "@angular/core";
import {
  AI_MODEL_OPTIONS,
  AiModelId,
  getAiModelOption,
} from "../../../core/models/ai-model.model";
import { SettingsService } from "../../../core/services/settings.service";

@Component({
  selector: "app-settings-page",
  templateUrl: "./settings-page.component.html",
  styleUrl: "./settings-page.component.css",
})
export class SettingsPageComponent {
  private readonly settingsService = inject(SettingsService);
  readonly aiModels = AI_MODEL_OPTIONS;
  readonly aiEnabled = this.settingsService.aiEnabled;
  readonly aiModel = this.settingsService.aiModel;
  readonly selectedAiModel = computed(() => getAiModelOption(this.aiModel()));
  modelPickerOpen = false;
  readonly gitCommandNotifications = this.settingsService.gitCommandNotifications;
  readonly notificationSounds = this.settingsService.notificationSounds;

  toggleAi(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.settingsService.setAiEnabled(input.checked);

    if (!input.checked) {
      this.modelPickerOpen = false;
    }
  }

  toggleModelPicker(): void {
    this.modelPickerOpen = !this.modelPickerOpen;
  }

  selectAiModel(modelId: AiModelId): void {
    this.settingsService.setAiModel(modelId);
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
