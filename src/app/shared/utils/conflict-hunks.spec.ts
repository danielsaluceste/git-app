import { describe, expect, it } from "vitest";
import {
  buildConflictContent,
  parseConflictMarkers,
  resolutionLines,
} from "./conflict-hunks";

const MERGE_CONFLICT = [
  "line before",
  "<<<<<<< HEAD",
  "main version",
  "=======",
  "feature version",
  ">>>>>>> feature/login",
  "line after",
].join("\n");

const DIFF3_CONFLICT = [
  "start",
  "<<<<<<< HEAD",
  "ours",
  "||||||| base",
  "base",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "end",
].join("\n");

describe("parseConflictMarkers", () => {
  it("separa contexto e trechos conflitantes", () => {
    const document = parseConflictMarkers(MERGE_CONFLICT);

    expect(document).toBeDefined();
    expect(document!.hunks).toHaveLength(1);
    expect(document!.hunks[0].ours).toEqual(["main version"]);
    expect(document!.hunks[0].theirs).toEqual(["feature version"]);
    expect(document!.hunks[0].base).toEqual([]);
    expect(document!.segments).toEqual([
      { kind: "context", lines: ["line before"] },
      { kind: "hunk", hunk: document!.hunks[0] },
      { kind: "context", lines: ["line after"] },
    ]);
  });

  it("suporta o estilo diff3 com a base", () => {
    const hunk = parseConflictMarkers(DIFF3_CONFLICT)!.hunks[0];

    expect(hunk.ours).toEqual(["ours"]);
    expect(hunk.base).toEqual(["base"]);
    expect(hunk.theirs).toEqual(["theirs"]);
  });

  it("encontra múltiplos conflitos", () => {
    const content = `${MERGE_CONFLICT}\nmiddle\n${MERGE_CONFLICT}`;
    const document = parseConflictMarkers(content);

    expect(document!.hunks).toHaveLength(2);
    expect(document!.hunks[1].startLine).toBe(10);
  });

  it("devolve undefined quando não existem marcadores", () => {
    expect(parseConflictMarkers("arquivo sem conflito\n")).toBeUndefined();
  });

  it("devolve undefined para marcadores incompletos", () => {
    expect(
      parseConflictMarkers("<<<<<<< HEAD\nnossa\n=======\ndeles"),
    ).toBeUndefined();
  });

  it("preserva CRLF", () => {
    const content = "a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> x\r\nb\r\n";
    const document = parseConflictMarkers(content);

    expect(document!.hunks[0].ours).toEqual(["ours\r"]);
    expect(document!.hunks[0].theirs).toEqual(["theirs\r"]);
  });
});

describe("buildConflictContent", () => {
  const document = parseConflictMarkers(MERGE_CONFLICT)!;

  it("monta o arquivo com a escolha de cada trecho", () => {
    const content = buildConflictContent(document, {
      0: { choice: "theirs" },
    });

    expect(content).toBe("line before\nfeature version\nline after");
  });

  it("permite usar as duas versões no mesmo trecho", () => {
    const content = buildConflictContent(document, {
      0: { choice: "both" },
    });

    expect(content).toBe("line before\nmain version\nfeature version\nline after");
  });

  it("permite editar o conteúdo do trecho", () => {
    const content = buildConflictContent(document, {
      0: { choice: "custom", custom: "customizado" },
    });

    expect(content).toBe("line before\ncustomizado\nline after");
  });

  it("retorna undefined enquanto houver trecho sem escolha", () => {
    expect(buildConflictContent(document, {})).toBeUndefined();

    const twoHunks = parseConflictMarkers(
      `${MERGE_CONFLICT}\n${MERGE_CONFLICT}`,
    )!;

    expect(
      buildConflictContent(twoHunks, { 0: { choice: "ours" } }),
    ).toBeUndefined();
  });

  it("monta resultado vazio quando todas as partes foram removidas", () => {
    const empty = parseConflictMarkers(
      "<<<<<<< HEAD\n=======\n>>>>>>> x",
    );

    expect(empty).toBeDefined();
    expect(buildConflictContent(empty!, { 0: { choice: "ours" } })).toBe("");
  });
});

describe("resolutionLines", () => {
  const hunk = parseConflictMarkers(MERGE_CONFLICT)!.hunks[0];

  it("devolve as linhas da versão escolhida", () => {
    expect(resolutionLines(hunk, { choice: "ours" })).toEqual(["main version"]);
    expect(resolutionLines(hunk, { choice: "theirs" })).toEqual(["feature version"]);
    expect(resolutionLines(hunk, { choice: "both" })).toEqual([
      "main version",
      "feature version",
    ]);
  });

  it("devolve undefined sem escolha", () => {
    expect(resolutionLines(hunk, {})).toBeUndefined();
  });
});
