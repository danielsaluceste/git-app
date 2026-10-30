import { describe, expect, it } from "vitest";
import { filterPaletteItems, normalizeSearch } from "./palette-filter";

const ITEMS = [
  { label: "Configurações", hint: "/settings" },
  { label: "Alterações", hint: "/changes" },
  { label: "main", hint: "Branch atual" },
  { label: "git-app", hint: "C:\\dev\\git-app" },
];

describe("normalizeSearch", () => {
  it("remove acentos e caixa", () => {
    expect(normalizeSearch("Configurações")).toBe("configuracoes");
    expect(normalizeSearch("  ALTERAÇÕES ")).toBe("alteracoes");
  });
});

describe("filterPaletteItems", () => {
  it("devolve os primeiros itens sem consulta", () => {
    expect(filterPaletteItems(ITEMS, "", 3)).toHaveLength(3);
  });

  it("encontra ignorando acentos e caixa", () => {
    const result = filterPaletteItems(ITEMS, "configuracoes", 10);

    expect(result.map((item) => item.label)).toEqual(["Configurações"]);
  });

  it("combina termos em qualquer ordem", () => {
    const result = filterPaletteItems(ITEMS, "git app", 10);

    expect(result.map((item) => item.label)).toEqual(["git-app"]);
  });

  it("busca também pela dica (caminho da rota)", () => {
    const result = filterPaletteItems(ITEMS, "changes", 10);

    expect(result.map((item) => item.label)).toEqual(["Alterações"]);
  });

  it("respeita o limite e devolve vazio quando nada casa", () => {
    expect(filterPaletteItems(ITEMS, "a", 2)).toHaveLength(2);
    expect(filterPaletteItems(ITEMS, "zzz", 10)).toEqual([]);
  });
});
