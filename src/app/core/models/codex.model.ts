export interface CodexCliStatus {
  installed: boolean;
  version?: string;
  command?: string;
  error?: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  upgrade?: string | null;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningOption[];
}

export interface CodexReasoningOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexUsageWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexUsage {
  planType?: string | null;
  limitName?: string | null;
  primary?: CodexUsageWindow | null;
  secondary?: CodexUsageWindow | null;
  rateLimitReachedType?: string | null;
  lifetimeTokens?: number | null;
}

export interface CodexRunResult {
  output: string;
}

export interface CodexMessage {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
}

export interface CodexSession {
  id: string;
  repositoryKey: string;
  repositoryPath: string;
  title: string;
  messages: CodexMessage[];
  createdAt: string;
  updatedAt: string;
  allowEdits: boolean;
  model?: string;
  reasoningEffort?: string;
}
