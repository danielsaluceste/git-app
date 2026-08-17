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
  LANE_WIDTH: 18,
  LANE_OFFSET_X: 12,
  NODE_RADIUS: 4.5,
  MERGE_NODE_RADIUS: 5.5,
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
}

function laneToX(lane: number): number {
  return GRAPH_CONSTANTS.LANE_OFFSET_X + lane * GRAPH_CONSTANTS.LANE_WIDTH;
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
    return { rows: [], maxLanes: 1, svgWidth: 32 };
  }

  const activeLanes: (ActiveLane | null)[] = [];
  const rows: CommitGraphRow[] = [];
  let globalMaxLanes = 1;

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
      // Find the first available empty slot or append
      const emptySlot = activeLanes.indexOf(null);
      const usedColors = new Set(
        activeLanes
          .filter((l): l is ActiveLane => l !== null)
          .map((l) => l.colorIndex)
      );
      colorIndex = getNextColorIndex(usedColors);

      if (emptySlot !== -1) {
        laneIndex = emptySlot;
        activeLanes[emptySlot] = { hash, colorIndex, hasIncoming: false };
      } else {
        laneIndex = activeLanes.length;
        activeLanes.push({ hash, colorIndex, hasIncoming: false });
      }
      hasIncoming = false;
    }

    const nodeX = laneToX(laneIndex);
    const nodeY = GRAPH_CONSTANTS.ROW_HEIGHT / 2;
    const nodeColor = GRAPH_COLORS[colorIndex % GRAPH_COLORS.length];

    const node: GraphNode = {
      x: nodeX,
      y: nodeY,
      lane: laneIndex,
      color: nodeColor,
      isMerge,
      isHead,
      hasReferences: commit.references && commit.references.length > 0,
    };

    const paths: GraphPath[] = [];

    // 2. Pass-through lines for other active lanes in this row
    for (let i = 0; i < activeLanes.length; i++) {
      const lane = activeLanes[i];
      if (lane && i !== laneIndex) {
        const laneX = laneToX(i);
        const laneColor = GRAPH_COLORS[lane.colorIndex % GRAPH_COLORS.length];
        paths.push({
          d: `M ${laneX} 0 L ${laneX} ${GRAPH_CONSTANTS.ROW_HEIGHT}`,
          color: laneColor,
          width: 2,
          type: "pass",
        });
      }
    }

    // 3. Incoming connection to this node from top
    if (hasIncoming) {
      paths.push({
        d: `M ${nodeX} 0 L ${nodeX} ${nodeY}`,
        color: nodeColor,
        width: 2,
        type: "straight",
      });
    }

    // 4. Outgoing connections to parents
    if (parents.length === 0) {
      // Root commit (no parents): this lineage ends here
      activeLanes[laneIndex] = null;
    } else {
      const firstParent = parents[0];
      const existingFirstParentLane = activeLanes.findIndex(
        (lane) => lane && lane.hash === firstParent
      );

      if (
        existingFirstParentLane !== -1 &&
        existingFirstParentLane !== laneIndex
      ) {
        // First parent is already tracked on another lane (branch merged/rejoined)
        const targetX = laneToX(existingFirstParentLane);
        paths.push({
          d: createSmoothCurve(
            nodeX,
            nodeY,
            targetX,
            GRAPH_CONSTANTS.ROW_HEIGHT
          ),
          color: nodeColor,
          width: 2,
          type: "curve",
        });
        activeLanes[laneIndex] = null;
      } else {
        // First parent continues on this lane
        activeLanes[laneIndex] = {
          hash: firstParent,
          colorIndex,
          hasIncoming: true,
        };
        paths.push({
          d: `M ${nodeX} ${nodeY} L ${nodeX} ${GRAPH_CONSTANTS.ROW_HEIGHT}`,
          color: nodeColor,
          width: 2,
          type: "straight",
        });
      }

      // Additional parents (merge commit)
      for (let p = 1; p < parents.length; p++) {
        const mergeParent = parents[p];
        const existingMergeLane = activeLanes.findIndex(
          (lane) => lane && lane.hash === mergeParent
        );

        if (existingMergeLane !== -1) {
          // Parent already active on another lane
          const targetX = laneToX(existingMergeLane);
          const laneColor =
            GRAPH_COLORS[
              activeLanes[existingMergeLane]!.colorIndex % GRAPH_COLORS.length
            ];
          paths.push({
            d: createSmoothCurve(
              nodeX,
              nodeY,
              targetX,
              GRAPH_CONSTANTS.ROW_HEIGHT
            ),
            color: laneColor,
            width: 2,
            type: "curve",
          });
        } else {
          // Allocate a new lane for this merged parent branch
          const emptySlot = activeLanes.indexOf(null);
          const usedColors = new Set(
            activeLanes
              .filter((l): l is ActiveLane => l !== null)
              .map((l) => l.colorIndex)
          );
          const branchColorIndex = getNextColorIndex(usedColors);
          const branchColor =
            GRAPH_COLORS[branchColorIndex % GRAPH_COLORS.length];

          let newLaneIdx: number;
          if (emptySlot !== -1) {
            newLaneIdx = emptySlot;
            activeLanes[emptySlot] = {
              hash: mergeParent,
              colorIndex: branchColorIndex,
              hasIncoming: true,
            };
          } else {
            newLaneIdx = activeLanes.length;
            activeLanes.push({
              hash: mergeParent,
              colorIndex: branchColorIndex,
              hasIncoming: true,
            });
          }

          const targetX = laneToX(newLaneIdx);
          paths.push({
            d: createSmoothCurve(
              nodeX,
              nodeY,
              targetX,
              GRAPH_CONSTANTS.ROW_HEIGHT
            ),
            color: branchColor,
            width: 2,
            type: "curve",
          });
        }
      }
    }

    // Clean up trailing nulls to keep width optimal
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }

    const currentLanesCount = Math.max(activeLanes.length, laneIndex + 1);
    globalMaxLanes = Math.max(globalMaxLanes, currentLanesCount);

    rows.push({
      commit,
      node,
      paths,
      totalLanes: currentLanesCount,
    });
  }

  // Calculate SVG column width with minimum 32px and padding
  const svgWidth = Math.max(
    32,
    GRAPH_CONSTANTS.LANE_OFFSET_X * 2 +
      (globalMaxLanes - 1) * GRAPH_CONSTANTS.LANE_WIDTH +
      8
  );

  return {
    rows,
    maxLanes: globalMaxLanes,
    svgWidth,
  };
}
