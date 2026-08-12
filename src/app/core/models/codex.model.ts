export interface CodexCliStatus {
  installed: boolean;
  version?: string;
  command?: string;
  error?: string;
}

export interface CodexRunResult {
  output: string;
}

export interface CodexMessage {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
}
