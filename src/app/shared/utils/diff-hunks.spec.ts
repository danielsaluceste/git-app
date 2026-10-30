import { describe, expect, it } from "vitest";
import { splitDiffHunks } from "./diff-hunks";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " linha 1",
  "+linha nova",
  " linha 2",
  " linha 3",
  "@@ -10,3 +11,3 @@",
  " linha 10",
  "-linha 11",
  "+linha onze",
  " linha 12",
  "",
].join("\n");

describe("splitDiffHunks", () => {
  it("devolve cabeçalho e trechos na ordem do diff", () => {
    const { headerLines, hunks } = splitDiffHunks(DIFF);

    expect(headerLines).toEqual([
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
    ]);
    expect(hunks).toHaveLength(2);
    expect(hunks.map((hunk) => hunk.index)).toEqual([0, 1]);
    expect(hunks[0].header).toBe("@@ -1,3 +1,4 @@");
    expect(hunks[1].header).toBe("@@ -10,3 +11,3 @@");
  });

  it("mantém as linhas de cada trecho no lugar", () => {
    const { hunks } = splitDiffHunks(DIFF);

    expect(hunks[0].body).toEqual([" linha 1", "+linha nova", " linha 2", " linha 3"]);
    expect(hunks[1].body).toEqual([" linha 10", "-linha 11", "+linha onze", " linha 12"]);
  });

  it("recompõe o diff original sem perder linhas", () => {
    const { headerLines, hunks } = splitDiffHunks(DIFF);
    const rebuilt = [...headerLines, ...hunks.flatMap((hunk) => [hunk.header, ...hunk.body])];

    expect(rebuilt).toEqual(DIFF.split("\n").slice(0, -1));
  });

  it("lida com diff vazio ou binário sem trechos", () => {
    expect(splitDiffHunks("")).toEqual({ headerLines: [], hunks: [] });
    expect(splitDiffHunks("Binary files a/x.png and b/x.png differ")).toEqual({
      headerLines: ["Binary files a/x.png and b/x.png differ"],
      hunks: [],
    });
  });
});
