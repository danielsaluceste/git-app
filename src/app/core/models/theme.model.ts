export type ThemeId = "default" | "neo-brutalist";

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
      background: "#fff3dc",
      accent: "#fd5b49",
      ink: "#211e1b",
    },
  },
];

export const DEFAULT_THEME_ID: ThemeId = "default";

export function getThemeDefinition(themeId: ThemeId): ThemeDefinition {
  return THEME_OPTIONS.find((theme) => theme.id === themeId) ?? THEME_OPTIONS[0];
}
