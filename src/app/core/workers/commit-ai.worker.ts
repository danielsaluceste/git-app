import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";
import { AI_WORKER_F16_NAME, GpuAdapterOptions, GpuLike } from "../models/webgpu.model";

// O `web-llm` sempre pede o adaptador de alto desempenho e, se ele tiver
// `shader-f16`, cria o device com essa feature. No Linux com CEF/Chromium 154 a
// GPU discreta (NVIDIA) ainda não expõe `shader-f16` — o suporte chegou no
// Chromium 155 —, mas os modelos q4f16 usam `enable f16;` nos shaders e falham
// com "extension 'f16' is not allowed". Quando o modelo exige f16, tentamos o
// adaptador de baixo consumo (nesse notebook, a Intel) se o preferido não tiver
// a feature. Modelos q4f32 usam o adaptador de alto desempenho normalmente.
const requiresShaderF16 = self.name === AI_WORKER_F16_NAME;
const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;

if (gpu && requiresShaderF16) {
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options?: GpuAdapterOptions) => {
    const preferred = await requestAdapter(options);
    if (!preferred || preferred.features.has("shader-f16")) {
      return preferred;
    }

    const fallback = await requestAdapter({ ...options, powerPreference: "low-power" });
    if (fallback?.features.has("shader-f16")) {
      console.warn(
        `[commit-ai] adaptador ${preferred.info.vendor} sem shader-f16; usando ${fallback.info.vendor}.`,
      );
      return fallback;
    }

    return preferred;
  };
}

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (event) => handler.onmessage(event);
