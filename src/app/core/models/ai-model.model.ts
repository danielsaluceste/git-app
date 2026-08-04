export type AiModelId =
  | "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC";

export type AiModelTier = "light" | "medium" | "heavy" | "very-heavy";

export interface AiModelOption {
  id: AiModelId;
  name: string;
  tier: AiModelTier;
  tierLabel: string;
  description: string;
  sizeLabel: string;
  hardwareLabel: string;
  recommended?: boolean;
}

export const DEFAULT_AI_MODEL_ID: AiModelId =
  "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC";

export const AI_MODEL_OPTIONS: readonly AiModelOption[] = [
  {
    id: "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2.5 Coder 0.5B",
    tier: "light",
    tierLabel: "Leve",
    description: "Inicializa mais rápido e consome menos memória, mas pode gerar mensagens mais genéricas.",
    sizeLabel: "Aproximadamente 300 MB",
    hardwareLabel: "GPU integrada ou básica",
  },
  {
    id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2.5 Coder 1.5B",
    tier: "medium",
    tierLabel: "Intermediário",
    description: "Melhor equilíbrio entre qualidade, velocidade e consumo para mensagens de commit.",
    sizeLabel: "Aproximadamente 880 MB",
    hardwareLabel: "GPU com memória compartilhada",
    recommended: true,
  },
  {
    id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    name: "Qwen2.5 Coder 3B",
    tier: "heavy",
    tierLabel: "Pesado",
    description: "Entende melhor alterações amplas e produz resumos mais específicos.",
    sizeLabel: "Mais de 2 GB",
    hardwareLabel: "GPU dedicada recomendada",
  },
  {
    id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC",
    name: "Qwen2.5 Coder 7B",
    tier: "very-heavy",
    tierLabel: "Muito pesado",
    description: "Maior capacidade de análise, mas exige bastante memória e pode ser lento em PCs comuns.",
    sizeLabel: "Aproximadamente 4,3 GB",
    hardwareLabel: "GPU dedicada com bastante memória",
  },
];

export function getAiModelOption(modelId: AiModelId): AiModelOption {
  return AI_MODEL_OPTIONS.find((model) => model.id === modelId) ?? AI_MODEL_OPTIONS[1];
}
