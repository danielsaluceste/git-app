export interface Commit {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  avatarUrl?: string;
  date: string;
  parents: string[];
  references: string[];
}
