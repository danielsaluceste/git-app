import { GitFileStatus } from "./git-file.model";

export interface CommitFile {
  path: string;
  status: GitFileStatus;
}
