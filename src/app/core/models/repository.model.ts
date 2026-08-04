export interface Repository {
  name: string;
  path: string;
  currentBranch?: string;
  isDirty?: boolean;
}
