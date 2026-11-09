import { Injectable, computed, signal } from "@angular/core";
import {
  GpuAdapterLike,
  GpuAdapterSummary,
  WebGpuCapabilities,
  getNavigatorGpu,
} from "../models/webgpu.model";

/**
 * Consulta os adaptadores WebGPU uma única vez por sessão e expõe o que cada um
 * suporta. A escolha de modelo usa isso para esconder modelos incompatíveis e
 * para dizer em qual GPU cada modelo vai rodar.
 */
@Injectable({ providedIn: "root" })
export class WebGpuSupportService {
  private readonly capabilitiesState = signal<WebGpuCapabilities | null>(null);
  private detection: Promise<WebGpuCapabilities | null> | undefined;

  readonly capabilities = this.capabilitiesState.asReadonly();
  readonly detected = computed(() => this.capabilitiesState() !== null);
  readonly hasAdapter = computed(() => {
    const capabilities = this.capabilitiesState();
    return !!capabilities && (capabilities.highPerformance !== null || capabilities.lowPower !== null);
  });
  readonly hasWebGpu = computed(() => {
    if (typeof navigator === "undefined") {
      return false;
    }
    return "gpu" in navigator;
  });

  /** Executa a detecção (idempotente) e devolve o resultado. */
  detect(): Promise<WebGpuCapabilities | null> {
    this.detection ??= this.runDetection();
    return this.detection;
  }

  /**
   * Adaptador que o worker usará para um modelo.
   *
   * - modelos `q4f16` passam pelo fallback do worker: primeiro o de alto
   *   desempenho e, se ele não tiver `shader-f16`, o de baixo consumo;
   * - modelos `q4f32` não precisam de `f16`, então usam o de alto desempenho.
   */
  adapterFor(requiresShaderF16: boolean): GpuAdapterSummary | null {
    const capabilities = this.capabilitiesState();
    if (!capabilities) {
      return null;
    }

    if (requiresShaderF16) {
      if (capabilities.highPerformance?.supportsF16) {
        return capabilities.highPerformance;
      }
      return capabilities.lowPower?.supportsF16 ? capabilities.lowPower : null;
    }

    return capabilities.highPerformance ?? capabilities.lowPower;
  }

  supportsModel(model: { requiresShaderF16: boolean }): boolean {
    const capabilities = this.capabilitiesState();
    if (!capabilities) {
      return this.hasWebGpu();
    }
    return this.adapterFor(model.requiresShaderF16) !== null;
  }

  private async runDetection(): Promise<WebGpuCapabilities | null> {
    const gpu = getNavigatorGpu();
    if (!gpu) {
      return null;
    }

    // Na inicialização o processo de GPU pode ainda não ter terminado de subir
    // (o adaptador volta `null` por alguns instantes). Tenta mais algumas vezes
    // antes de concluir que não há GPU utilizável.
    let highPerformance: GpuAdapterLike | null = null;
    let lowPower: GpuAdapterLike | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      [highPerformance, lowPower] = await Promise.all([
        requestAdapter(gpu.requestAdapter.bind(gpu), "high-performance"),
        requestAdapter(gpu.requestAdapter.bind(gpu), "low-power"),
      ]);
      if (highPerformance || lowPower) {
        break;
      }
      await delay(250);
    }

    const capabilities: WebGpuCapabilities = {
      highPerformance: summarize(highPerformance),
      lowPower: summarize(lowPower),
    };
    this.capabilitiesState.set(capabilities);
    return capabilities;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestAdapter(
  request: (options?: { powerPreference?: "high-performance" | "low-power" }) => Promise<GpuAdapterLike | null>,
  powerPreference: "high-performance" | "low-power",
): Promise<GpuAdapterLike | null> {
  try {
    return await request({ powerPreference });
  } catch {
    return null;
  }
}

function summarize(adapter: GpuAdapterLike | null): GpuAdapterSummary | null {
  if (!adapter) {
    return null;
  }

  return {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    supportsF16: adapter.features.has("shader-f16"),
  };
}
