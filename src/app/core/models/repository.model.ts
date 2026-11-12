import { GitFile } from "./git-file.model";

export type RepositoryCloneSource = "local" | "url" | "github";
export type RepositoryAuthenticationSource = "system" | "github" | "ssh";

export interface Repository {
  name: string;
  path: string;
  workspaceId: string;
  cloneSource?: RepositoryCloneSource;
  authenticationSource?: RepositoryAuthenticationSource;
  githubConnectionId?: number;
  sshKeyPath?: string;
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

export interface RepositorySignature {
  signature: string;
  headHash?: string;
}

export type RepositoryOperationKind = "merge" | "rebase" | "cherry-pick";

export interface RepositoryOperation {
  kind: RepositoryOperationKind;
  currentBranch?: string;
  targetBranch?: string;
  sourceBranch?: string;
  sourceCommit?: string;
  sourceSubject?: string;
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

export interface PullResult {
  autoStashed: boolean;
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
