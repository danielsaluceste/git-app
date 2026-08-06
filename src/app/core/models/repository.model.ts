import { GitFile } from "./git-file.model";

export type RepositoryCloneSource = "local" | "url" | "github";
export type RepositoryAuthenticationSource = "system" | "github";

export interface Repository {
  name: string;
  path: string;
  workspaceId: string;
  cloneSource?: RepositoryCloneSource;
  authenticationSource?: RepositoryAuthenticationSource;
  githubConnectionId?: number;
  currentBranch?: string;
  isDirty?: boolean;
}

export interface LocalRepositoryInfo {
  name: string;
  path: string;
}

export interface RepositoryReferences {
  currentBranch?: string;
  localBranches: string[];
  remoteBranches: string[];
  tags: string[];
  stashes: string[];
}

export interface RepositoryRemote {
  name?: string;
  url?: string;
}

export type RepositoryOperationKind = "merge" | "rebase";

export interface RepositoryOperation {
  kind: RepositoryOperationKind;
  currentBranch?: string;
}

export interface RepositoryStatus {
  currentBranch?: string;
  isDirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  aheadCount: number;
  behindCount: number;
  conflictedCount: number;
  files: GitFile[];
}

export interface ConflictFile {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  result: string;
  baseExists: boolean;
  oursExists: boolean;
  theirsExists: boolean;
  resultExists: boolean;
  isBinary: boolean;
}
