import { Commit } from "../../../core/models/commit.model";

export const GRAPH_COLORS = [
  "#38bdf8", // Sky Blue
  "#34d399", // Emerald
  "#fb923c", // Orange
  "#a78bfa", // Purple
  "#f472b6", // Pink
  "#2dd4bf", // Teal
  "#facc15", // Amber
  "#818cf8", // Indigo
  "#f87171", // Coral Red
  "#a3e635", // Lime
];

export const GRAPH_CONSTANTS = {
  ROW_HEIGHT: 38,
  BASE_LANE_WIDTH: 13,
  MIN_LANE_WIDTH: 10,
  LANE_OFFSET_X: 10,
  NODE_RADIUS: 3.5,
  MERGE_NODE_RADIUS: 4.5,
  MAX_LANES: 7,
  MAX_GRAPH_WIDTH: 110,
};

export interface GraphNode {
  x: number;
  y: number;
  lane: number;
  color: string;
  isMerge: boolean;
  isHead: boolean;
  hasReferences: boolean;
}

export interface GraphPath {
  d: string;
  color: string;
  width: number;
  type: "straight" | "curve" | "pass";
}

export interface CommitGraphRow {
  commit: Commit;
  node: GraphNode;
  paths: GraphPath[];
  totalLanes: number;
}

export interface CommitGraphResult {
  rows: CommitGraphRow[];
  maxLanes: number;
  svgWidth: number;
}

interface ActiveLane {
  hash: string;
  colorIndex: number;
  hasIncoming: boolean;
  lastSeenRow: number;
}

function computeLaneWidth(maxConcurrentLanes: number): number {
  if (maxConcurrentLanes <= 3) {
    return 14;
  }
  if (maxConcurrentLanes <= 5) {
    return 12;
  }
  return 10;
}

function laneToX(lane: number, laneWidth: number): number {
  const boundedLane = Math.min(lane, GRAPH_CONSTANTS.MAX_LANES - 1);
  return GRAPH_CONSTANTS.LANE_OFFSET_X + boundedLane * laneWidth;
}

function getNextColorIndex(usedColors: Set<number>): number {
  for (let i = 0; i < GRAPH_COLORS.length; i++) {
    if (!usedColors.has(i)) {
      return i;
    }
  }
  return usedColors.size % GRAPH_COLORS.length;
}

function isHeadReference(references: string[]): boolean {
  if (!references || references.length === 0) return false;
  return references.some(
    (ref) => ref.includes("HEAD") || ref.startsWith("HEAD ->")
  );
}

function createSmoothCurve(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

export function computeCommitGraph(
  commits: Commit[],
  currentBranch?: string
): CommitGraphResult {
  if (!commits || commits.length === 0) {
    return { rows: [], maxLanes: 1, svgWidth: 28 };
  }

  // Pre-calculate commit lookup index for pruning inactive branches far in future
  const commitIndices = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    commitIndices.set(commits[i].hash, i);
  }

  const activeLanes: (ActiveLane | null)[] = [];
  const rawRows: {
    commit: Commit;
    laneIndex: number;
    colorIndex: number;
    isMerge: boolean;
    isHead: boolean;
    hasIncoming: boolean;
    passLanes: { lane: number; colorIndex: number }[];
    straightOut: boolean;
    firstParentCurve?: { targetLane: number };
    mergeCurves: { targetLane: number; colorIndex: number }[];
  }[] = [];

  let peakLanes = 1;

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
    const commit = commits[rowIndex];
    const hash = commit.hash;
    const parents = commit.parents || [];
    const isMerge = parents.length > 1;
    const isHead =
      isHeadReference(commit.references) ||
      (!!currentBranch &&
        commit.references?.some((ref) => ref.includes(currentBranch)));

    // 1. Locate or assign a lane for this commit
    let laneIndex = -1;
    let colorIndex = 0;
    let hasIncoming = false;

    for (let i = 0; i < activeLanes.length; i++) {
      const lane = activeLanes[i];
      if (lane && lane.hash === hash) {
        laneIndex = i;
        colorIndex = lane.colorIndex;
        hasIncoming = lane.hasIncoming;
        break;
      }
    }

    if (laneIndex === -1) {
      // Find the first available empty slot within MAX_LANES, or replace an idle lane
      let targetSlot = -1;

      // Look for a null slot within bounds
      for (let i = 0; i < Math.min(activeLanes.length, GRAPH_CONSTANTS.MAX_LANES); i++) {
        if (activeLanes[i] === null) {
          targetSlot = i;
          break;
        }
      }

      if (targetSlot === -1) {
        if (activeLanes.length < GRAPH_CONSTANTS.MAX_LANES) {
          targetSlot = activeLanes.length;
        } else {
          // Find the lane whose target commit is farthest away or not in window
          let farthestDist = -1;
          let candidateSlot = GRAPH_CONSTANTS.MAX_LANES - 1;

          for (let i = 0; i < GRAPH_CONSTANTS.MAX_LANES; i++) {
            const l = activeLanes[i];
            if (!l) {
              candidateSlot = i;
              break;
            }
            const nextIdx = commitIndices.get(l.hash) ?? 999999;
            const dist = nextIdx - rowIndex;
            if (dist > farthestDist) {
              farthestDist = dist;
              candidateSlot = i;
            }
          }
          targetSlot = candidateSlot;
        }
      }

      const usedColors = new Set(
        activeLanes
          .filter((l): l is ActiveLane => l !== null)
          .map((l) => l.colorIndex)
      );
      colorIndex = getNextColorIndex(usedColors);
      laneIndex = Math.min(targetSlot, GRAPH_CONSTANTS.MAX_LANES - 1);

      activeLanes[laneIndex] = {
        hash,
        colorIndex,
        hasIncoming: false,
        lastSeenRow: rowIndex,
      };
      hasIncoming = false;
    } else {
      // Ensure laneIndex stays within MAX_LANES limit
      laneIndex = Math.min(laneIndex, GRAPH_CONSTANTS.MAX_LANES - 1);
    }

    // Pass-through lines for other active lanes in this row
    const passLanes: { lane: number; colorIndex: number }[] = [];
    for (let i = 0; i < Math.min(activeLanes.length, GRAPH_CONSTANTS.MAX_LANES); i++) {
      const lane = activeLanes[i];
      if (lane && i !== laneIndex) {
        passLanes.push({ lane: i, colorIndex: lane.colorIndex });
      }
    }

    let straightOut = false;
    let firstParentCurve: { targetLane: number } | undefined;
    const mergeCurves: { targetLane: number; colorIndex: number }[] = [];

    // Outgoing connections to parents
    if (parents.length === 0) {
      activeLanes[laneIndex] = null;
    } else {
      const firstParent = parents[0];
      const existingFirstParentLane = activeLanes.findIndex(
        (lane, idx) => lane && idx < GRAPH_CONSTANTS.MAX_LANES && lane.hash === firstParent
      );

      if (
        existingFirstParentLane !== -1 &&
        existingFirstParentLane !== laneIndex
      ) {
        firstParentCurve = { targetLane: existingFirstParentLane };
        activeLanes[laneIndex] = null;
      } else {
        activeLanes[laneIndex] = {
          hash: firstParent,
          colorIndex,
          hasIncoming: true,
          lastSeenRow: rowIndex,
        };
        straightOut = true;
      }

      // Additional parents (merges)
      for (let p = 1; p < parents.length; p++) {
        const mergeParent = parents[p];
        const existingMergeLane = activeLanes.findIndex(
          (lane, idx) => lane && idx < GRAPH_CONSTANTS.MAX_LANES && lane.hash === mergeParent
        );

        if (existingMergeLane !== -1) {
          const mColor = activeLanes[existingMergeLane]!.colorIndex;
          mergeCurves.push({ targetLane: existingMergeLane, colorIndex: mColor });
        } else {
          // Allocate a new slot for the merge parent
          let newSlot = -1;
          for (let i = 0; i < Math.min(activeLanes.length, GRAPH_CONSTANTS.MAX_LANES); i++) {
            if (activeLanes[i] === null) {
              newSlot = i;
              break;
            }
          }

          if (newSlot === -1 && activeLanes.length < GRAPH_CONSTANTS.MAX_LANES) {
            newSlot = activeLanes.length;
          }

          if (newSlot !== -1 && newSlot < GRAPH_CONSTANTS.MAX_LANES) {
            const usedColors = new Set(
              activeLanes
                .filter((l): l is ActiveLane => l !== null)
                .map((l) => l.colorIndex)
            );
            const branchColorIndex = getNextColorIndex(usedColors);

            activeLanes[newSlot] = {
              hash: mergeParent,
              colorIndex: branchColorIndex,
              hasIncoming: true,
              lastSeenRow: rowIndex,
            };

            mergeCurves.push({ targetLane: newSlot, colorIndex: branchColorIndex });
          }
        }
      }
    }

    // Clean up trailing nulls
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }

    peakLanes = Math.max(peakLanes, Math.min(activeLanes.length, GRAPH_CONSTANTS.MAX_LANES), laneIndex + 1);

    rawRows.push({
      commit,
      laneIndex,
      colorIndex,
      isMerge,
      isHead,
      hasIncoming,
      passLanes,
      straightOut,
      firstParentCurve,
      mergeCurves,
    });
  }

  // Determine dynamic lane width based on actual peak lanes
  const effectiveMaxLanes = Math.min(peakLanes, GRAPH_CONSTANTS.MAX_LANES);
  const laneWidth = computeLaneWidth(effectiveMaxLanes);

  const rows: CommitGraphRow[] = rawRows.map((r) => {
    const nodeX = laneToX(r.laneIndex, laneWidth);
    const nodeY = GRAPH_CONSTANTS.ROW_HEIGHT / 2;
    const nodeColor = GRAPH_COLORS[r.colorIndex % GRAPH_COLORS.length];

    const node: GraphNode = {
      x: nodeX,
      y: nodeY,
      lane: r.laneIndex,
      color: nodeColor,
      isMerge: r.isMerge,
      isHead: r.isHead,
      hasReferences: r.commit.references && r.commit.references.length > 0,
    };

    const paths: GraphPath[] = [];

    // Pass lines
    for (const pl of r.passLanes) {
      const plX = laneToX(pl.lane, laneWidth);
      const plColor = GRAPH_COLORS[pl.colorIndex % GRAPH_COLORS.length];
      paths.push({
        d: `M ${plX} 0 L ${plX} ${GRAPH_CONSTANTS.ROW_HEIGHT}`,
        color: plColor,
        width: 1.8,
        type: "pass",
      });
    }

    // Incoming straight
    if (r.hasIncoming) {
      paths.push({
        d: `M ${nodeX} 0 L ${nodeX} ${nodeY}`,
        color: nodeColor,
        width: 1.8,
        type: "straight",
      });
    }

    // Outgoing straight
    if (r.straightOut) {
      paths.push({
        d: `M ${nodeX} ${nodeY} L ${nodeX} ${GRAPH_CONSTANTS.ROW_HEIGHT}`,
        color: nodeColor,
        width: 1.8,
        type: "straight",
      });
    }

    // Outgoing first parent curve
    if (r.firstParentCurve) {
      const targetX = laneToX(r.firstParentCurve.targetLane, laneWidth);
      paths.push({
        d: createSmoothCurve(nodeX, nodeY, targetX, GRAPH_CONSTANTS.ROW_HEIGHT),
        color: nodeColor,
        width: 1.8,
        type: "curve",
      });
    }

    // Outgoing merge curves
    for (const mc of r.mergeCurves) {
      const targetX = laneToX(mc.targetLane, laneWidth);
      const mColor = GRAPH_COLORS[mc.colorIndex % GRAPH_COLORS.length];
      paths.push({
        d: createSmoothCurve(nodeX, nodeY, targetX, GRAPH_CONSTANTS.ROW_HEIGHT),
        color: mColor,
        width: 1.8,
        type: "curve",
      });
    }

    return {
      commit: r.commit,
      node,
      paths,
      totalLanes: effectiveMaxLanes,
    };
  });

  // Calculate SVG width with strict capping
  const calculatedWidth =
    GRAPH_CONSTANTS.LANE_OFFSET_X * 2 +
    (effectiveMaxLanes - 1) * laneWidth +
    8;

  const svgWidth = Math.min(
    Math.max(28, calculatedWidth),
    GRAPH_CONSTANTS.MAX_GRAPH_WIDTH
  );

  return {
    rows,
    maxLanes: effectiveMaxLanes,
    svgWidth,
  };
}
