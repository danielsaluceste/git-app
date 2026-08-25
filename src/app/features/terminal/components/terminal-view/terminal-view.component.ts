import {
  AfterViewInit,
  Component,
  ElementRef,
  effect,
  HostListener,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Subscription } from "rxjs";
import { TerminalTab } from "../../../../core/models/terminal.model";
import { TerminalService } from "../../../../core/services/terminal.service";
import { ThemeService } from "../../../../core/services/theme.service";

const FALLBACK_TERMINAL_THEME = {
  background: "#0f172a",
  foreground: "#f8fafc",
  cursor: "#38bdf8",
  cursorAccent: "#0f172a",
  selectionBackground: "rgba(56, 189, 248, 0.3)",
  selectionInactiveBackground: "rgba(56, 189, 248, 0.15)",
  black: "#1e293b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#38bdf8",
  white: "#f1f5f9",
  brightBlack: "#475569",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#e9d5ff",
  brightCyan: "#7dd3fc",
  brightWhite: "#ffffff",
};

@Component({
  selector: "app-terminal-view",
  standalone: true,
  template: `
    <div #terminalContainer class="terminal-container"></div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      .terminal-container {
        width: 100%;
        height: 100%;
        padding: 0.35rem 0.5rem;
        background: var(--app-bg);
      }
      :host ::ng-deep .xterm {
        height: 100%;
      }
      :host ::ng-deep .xterm-viewport {
        overflow-y: auto !important;
        background-color: transparent !important;
      }
      :host ::ng-deep .xterm-helper-textarea {
        position: absolute !important;
        opacity: 0 !important;
        left: -9999px !important;
        top: 0 !important;
        width: 0 !important;
        height: 0 !important;
        border: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        resize: none !important;
        overflow: hidden !important;
      }
    `,
  ],
})
export class TerminalViewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild("terminalContainer", { static: true })
  terminalContainer!: ElementRef<HTMLDivElement>;

  @Input({ required: true }) tab!: TerminalTab;
  @Input() isVisible = true;

  private readonly terminalService = inject(TerminalService);
  private readonly themeService = inject(ThemeService);
  private readonly themeEffect = effect(() => {
    this.themeService.theme();
    if (this.terminal) {
      this.terminal.options.theme = this.resolveTerminalTheme();
    }
  });
  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private outputSubscription?: Subscription;
  private resizeObserver?: ResizeObserver;

  ngAfterViewInit(): void {
    this.initTerminal();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["isVisible"] && this.isVisible && this.terminal) {
      setTimeout(() => {
        this.fit();
        this.terminal?.focus();
      }, 50);
    }
  }

  ngOnDestroy(): void {
    this.outputSubscription?.unsubscribe();
    this.resizeObserver?.disconnect();
    this.terminal?.dispose();
  }

  fit(): void {
    try {
      if (this.fitAddon && this.terminal && this.terminalContainer?.nativeElement.clientWidth > 0) {
        this.fitAddon.fit();
        const { cols, rows } = this.terminal;
        void this.terminalService.resize(this.tab.sessionId, rows, cols);
      }
    } catch {
      // ignore
    }
  }

  clear(): void {
    this.terminal?.clear();
  }

  focus(): void {
    this.terminal?.focus();
  }

  @HostListener("window:resize")
  onWindowResize(): void {
    this.fit();
  }

  private initTerminal(): void {
    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Code', 'Fira Code', 'Courier New', monospace",
      theme: this.resolveTerminalTheme(),
      allowTransparency: false,
      convertEol: true,
      scrollback: 5000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const webLinksAddon = new WebLinksAddon();
    this.terminal.loadAddon(webLinksAddon);

    this.terminal.open(this.terminalContainer.nativeElement);

    // On user input in terminal
    this.terminal.onData((data) => {
      void this.terminalService.write(this.tab.sessionId, data);
    });

    // Resize notification
    this.terminal.onResize(({ cols, rows }) => {
      void this.terminalService.resize(this.tab.sessionId, rows, cols);
    });

    // Listen for outputs destined for this session
    this.outputSubscription = this.terminalService.output$.subscribe((payload) => {
      if (payload.sessionId === this.tab.sessionId) {
        this.terminal?.write(payload.data);
      }
    });

    // Observe size changes of the container
    this.resizeObserver = new ResizeObserver(() => {
      if (this.isVisible) {
        this.fit();
      }
    });
    this.resizeObserver.observe(this.terminalContainer.nativeElement);

    // Initial fit
    setTimeout(() => {
      this.fit();
      if (this.isVisible) {
        this.terminal?.focus();
      }
    }, 100);
  }

  private resolveTerminalTheme(): typeof FALLBACK_TERMINAL_THEME {
    if (typeof document === "undefined") {
      return FALLBACK_TERMINAL_THEME;
    }

    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    return {
      background: token("--app-bg", FALLBACK_TERMINAL_THEME.background),
      foreground: token("--app-text-bright", FALLBACK_TERMINAL_THEME.foreground),
      cursor: token("--app-accent", FALLBACK_TERMINAL_THEME.cursor),
      cursorAccent: token("--app-bg", FALLBACK_TERMINAL_THEME.cursorAccent),
      selectionBackground: token("--app-accent-surface", FALLBACK_TERMINAL_THEME.selectionBackground),
      selectionInactiveBackground: token("--app-surface-3", FALLBACK_TERMINAL_THEME.selectionInactiveBackground),
      black: token("--app-surface-2", FALLBACK_TERMINAL_THEME.black),
      red: token("--app-danger", FALLBACK_TERMINAL_THEME.red),
      green: token("--app-positive", FALLBACK_TERMINAL_THEME.green),
      yellow: token("--app-yellow", FALLBACK_TERMINAL_THEME.yellow),
      blue: token("--app-info", FALLBACK_TERMINAL_THEME.blue),
      magenta: token("--app-purple", FALLBACK_TERMINAL_THEME.magenta),
      cyan: token("--app-info", FALLBACK_TERMINAL_THEME.cyan),
      white: token("--app-text", FALLBACK_TERMINAL_THEME.white),
      brightBlack: token("--app-muted-strong", FALLBACK_TERMINAL_THEME.brightBlack),
      brightRed: token("--app-danger-text", FALLBACK_TERMINAL_THEME.brightRed),
      brightGreen: token("--app-positive-strong", FALLBACK_TERMINAL_THEME.brightGreen),
      brightYellow: token("--app-accent-soft", FALLBACK_TERMINAL_THEME.brightYellow),
      brightBlue: token("--app-info-text", FALLBACK_TERMINAL_THEME.brightBlue),
      brightMagenta: token("--app-purple", FALLBACK_TERMINAL_THEME.brightMagenta),
      brightCyan: token("--app-info", FALLBACK_TERMINAL_THEME.brightCyan),
      brightWhite: token("--app-text-bright", FALLBACK_TERMINAL_THEME.brightWhite),
    };
  }
}
