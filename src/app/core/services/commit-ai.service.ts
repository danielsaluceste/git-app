import { computed, inject, Injectable, signal } from "@angular/core";
import type { InitProgressReport, MLCEngineInterface } from "@mlc-ai/web-llm";
import { AiModelId, getAiModelOption } from "../models/ai-model.model";
import { SettingsService } from "./settings.service";

@Injectable({ providedIn: "root" })
export class CommitAiService {
  private readonly settingsService = inject(SettingsService);
  private readonly workerModel = signal<MLCEngineInterface | undefined>(undefined);
  private enginePromise: Promise<MLCEngineInterface> | undefined;
  private worker: Worker | undefined;
  private loadedModelId: AiModelId | undefined;
  private webllmPromise: Promise<typeof import("@mlc-ai/web-llm")> | undefined;

  readonly isSupported = signal(this.detectWebGpuSupport());
  readonly isLoadingModel = signal(false);
  readonly isGenerating = signal(false);
  readonly progress = signal(0);
  readonly progressText = signal("Preparando a IA local...");
  readonly selectedModel = computed(() => getAiModelOption(this.settingsService.aiModel()));
  readonly modelSizeLabel = computed(() => this.selectedModel().sizeLabel);

  prepareForAnalysis(): void {
    if (this.isSupported()) {
      void this.loadWebLlm().catch(() => undefined);
    }
  }

  async isModelCached(): Promise<boolean> {
    if (!this.isSupported()) {
      return false;
    }

    const webllm = await this.loadWebLlm();
    return webllm.hasModelInCache(this.settingsService.aiModel(), webllm.prebuiltAppConfig);
  }

  async generateCommitMessage(diff: string): Promise<string> {
    const engine = await this.loadModel();
    this.isGenerating.set(true);

    try {
      const response = await engine.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "Você é um especialista em Git. Analise o conjunto inteiro de arquivos e mudanças, não apenas o primeiro arquivo listado. Gere somente uma mensagem de commit específica, em uma única linha e em português. Use o formato Conventional Commits: tipo(escopo): verbo no imperativo + mudança concreta. Tipos permitidos: feat, fix, refactor, docs, test, chore, build, ci, perf ou style. Use nomes reais da funcionalidade, tela, comando, evento ou comportamento alterado. Nunca invente o motivo e nunca use frases vagas como 'melhora a UI', 'melhorias no layout', 'atualiza arquivos' ou 'diversos ajustes'. Não mencione arquivo, caminho ou apenas uma área. Quando aparecer 'ALTERACAO AMPLA', use pelo menos duas áreas da linha 'AREAS AFETADAS' e gere um resumo abrangente da mudança principal. Ignore arquivos de configuração secundários. Não use aspas, markdown ou explicações.",
          },
          {
            role: "user",
            content: `Analise cuidadosamente estas alterações staged e descreva o objetivo do conjunto. Não gere uma mensagem baseada somente no primeiro arquivo ou em uma única área. Se houver muitos arquivos, use pelo menos duas áreas afetadas e produza uma mensagem que represente a mudança principal do projeto. Ignore arquivos secundários quando houver uma funcionalidade maior. Se for uma configuração isolada, cite a configuração alterada.\n\n--- CONTEXTO DAS ALTERAÇÕES ---\n${diff}\n--- FIM DO CONTEXTO ---`,
          },
        ],
        temperature: 0.1,
        max_tokens: 60,
      });

      const content = response.choices[0]?.message.content?.trim();
      if (!content) {
        throw new Error("A IA não retornou uma mensagem de commit.");
      }

      const generatedMessage = this.cleanGeneratedMessage(content);
      return this.ensureBroadMessage(generatedMessage, diff);
    } finally {
      this.isGenerating.set(false);
    }
  }

  private async loadModel(): Promise<MLCEngineInterface> {
    if (!this.isSupported()) {
      throw new Error("A aceleração WebGPU não está disponível neste ambiente.");
    }
    const selectedModelId = this.settingsService.aiModel();

    if (this.workerModel() && this.loadedModelId === selectedModelId) {
      return this.workerModel() as MLCEngineInterface;
    }
    if (this.enginePromise && this.loadedModelId === selectedModelId) {
      return this.enginePromise;
    }

    if (this.workerModel() || this.enginePromise) {
      this.resetEngine();
    }

    this.loadedModelId = selectedModelId;
    this.enginePromise = this.initializeModel(selectedModelId);

    return this.enginePromise;
  }

  private async initializeModel(modelId: AiModelId): Promise<MLCEngineInterface> {
    this.isLoadingModel.set(true);
    this.progress.set(0);
    this.progressText.set("Baixando e preparando o modelo local...");
    this.worker = new Worker(new URL("../workers/commit-ai.worker.ts", import.meta.url), {
      type: "module",
    });

    try {
      const webllm = await this.loadWebLlm();
      const engine = await webllm.CreateWebWorkerMLCEngine(this.worker, modelId, {
        appConfig: webllm.prebuiltAppConfig,
        initProgressCallback: (report: InitProgressReport) => this.updateProgress(report),
      });
      this.workerModel.set(engine);
      this.progress.set(100);
      this.progressText.set("IA local pronta.");
      return engine;
    } catch (error: unknown) {
      this.worker?.terminate();
      this.worker = undefined;
      this.enginePromise = undefined;
      this.loadedModelId = undefined;
      throw error;
    } finally {
      this.isLoadingModel.set(false);
    }
  }

  private resetEngine(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.workerModel.set(undefined);
    this.enginePromise = undefined;
    this.loadedModelId = undefined;
  }

  private updateProgress(report: InitProgressReport): void {
    const progress = report.progress <= 1 ? report.progress * 100 : report.progress;
    this.progress.set(Math.max(0, Math.min(100, Math.round(progress))));
    this.progressText.set(report.text || "Baixando e preparando o modelo local...");
  }

  private loadWebLlm(): Promise<typeof import("@mlc-ai/web-llm")> {
    this.webllmPromise ??= import("@mlc-ai/web-llm");
    return this.webllmPromise;
  }

  private ensureBroadMessage(message: string, context: string): string {
    if (!context.includes("ALTERACAO AMPLA")) {
      return message;
    }

    const areasLine = context
      .split("\n")
      .find((line) => line.startsWith("AREAS AFETADAS:"));
    if (!areasLine) {
      return message;
    }

    const areas = areasLine
      .slice("AREAS AFETADAS:".length)
      .split(",")
      .map((area) => area.trim())
      .filter((area) => !["aplicacao", "configuracao"].includes(this.normalize(area)));

    if (areas.length < 2) {
      return message;
    }

    const normalizedMessage = this.normalize(message);
    const mentionedAreas = areas.filter((area) => normalizedMessage.includes(this.normalize(area)));
    const mentionsFile = /\.(html|ts|css|json|rs|lock)\b/i.test(message);

    if (mentionedAreas.length >= 2 && !mentionsFile) {
      return message;
    }

    return this.createBroadFallback(areas);
  }

  private createBroadFallback(areas: string[]): string {
    const labels = areas
      .map((area) => this.translateArea(area))
      .filter((area, index, all) => all.indexOf(area) === index)
      .filter((area) => !["aplicação", "configuração"].includes(area));
    const hasRepositories = labels.includes("repositórios");
    const relatedAreas = labels.filter((area) => area !== "repositórios").slice(0, 3);

    if (hasRepositories && relatedAreas.length > 0) {
      return `feat(app): amplia gerenciamento de repositórios com ${this.joinList(relatedAreas)}`;
    }

    return `feat(app): integra ${this.joinList(relatedAreas.length > 0 ? relatedAreas : labels.slice(0, 3))}`;
  }

  private translateArea(area: string): string {
    switch (this.normalize(area)) {
      case "branches":
        return "branches";
      case "historico":
      case "history":
        return "histórico";
      case "alteracoes e commits":
      case "changes":
        return "alterações e commits";
      case "repositorios":
      case "repositories":
        return "repositórios";
      case "repository":
        return "repositório";
      case "navegacao do repositorio":
        return "navegação do repositório";
      case "layout e navegacao":
      case "layout":
        return "layout e navegação";
      case "ia local":
      case "commit ai":
        return "IA local";
      case "integracao tauri":
      case "tauri":
        return "integração Tauri";
      case "dialogos":
      case "dialogs":
        return "diálogos";
      case "configuracao":
        return "configuração";
      default:
        return area;
    }
  }

  private joinList(items: string[]): string {
    if (items.length <= 1) {
      return items[0] || "recursos da aplicação";
    }

    return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
  }

  private normalize(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  private detectWebGpuSupport(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  private cleanGeneratedMessage(message: string): string {
    const firstLine = message
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    return (firstLine || message).replace(/^[`"']+|[`"']+$/g, "").trim();
  }
}
