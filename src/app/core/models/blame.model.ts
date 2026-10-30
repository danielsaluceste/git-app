export interface BlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  /** Segundos desde a época (UTC), como o `git blame` entrega. */
  authorTime: number;
  content: string;
}
