import { Component, computed, inject } from "@angular/core";
import { AppLanguage } from "../../../core/models/language.model";
import {
  AI_MODEL_OPTIONS,
  AiModelOption,
  AiModelId,
  getAiModelOption,
} from "../../../core/models/ai-model.model";
import { SettingsService } from "../../../core/services/settings.service";
import { ThemeId } from "../../../core/models/theme.model";
import { ThemeService } from "../../../core/services/theme.service";
import { TranslationService } from "../../../core/services/translation.service";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

@Component({
  selector: "app-settings-page",
  imports: [TranslatePipe],
  templateUrl: "./settings-page.component.html",
  styleUrl: "./settings-page.component.css",
})
export class SettingsPageComponent {
  private readonly settingsService = inject(SettingsService);
  private readonly themeService = inject(ThemeService);
  private readonly translationService = inject(TranslationService);
  readonly aiModels = AI_MODEL_OPTIONS;
  readonly aiEnabled = this.settingsService.aiEnabled;
  readonly aiModel = this.settingsService.aiModel;
  readonly selectedAiModel = computed(() => getAiModelOption(this.aiModel()));
  modelPickerOpen = false;
  readonly gitCommandNotifications = this.settingsService.gitCommandNotifications;
  readonly notificationSounds = this.settingsService.notificationSounds;
  readonly themes = this.themeService.themes;
  readonly activeTheme = this.themeService.theme;
  readonly language = this.settingsService.language;
  readonly languages: Array<{ id: AppLanguage; labelKey: string }> = [
    { id: "pt-BR", labelKey: "language.ptBR" },
    { id: "en", labelKey: "language.en" },
  ];
  languagePickerOpen = false;

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

  modelTierLabel(model: AiModelOption): string {
    return this.translationService.translate(`settings.ai.model.${this.modelKey(model.id)}.tier`);
  }

  modelDescription(model: AiModelOption): string {
    return this.translationService.translate(`settings.ai.model.${this.modelKey(model.id)}.description`);
  }

  modelSizeLabel(model: AiModelOption): string {
    return this.translationService.translate(`settings.ai.model.${this.modelKey(model.id)}.size`);
  }

  modelHardwareLabel(model: AiModelOption): string {
    return this.translationService.translate(`settings.ai.model.${this.modelKey(model.id)}.hardware`);
  }

  toggleGitCommandNotifications(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.settingsService.setGitCommandNotifications(input.checked);
  }

  toggleNotificationSounds(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.settingsService.setNotificationSounds(input.checked);
  }

  selectTheme(themeId: ThemeId): void {
    this.themeService.setTheme(themeId);
  }

  toggleLanguagePicker(): void {
    this.languagePickerOpen = !this.languagePickerOpen;
  }

  selectLanguage(language: AppLanguage): void {
    this.settingsService.setLanguage(language);
    this.languagePickerOpen = false;
  }

  private modelKey(modelId: AiModelId): string {
    if (modelId.includes("0.5B")) {
      return "qwen05";
    }
    if (modelId.includes("1.5B")) {
      return "qwen15";
    }
    if (modelId.includes("3B")) {
      return "qwen3";
    }
    return "qwen7";
  }
}
