export type ThemeId = "default" | "neo-brutalist" | "glassmorphism";

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  preview: {
    background: string;
    accent: string;
    ink: string;
  };
}

export const THEME_OPTIONS: readonly ThemeDefinition[] = [
  {
    id: "default",
    name: "Midnight",
    description: "A interface clássica e focada do GitLuna em modo escuro.",
    preview: {
      background: "#111827",
      accent: "#f97316",
      ink: "#f9fafb",
    },
  },
  {
    id: "neo-brutalist",
    name: "Neo brutalista",
    description: "Creme, coral e amarelo com bordas fortes e sombras sólidas.",
    preview: {
      background: "#fff0d3",
      accent: "#f0523f",
      ink: "#211e1b",
    },
  },
  {
    id: "glassmorphism",
    name: "Liquid Glass",
    description: "Vidro translúcido com reflexos de luz e blur nativo do sistema.",
    preview: {
      background: "#121a3b",
      accent: "#8b9cff",
      ink: "#ffffff",
    },
  },
];

export const DEFAULT_THEME_ID: ThemeId = "default";

export function getThemeDefinition(themeId: ThemeId): ThemeDefinition {
  return THEME_OPTIONS.find((theme) => theme.id === themeId) ?? THEME_OPTIONS[0];
}
