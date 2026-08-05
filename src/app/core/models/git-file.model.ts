export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFile {
  path: string;
  status: GitFileStatus;
  isStaged: boolean;
  isConflicted?: boolean;
}
