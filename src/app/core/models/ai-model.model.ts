export type AiModelSize = "qwen05" | "qwen15" | "qwen3" | "qwen7";

export type AiModelPrecision = "q4f16" | "q4f32";

export type AiModelId =
  | "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC"
  | "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC"
  | "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-Coder-3B-Instruct-q4f32_1-MLC"
  | "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-Coder-7B-Instruct-q4f32_1-MLC";

export type AiModelTier = "light" | "medium" | "heavy" | "very-heavy";

export interface AiModelOption {
  id: AiModelId;
  size: AiModelSize;
  name: string;
  tier: AiModelTier;
  tierLabel: string;
  description: string;
  sizeLabel: string;
  hardwareLabel: string;
  precision: AiModelPrecision;
  /** `true` quando os shaders do modelo usam `enable f16;` (exigem `shader-f16`). */
  requiresShaderF16: boolean;
  /** VRAM aproximada reportada pelo web-llm para o modelo. */
  vramMb: number;
  recommended?: boolean;
}

export const DEFAULT_AI_MODEL_ID: AiModelId =
  "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC";

export const AI_MODEL_OPTIONS: readonly AiModelOption[] = [
  {
    id: "Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC",
    size: "qwen05",
    name: "Qwen2.5 Coder 0.5B",
    tier: "light",
    tierLabel: "Leve",
    description: "Inicializa mais rápido e consome menos memória, mas pode gerar mensagens mais genéricas.",
    sizeLabel: "Aproximadamente 300 MB",
    hardwareLabel: "GPU integrada ou básica",
    precision: "q4f32",
    requiresShaderF16: false,
    vramMb: 1060,
  },
  {
    id: "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC",
    size: "qwen05",
    name: "Qwen2.5 Coder 0.5B",
    tier: "light",
    tierLabel: "Leve",
    description: "Inicializa mais rápido e consome menos memória, mas pode gerar mensagens mais genéricas.",
    sizeLabel: "Aproximadamente 300 MB",
    hardwareLabel: "GPU integrada ou básica",
    precision: "q4f16",
    requiresShaderF16: true,
    vramMb: 945,
  },
  {
    id: "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC",
    size: "qwen15",
    name: "Qwen2.5 Coder 1.5B",
    tier: "medium",
    tierLabel: "Intermediário",
    description: "Melhor equilíbrio entre qualidade, velocidade e consumo para mensagens de commit.",
    sizeLabel: "Aproximadamente 880 MB",
    hardwareLabel: "GPU com memória compartilhada",
    precision: "q4f32",
    requiresShaderF16: false,
    vramMb: 1889,
    recommended: true,
  },
  {
    id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
    size: "qwen15",
    name: "Qwen2.5 Coder 1.5B",
    tier: "medium",
    tierLabel: "Intermediário",
    description: "Melhor equilíbrio entre qualidade, velocidade e consumo para mensagens de commit.",
    sizeLabel: "Aproximadamente 880 MB",
    hardwareLabel: "GPU com memória compartilhada",
    precision: "q4f16",
    requiresShaderF16: true,
    vramMb: 1630,
  },
  {
    id: "Qwen2.5-Coder-3B-Instruct-q4f32_1-MLC",
    size: "qwen3",
    name: "Qwen2.5 Coder 3B",
    tier: "heavy",
    tierLabel: "Pesado",
    description: "Entende melhor alterações amplas e produz resumos mais específicos.",
    sizeLabel: "Mais de 2 GB",
    hardwareLabel: "GPU dedicada recomendada",
    precision: "q4f32",
    requiresShaderF16: false,
    vramMb: 2894,
  },
  {
    id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    size: "qwen3",
    name: "Qwen2.5 Coder 3B",
    tier: "heavy",
    tierLabel: "Pesado",
    description: "Entende melhor alterações amplas e produz resumos mais específicos.",
    sizeLabel: "Mais de 2 GB",
    hardwareLabel: "GPU dedicada recomendada",
    precision: "q4f16",
    requiresShaderF16: true,
    vramMb: 2505,
  },
  {
    id: "Qwen2.5-Coder-7B-Instruct-q4f32_1-MLC",
    size: "qwen7",
    name: "Qwen2.5 Coder 7B",
    tier: "very-heavy",
    tierLabel: "Muito pesado",
    description: "Maior capacidade de análise, mas exige bastante memória e pode ser lento em PCs comuns.",
    sizeLabel: "Aproximadamente 4,3 GB",
    hardwareLabel: "GPU dedicada com bastante memória",
    precision: "q4f32",
    requiresShaderF16: false,
    vramMb: 5900,
  },
  {
    id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC",
    size: "qwen7",
    name: "Qwen2.5 Coder 7B",
    tier: "very-heavy",
    tierLabel: "Muito pesado",
    description: "Maior capacidade de análise, mas exige bastante memória e pode ser lento em PCs comuns.",
    sizeLabel: "Aproximadamente 4,3 GB",
    hardwareLabel: "GPU dedicada com bastante memória",
    precision: "q4f16",
    requiresShaderF16: true,
    vramMb: 5107,
  },
];

export function getAiModelOption(modelId: AiModelId): AiModelOption {
  return (
    AI_MODEL_OPTIONS.find((model) => model.id === modelId) ??
    AI_MODEL_OPTIONS.find((model) => model.id === DEFAULT_AI_MODEL_ID)!
  );
}

/** Opções do mesmo tamanho, com a outra precisão (ou a mesma, quando não houver). */
export function getSameSizeModels(model: AiModelOption): AiModelOption[] {
  return AI_MODEL_OPTIONS.filter((option) => option.size === model.size);
}

export function getModelSizeKey(modelId: AiModelId): AiModelSize {
  return getAiModelOption(modelId).size;
}
