export interface ShellInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
}

export interface TerminalOutputPayload {
  sessionId: string;
  data: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode?: number;
}

export interface TerminalTab {
  id: string;
  sessionId: string;
  title: string;
  shell?: string;
  cwd: string;
  isAlive: boolean;
}
