import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal,
} from "@angular/core";
import { DomSanitizer, SafeHtml } from "@angular/platform-browser";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CodexMessage, CodexSession } from "../../core/models/codex.model";
import { Repository } from "../../core/models/repository.model";
import { CodexService } from "../../core/services/codex.service";
import { CodexSessionService } from "../../core/services/codex-session.service";
import { TranslationService } from "../../core/services/translation.service";
import { TranslatePipe } from "../../shared/pipes/translate.pipe";

const CODEX_DOCUMENTATION_URL = "https://developers.openai.com/codex/cli/";

@Component({
  selector: "app-codex-sidebar",
  imports: [TranslatePipe],
  templateUrl: "./codex-sidebar.component.html",
  styleUrl: "./codex-sidebar.component.css",
})
export class CodexSidebarComponent implements OnChanges {
  @Input({ required: true }) repository!: Repository;
  @Output() closeRequested = new EventEmitter<void>();

  private readonly codexService = inject(CodexService);
  private readonly sessionService = inject(CodexSessionService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly translationService = inject(TranslationService);
  private nextMessageId = 0;
  private readonly formattedMessages = new Map<string, SafeHtml>();

  readonly status = this.codexService.status;
  readonly isChecking = this.codexService.isChecking;
  readonly isRunning = this.codexService.isRunning;
  readonly sessions = signal<CodexSession[]>([]);
  readonly activeSessionId = signal("");
  readonly activeSession = computed(() =>
    this.sessions().find((session) => session.id === this.activeSessionId()),
  );
  readonly messages = signal<CodexMessage[]>([]);
  prompt = "";
  allowEdits = false;
  sessionMenuOpen = false;
  editingSessionId: string | undefined;
  editingSessionTitle = "";

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["repository"] && !changes["repository"].firstChange) {
      this.messages.set([]);
      this.prompt = "";
    }

    if (changes["repository"]) {
      this.loadSessions();
      void this.checkCli();
    }
  }

  createSession(): void {
    if (this.isRunning()) {
      return;
    }

    const session = this.sessionService.create(this.repository);
    this.refreshSessions(session.id);
    this.sessionMenuOpen = false;
    this.editingSessionId = undefined;
    this.prompt = "";
  }

  selectSession(sessionId: string): void {
    if (this.isRunning() || sessionId === this.activeSessionId()) {
      this.sessionMenuOpen = false;
      return;
    }

    this.sessionService.setActive(this.repository, sessionId);
    this.loadSessions(sessionId);
    this.sessionMenuOpen = false;
    this.editingSessionId = undefined;
    this.prompt = "";
  }

  beginRename(session: CodexSession, event: Event): void {
    event.stopPropagation();
    this.editingSessionId = session.id;
    this.editingSessionTitle = session.title;
  }

  finishRename(sessionId: string): void {
    this.sessionService.rename(sessionId, this.editingSessionTitle);
    this.refreshSessions(this.activeSessionId());
    this.editingSessionId = undefined;
    this.editingSessionTitle = "";
  }

  cancelRename(): void {
    this.editingSessionId = undefined;
    this.editingSessionTitle = "";
  }

  deleteSession(session: CodexSession, event: Event): void {
    event.stopPropagation();
    const confirmed = window.confirm(
      this.translationService.translate("codex.deleteSessionConfirm", { title: session.title }),
    );
    if (!confirmed || this.isRunning()) {
      return;
    }

    const wasActive = session.id === this.activeSessionId();
    this.sessionService.delete(session.id);
    let sessions = this.sessionService.sessionsFor(this.repository);
    if (sessions.length === 0) {
      const newSession = this.sessionService.create(this.repository);
      sessions = this.sessionService.sessionsFor(this.repository);
      this.refreshSessions(newSession.id);
    } else {
      const nextId = wasActive
        ? this.sessionService.activeSessionIdFor(this.repository) ?? sessions[0].id
        : this.activeSessionId();
      this.loadSessions(nextId);
    }
  }

  onSessionTitleKeydown(event: KeyboardEvent, sessionId: string): void {
    if (event.key === "Enter") {
      event.preventDefault();
      this.finishRename(sessionId);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.cancelRename();
    }
  }

  setAllowEdits(event: Event): void {
    this.allowEdits = (event.target as HTMLInputElement).checked;
    this.sessionService.saveAllowEdits(this.activeSessionId(), this.allowEdits);
  }

  async checkCli(): Promise<void> {
    await this.codexService.check();
  }

  async send(): Promise<void> {
    const prompt = this.prompt.trim();
    if (!prompt || this.isRunning()) {
      return;
    }

    const status = this.status() ?? await this.codexService.check();
    if (!status.installed) {
      return;
    }

    const repositoryPath = this.repository.path;
    const sessionId = this.activeSessionId();
    const context = this.messages()
      .slice(-8)
      .map((message) => `${message.role === "user" ? "Usuário" : "Codex"}: ${message.content}`)
      .join("\n\n");

    this.addMessageToSession(sessionId, "user", prompt);
    this.prompt = "";

    try {
      const result = await this.codexService.run(repositoryPath, prompt, context, this.allowEdits);
      if (repositoryPath === this.repository.path) {
        this.addMessageToSession(sessionId, "assistant", result.output);
      }
    } catch (error: unknown) {
      if (repositoryPath === this.repository.path) {
        this.addMessageToSession(sessionId, "error", this.errorMessage(error));
      }
    }
  }

  onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void this.send();
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.codexService.cancel();
    } catch {
      // A solicitação pode ter terminado entre o clique e o cancelamento.
    }
  }

  async openDocumentation(): Promise<void> {
    try {
      await openUrl(CODEX_DOCUMENTATION_URL);
    } catch {
      window.open(CODEX_DOCUMENTATION_URL, "_blank", "noopener,noreferrer");
    }
  }

  formatMessage(content: string): SafeHtml {
    const cached = this.formattedMessages.get(content);
    if (cached) {
      return cached;
    }

    const formatted = this.sanitizer.bypassSecurityTrustHtml(this.markdownToHtml(content));
    this.formattedMessages.set(content, formatted);
    return formatted;
  }

  private loadSessions(preferredSessionId?: string): void {
    let sessions = this.sessionService.sessionsFor(this.repository);
    if (sessions.length === 0) {
      this.sessionService.create(this.repository);
      sessions = this.sessionService.sessionsFor(this.repository);
    }

    const sessionId = preferredSessionId
      ?? this.sessionService.activeSessionIdFor(this.repository)
      ?? sessions[0].id;
    this.refreshSessions(sessionId);
  }

  private refreshSessions(preferredSessionId?: string): void {
    const sessions = this.sessionService.sessionsFor(this.repository);
    const session = sessions.find((item) => item.id === preferredSessionId) ?? sessions[0];
    if (!session) {
      return;
    }

    this.sessions.set(sessions);
    this.activeSessionId.set(session.id);
    this.sessionService.setActive(this.repository, session.id);
    this.messages.set([...session.messages]);
    this.allowEdits = session.allowEdits;
    this.nextMessageId = session.messages.reduce((highest, message) => Math.max(highest, message.id), 0);
  }

  private addMessageToSession(
    sessionId: string,
    role: CodexMessage["role"],
    content: string,
  ): void {
    const session = this.sessionService.get(sessionId);
    if (!session) {
      return;
    }

    const message = { id: ++this.nextMessageId, role, content };
    this.sessionService.saveMessages(sessionId, [...session.messages, message]);
    if (sessionId === this.activeSessionId()) {
      this.messages.set([...(this.sessionService.get(sessionId)?.messages ?? [])]);
      this.sessions.set(this.sessionService.sessionsFor(this.repository));
    }
  }

  private errorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return this.translationService.translate("codex.genericError");
  }

  private markdownToHtml(markdown: string): string {
    const lines = this.escapeHtml(markdown).replace(/\r\n?/g, "\n").split("\n");
    const html: string[] = [];
    const paragraph: string[] = [];
    let listType: "ul" | "ol" | undefined;
    let inCodeBlock = false;
    let codeLanguage = "";
    let codeLines: string[] = [];

    const closeList = (): void => {
      if (listType) {
        html.push(`</${listType}>`);
        listType = undefined;
      }
    };

    const closeParagraph = (): void => {
      if (paragraph.length > 0) {
        html.push(`<p>${this.formatInline(paragraph.join("<br>"))}</p>`);
        paragraph.length = 0;
      }
    };

    for (const line of lines) {
      const fence = line.match(/^\s*```([\w-]*)\s*$/);

      if (fence) {
        closeParagraph();
        closeList();

        if (inCodeBlock) {
          const language = codeLanguage ? `<span class="codex-code-language">${codeLanguage}</span>` : "";
          html.push(
            `<div class="codex-code-wrapper">${language}<pre><code>${codeLines.join("\n")}</code></pre></div>`,
          );
          codeLines = [];
          codeLanguage = "";
        } else {
          codeLanguage = fence[1];
        }

        inCodeBlock = !inCodeBlock;
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      if (!line.trim()) {
        closeParagraph();
        closeList();
        continue;
      }

      const heading = line.match(/^\s*(#{1,3})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        closeParagraph();
        closeList();
        const level = heading[1].length;
        html.push(`<h${level}>${this.formatInline(heading[2])}</h${level}>`);
        continue;
      }

      const unorderedItem = line.match(/^\s*[-*+]\s+(.+)$/);
      const orderedItem = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unorderedItem || orderedItem) {
        closeParagraph();
        const nextListType = unorderedItem ? "ul" : "ol";
        if (listType !== nextListType) {
          closeList();
          listType = nextListType;
          html.push(`<${listType}>`);
        }
        html.push(`<li>${this.formatInline((unorderedItem ?? orderedItem)![1])}</li>`);
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        closeParagraph();
        closeList();
        html.push(`<blockquote>${this.formatInline(quote[1])}</blockquote>`);
        continue;
      }

      if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
        closeParagraph();
        closeList();
        html.push("<hr>");
        continue;
      }

      closeList();
      paragraph.push(line);
    }

    if (inCodeBlock) {
      const language = codeLanguage ? `<span class="codex-code-language">${codeLanguage}</span>` : "";
      html.push(
        `<div class="codex-code-wrapper">${language}<pre><code>${codeLines.join("\n")}</code></pre></div>`,
      );
    }
    closeParagraph();
    closeList();

    return html.join("");
  }

  private formatInline(text: string): string {
    const codeSpans: string[] = [];
    let formatted = text.replace(/`([^`]+)`/g, (_match, code: string) => {
      const token = `@@CODE_SPAN_${codeSpans.length}@@`;
      codeSpans.push(`<code>${code}</code>`);
      return token;
    });

    formatted = formatted
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="codex-reference" title="$2">$1</span>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>");

    return formatted.replace(/@@CODE_SPAN_(\d+)@@/g, (_match, index: string) => codeSpans[Number(index)]);
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}
