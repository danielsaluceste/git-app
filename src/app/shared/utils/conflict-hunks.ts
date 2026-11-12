export type ConflictChoice = "ours" | "theirs" | "both" | "custom";

export interface ConflictHunk {
  id: number;
  startLine: number;
  ours: string[];
  theirs: string[];
  base: string[];
}

export type ConflictSegment =
  | { kind: "context"; lines: string[] }
  | { kind: "hunk"; hunk: ConflictHunk };

export interface ConflictDocument {
  segments: ConflictSegment[];
  hunks: ConflictHunk[];
}

export interface ConflictResolution {
  choice?: ConflictChoice;
  custom?: string;
}

/**
 * Lê os marcadores de conflito do arquivo de trabalho (`<<<<<<<`, `|||||||`,
 * `=======` e `>>>>>>>`) e devolve os trechos conflitantes separados do
 * restante do arquivo. Suporta tanto o estilo merge (2 vias) quanto diff3.
 */
export function parseConflictMarkers(content: string): ConflictDocument | undefined {
  const lines = content.split("\n");
  const segments: ConflictSegment[] = [];
  const hunks: ConflictHunk[] = [];
  let context: string[] = [];
  let index = 0;

  const flushContext = (): void => {
    if (context.length > 0) {
      segments.push({ kind: "context", lines: context });
      context = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];

    if (!line.startsWith("<<<<<<<")) {
      context.push(line);
      index += 1;
      continue;
    }

    const startLine = index + 1;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];

    index += 1;

    while (
      index < lines.length &&
      !lines[index].startsWith("|||||||") &&
      !lines[index].startsWith("=======")
    ) {
      ours.push(lines[index]);
      index += 1;
    }

    if (index < lines.length && lines[index].startsWith("|||||||")) {
      index += 1;

      while (index < lines.length && !lines[index].startsWith("=======")) {
        base.push(lines[index]);
        index += 1;
      }
    }

    if (index >= lines.length || !lines[index].startsWith("=======")) {
      return undefined;
    }

    index += 1;

    while (index < lines.length && !lines[index].startsWith(">>>>>>>")) {
      theirs.push(lines[index]);
      index += 1;
    }

    if (index >= lines.length) {
      return undefined;
    }

    index += 1;
    flushContext();

    const hunk: ConflictHunk = {
      id: hunks.length,
      startLine,
      ours,
      theirs,
      base,
    };

    hunks.push(hunk);
    segments.push({ kind: "hunk", hunk });
  }

  flushContext();

  return hunks.length > 0 ? { segments, hunks } : undefined;
}

export function resolutionLines(
  hunk: ConflictHunk,
  resolution: ConflictResolution,
): string[] | undefined {
  switch (resolution.choice) {
    case "ours":
      return hunk.ours;
    case "theirs":
      return hunk.theirs;
    case "both":
      return [...hunk.ours, ...hunk.theirs];
    case "custom": {
      const custom = resolution.custom ?? "";
      return custom === "" ? [] : custom.split("\n");
    }
    default:
      return undefined;
  }
}

/**
 * Monta o conteúdo final. Retorna `undefined` enquanto algum trecho ainda não
 * tiver uma escolha, para impedir que o usuário resolva o conflito sem revisar.
 */
export function buildConflictContent(
  document: ConflictDocument,
  resolutions: Record<number, ConflictResolution>,
): string | undefined {
  const lines: string[] = [];

  for (const segment of document.segments) {
    if (segment.kind === "context") {
      lines.push(...segment.lines);
      continue;
    }

    const resolved = resolutionLines(
      segment.hunk,
      resolutions[segment.hunk.id] ?? {},
    );

    if (resolved === undefined) {
      return undefined;
    }

    lines.push(...resolved);
  }

  return lines.join("\n");
}
