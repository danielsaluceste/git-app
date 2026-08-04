export interface Repository {
  name: string;
  path: string;
  workspaceId: string;
  currentBranch?: string;
  isDirty?: boolean;
}

export interface LocalRepositoryInfo {
  name: string;
  path: string;
}
