export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface GitFile {
  path: string;
  status: GitFileStatus;
  isStaged: boolean;
}
