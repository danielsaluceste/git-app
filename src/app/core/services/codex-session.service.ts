import { Injectable } from "@angular/core";
import { CodexMessage, CodexSession } from "../models/codex.model";
import { Repository } from "../models/repository.model";

const STORAGE_KEY = "git-app.codex-sessions";
const MAX_SESSIONS_PER_REPOSITORY = 20;
const MAX_MESSAGES_PER_SESSION = 32;
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_PERSISTED_SESSIONS = 8;
const MAX_PERSISTED_MESSAGES_PER_SESSION = 20;
const MAX_PERSISTED_MESSAGE_LENGTH = 8_000;

interface StoredCodexState {
  sessions: CodexSession[];
  activeByRepository: Record<string, string>;
}

@Injectable({ providedIn: "root" })
export class CodexSessionService {
  private state: StoredCodexState = this.load();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.persistNow(), { once: true });
    }
  }

  sessionsFor(repository: Repository): CodexSession[] {
    const key = this.repositoryKey(repository);

    return this.state.sessions
      .filter((session) => session.repositoryKey === key)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  activeSessionIdFor(repository: Repository): string | undefined {
    const key = this.repositoryKey(repository);
    const activeId = this.state.activeByRepository[key];

    return this.sessionsFor(repository).some((session) => session.id === activeId)
      ? activeId
      : undefined;
  }

  get(sessionId: string): CodexSession | undefined {
    return this.find(sessionId);
  }

  create(repository: Repository): CodexSession {
    const now = new Date().toISOString();
    const session: CodexSession = {
      id: this.createId(),
      repositoryKey: this.repositoryKey(repository),
      repositoryPath: repository.path,
      title: "Nova sessão",
      messages: [],
      createdAt: now,
      updatedAt: now,
      allowEdits: false,
    };

    const otherRepositorySessions = this.state.sessions.filter(
      (item) => item.repositoryKey !== session.repositoryKey,
    );
    const repositorySessions = [session, ...this.sessionsFor(repository)].slice(
      0,
      MAX_SESSIONS_PER_REPOSITORY,
    );
    this.state.sessions = [...otherRepositorySessions, ...repositorySessions];
    this.state.activeByRepository[session.repositoryKey] = session.id;
    this.persist();
    return session;
  }

  setActive(repository: Repository, sessionId: string): void {
    const session = this.sessionsFor(repository).find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    this.state.activeByRepository[session.repositoryKey] = session.id;
    this.persist();
  }

  saveMessages(sessionId: string, messages: CodexMessage[]): void {
    const session = this.find(sessionId);
    if (!session) {
      return;
    }

    session.messages = messages
      .filter((message): message is CodexMessage => this.isMessage(message))
      .slice(-MAX_MESSAGES_PER_SESSION)
      .map((message) => ({
        ...message,
        content: message.content.slice(0, MAX_MESSAGE_LENGTH),
      }));
    session.updatedAt = new Date().toISOString();

    const firstUserMessage = session.messages.find((message) => message.role === "user");
    if (session.title === "Nova sessão" && firstUserMessage) {
      session.title = this.titleFromPrompt(firstUserMessage.content);
    }

    this.persist();
  }

  saveAllowEdits(sessionId: string, allowEdits: boolean): void {
    const session = this.find(sessionId);
    if (!session) {
      return;
    }

    session.allowEdits = allowEdits;
    this.persist();
  }

  saveModel(sessionId: string, model: string | undefined): void {
    const session = this.find(sessionId);
    if (!session) {
      return;
    }

    session.model = model?.trim() || undefined;
    session.updatedAt = new Date().toISOString();
    this.persist();
  }

  saveReasoningEffort(sessionId: string, reasoningEffort: string | undefined): void {
    const session = this.find(sessionId);
    if (!session) {
      return;
    }

    session.reasoningEffort = reasoningEffort?.trim() || undefined;
    session.updatedAt = new Date().toISOString();
    this.persist();
  }

  rename(sessionId: string, title: string): void {
    const session = this.find(sessionId);
    const cleanTitle = title.trim().slice(0, 80);
    if (!session || !cleanTitle) {
      return;
    }

    session.title = cleanTitle;
    session.updatedAt = new Date().toISOString();
    this.persist();
  }

  delete(sessionId: string): void {
    const session = this.find(sessionId);
    if (!session) {
      return;
    }

    this.state.sessions = this.state.sessions.filter((item) => item.id !== sessionId);
    if (this.state.activeByRepository[session.repositoryKey] === sessionId) {
      const next = this.state.sessions
        .filter((item) => item.repositoryKey === session.repositoryKey)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

      if (next) {
        this.state.activeByRepository[session.repositoryKey] = next.id;
      } else {
        delete this.state.activeByRepository[session.repositoryKey];
      }
    }

    this.persist();
  }

  private find(sessionId: string): CodexSession | undefined {
    return this.state.sessions.find((session) => session.id === sessionId);
  }

  private repositoryKey(repository: Repository): string {
    return `${repository.workspaceId}:${this.normalizePath(repository.path)}`;
  }

  private normalizePath(path: string): string {
    return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }

  private titleFromPrompt(prompt: string): string {
    const firstLine = prompt.split(/\r?\n/, 1)[0].trim();
    return firstLine.length > 54 ? `${firstLine.slice(0, 54).trimEnd()}…` : firstLine;
  }

  private createId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private load(): StoredCodexState {
    const empty: StoredCodexState = { sessions: [], activeByRepository: {} };
    if (typeof localStorage === "undefined") {
      return empty;
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Partial<StoredCodexState>) : undefined;
      if (!parsed || !Array.isArray(parsed.sessions)) {
        return empty;
      }

      return {
        sessions: parsed.sessions.filter((session): session is CodexSession => this.isSession(session)),
        activeByRepository:
          parsed.activeByRepository && typeof parsed.activeByRepository === "object"
            ? parsed.activeByRepository
            : {},
      };
    } catch {
      return empty;
    }
  }

  private isSession(value: unknown): value is CodexSession {
    if (!value || typeof value !== "object") {
      return false;
    }

    const session = value as Partial<CodexSession>;
    return (
      typeof session.id === "string" &&
      typeof session.repositoryKey === "string" &&
      typeof session.repositoryPath === "string" &&
      typeof session.title === "string" &&
      Array.isArray(session.messages) &&
      session.messages.every((message) => this.isMessage(message)) &&
      typeof session.createdAt === "string" &&
      typeof session.updatedAt === "string"
    );
  }

  private isMessage(value: unknown): value is CodexMessage {
    if (!value || typeof value !== "object") {
      return false;
    }

    const message = value as Partial<CodexMessage>;
    return (
      typeof message.id === "number" &&
      (message.role === "user" || message.role === "assistant" || message.role === "error") &&
      typeof message.content === "string"
    );
  }

  private persist(): void {
    if (this.persistTimer !== undefined) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 100);
  }

  private persistNow(): void {
    if (typeof localStorage === "undefined") {
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.persistenceState()));
      return;
    } catch {
      // Respostas com diffs podem ocupar bastante espaço. Reduza o histórico
      // local antes de deixar uma exceção interromper a conversa.
    }

    const compactedSessions = [...this.state.sessions]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 8)
      .map((session) => ({
        ...session,
        messages: session.messages.slice(-24).map((message) => ({
          ...message,
          content: message.content.slice(-12_000),
        })),
      }));

    this.state.sessions = compactedSessions;
    this.state.activeByRepository = Object.fromEntries(
      Object.entries(this.state.activeByRepository).filter(([, sessionId]) =>
        compactedSessions.some((session) => session.id === sessionId),
      ),
    );

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // O chat continua funcionando mesmo se o armazenamento do navegador
      // estiver indisponível ou tiver atingido o limite do WebView.
    }
  }

  private persistenceState(): StoredCodexState {
    const sessions = [...this.state.sessions]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_PERSISTED_SESSIONS)
      .map((session) => ({
        ...session,
        messages: session.messages
          .slice(-MAX_PERSISTED_MESSAGES_PER_SESSION)
          .map((message) => ({
            ...message,
            content: message.content.slice(-MAX_PERSISTED_MESSAGE_LENGTH),
          })),
      }));

    return {
      sessions,
      activeByRepository: Object.fromEntries(
        Object.entries(this.state.activeByRepository).filter(([, sessionId]) =>
          sessions.some((session) => session.id === sessionId),
        ),
      ),
    };
  }
}
