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
    description: "A interface original do Git App, escura e focada.",
    preview: {
      background: "#111827",
      accent: "#f97316",
      ink: "#f9fafb",
    },
  },
  {
    id: "neo-brutalist",
    name: "Neo brutalista",
    description: "Creme, coral e amarelo com bordas fortes inspiradas no portfólio.",
    preview: {
      background: "#fff0d3",
      accent: "#d94332",
      ink: "#211e1b",
    },
  },
  {
    id: "glassmorphism",
    name: "Liquid Glass",
    description: "Vidro escuro translúcido, blur suave e reflexos inspirados no iOS.",
    preview: {
      background: "#121a3b",
      accent: "#8b9cff",
      ink: "#ffffff",
    },
  },
];

export const DEFAULT_THEME_ID: ThemeId = "neo-brutalist";

export function getThemeDefinition(themeId: ThemeId): ThemeDefinition {
  return THEME_OPTIONS.find((theme) => theme.id === themeId) ?? THEME_OPTIONS[0];
}
