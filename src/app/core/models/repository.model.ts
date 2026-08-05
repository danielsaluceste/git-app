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

export interface RepositoryStatus {
  currentBranch?: string;
  isDirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  aheadCount: number;
  behindCount: number;
  files: GitFile[];
}
