import { describe, expect, it } from "vitest";
import type { Commit } from "../../../core/models/commit.model";
import { computeCommitGraph, GRAPH_CONSTANTS } from "./git-graph";

function commit(hash: string, parents: string[] = [], references: string[] = []): Commit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject: `commit ${hash}`,
    authorName: "Daniel",
    authorEmail: "daniel@example.com",
    date: "2026-10-29T12:00:00-03:00",
    parents,
    references,
  };
}

describe("computeCommitGraph", () => {
  it("devolve um grafo vazio sem commits", () => {
    const result = computeCommitGraph([]);

    expect(result.rows).toEqual([]);
    expect(result.svgWidth).toBe(28);
  });

  it("mantém todos os commits na mesma lane em um histórico linear", () => {
    const commits = [
      commit("aaa", ["bbb"], ["HEAD -> main"]),
      commit("bbb", ["ccc"]),
      commit("ccc"),
    ];

    const { rows } = computeCommitGraph(commits, "main");

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.commit.hash)).toEqual(["aaa", "bbb", "ccc"]);
    expect(rows.every((row) => row.node.lane === 0)).toBe(true);
    expect(rows.every((row) => row.node.isMerge === false)).toBe(true);
    expect(rows[0].node.isHead).toBe(true);
    expect(rows[1].node.isHead).toBe(false);
  });

  it("desenha a segunda branch de um merge em outra lane", () => {
    const commits = [
      commit("merge", ["main-1", "feature-1"], ["HEAD -> main"]),
      commit("main-1", ["root"]),
      commit("feature-1", ["root"]),
      commit("root"),
    ];

    const { rows } = computeCommitGraph(commits, "main");

    expect(rows).toHaveLength(4);
    expect(rows[0].node.isMerge).toBe(true);
    expect(rows[0].paths.some((path) => path.type === "curve")).toBe(true);
    expect(rows[2].node.lane).toBeGreaterThan(0);
    expect(rows[3].node.lane).toBe(0);
  });

  it("nunca perde commits nem passa do limite de lanes", () => {
    const tips = Array.from({ length: 12 }, (_, index) => commit(`tip-${index}`, ["root"]));
    const commits = [...tips, commit("root")];

    const { rows, maxLanes, svgWidth } = computeCommitGraph(commits);

    expect(rows).toHaveLength(commits.length);
    expect(rows.every((row) => row.node.lane < GRAPH_CONSTANTS.MAX_LANES)).toBe(true);
    expect(maxLanes).toBeLessThanOrEqual(GRAPH_CONSTANTS.MAX_LANES);
    expect(svgWidth).toBeLessThanOrEqual(GRAPH_CONSTANTS.MAX_GRAPH_WIDTH);
  });

  it("respeita a largura máxima do grafo em históricos largos", () => {
    const commits = [
      ...Array.from({ length: 20 }, (_, index) => commit(`tip-${index}`, ["root"])),
      commit("root"),
    ];

    const { svgWidth, maxLanes } = computeCommitGraph(commits);

    expect(maxLanes).toBeLessThanOrEqual(GRAPH_CONSTANTS.MAX_LANES);
    expect(svgWidth).toBeLessThanOrEqual(GRAPH_CONSTANTS.MAX_GRAPH_WIDTH);
    expect(svgWidth).toBeGreaterThan(0);
  });
});
