export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFile {
  path: string;
  status: GitFileStatus;
  isStaged: boolean;
  /** O arquivo também tem alterações fora do índice (aparece nas duas listas). */
  isUnstaged?: boolean;
  isConflicted?: boolean;
}
