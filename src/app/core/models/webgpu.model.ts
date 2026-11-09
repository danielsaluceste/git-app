/** Tipos mínimos de WebGPU compartilhados entre o app e o worker de IA. */

export interface GpuAdapterLike {
  readonly features: { has(feature: string): boolean };
  readonly info: { vendor: string; architecture: string };
}

export type GpuAdapterOptions = {
  powerPreference?: "high-performance" | "low-power";
};

export interface GpuLike {
  requestAdapter(options?: GpuAdapterOptions): Promise<GpuAdapterLike | null>;
}

export interface GpuAdapterSummary {
  vendor: string;
  architecture: string;
  supportsF16: boolean;
}

export interface WebGpuCapabilities {
  highPerformance: GpuAdapterSummary | null;
  lowPower: GpuAdapterSummary | null;
}

/** Nome do worker que exige `shader-f16` (ativada pelo shim em `commit-ai.worker.ts`). */
export const AI_WORKER_F16_NAME = "commit-ai-f16";
export const AI_WORKER_F32_NAME = "commit-ai-f32";

export function getNavigatorGpu(): GpuLike | undefined {
  return (navigator as Navigator & { gpu?: GpuLike }).gpu;
}
