/**
 * Separa um diff de um único arquivo em cabeçalho e trechos (`@@`). O índice
 * de cada trecho é a posição em que ele aparece — a mesma numeração usada pelo
 * backend para reconstruir o patch ao preparar/despreparar um hunk.
 */
export interface DiffHunk {
  index: number;
  header: string;
  body: string[];
}

export interface DiffSegments {
  headerLines: string[];
  hunks: DiffHunk[];
}

export function splitDiffHunks(diff: string): DiffSegments {
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { index: hunks.length, header: line, body: [] };
      hunks.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      headerLines.push(line);
    }
  }

  return { headerLines, hunks };
}
