export interface UndoCandidate {
  currentHash: string;
  previousHash: string;
  /** Ação registrada no reflog: commit, merge, cherry-pick ou revert. */
  action: string;
  subject: string;
}
