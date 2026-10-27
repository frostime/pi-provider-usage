import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, ScrollView, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, Focusable, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { errorMessage, redactUsageError } from "./core.js";
import { formatProviderStates } from "./format.js";
import {
  applyAutoRefreshSetting,
  DEFAULT_REFRESH_MINUTES,
  MAX_REFRESH_MINUTES,
  parseAutoRefreshSetting,
  type OverlayAutoRefresh,
} from "./overlay-auto-refresh.js";
import type { ProviderUsageState } from "./types.js";

const OVERLAY_HOST_KEY = "frostime.provider-usage.overlay";

/** Panel width clamp: 40% of the terminal, but never wider than a readable data panel. */
const PANEL_WIDTH_SHARE = 0.4;
const PANEL_MIN_WIDTH = 44;
const PANEL_MAX_WIDTH = 72;
const FOOTER_FULL = "Ctrl+Alt+R refresh · Ctrl+Alt+A auto-refresh\nCtrl+Alt+Q close · Ctrl+Alt+↑/↓ scroll";
const FOOTER_COMPACT = "Ctrl+Alt: R refresh · A auto · Q close · ↑/↓ scroll";
const FOOTER_TINY = "Ctrl+Alt:\nR refresh\nA auto\nQ close\n↑/↓ scroll";

function panelWidth(terminalColumns: number): number {
  const share = Math.floor(terminalColumns * PANEL_WIDTH_SHARE);
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, share));
}

/** Queries one usage scope on open, retarget, manual refresh, and automatic refresh. */
export type UsageQuery = (signal: AbortSignal) => Promise<readonly ProviderUsageState[]>;

export interface UsageOverlayView {
  readonly closed: Promise<void>;
  close(): void;
  /** Show another scope in this same panel and query it immediately. */
  retarget(scope: string, query: UsageQuery): void;
}

/** Opens a query-only, non-capturing snapshot panel without awaiting its query or dismissal. */
export function openUsageOverlay(
  ctx: ExtensionContext,
  scope: string,
  query: UsageQuery,
  options: {
    autoRefresh?: OverlayAutoRefresh;
    onAutoRefreshChange?: (preference: OverlayAutoRefresh) => void;
  } = {},
): UsageOverlayView {
  const panel = new UsageOverlay(ctx, scope, query, options.autoRefresh, options.onAutoRefreshChange);
  // Pi 1.0.2's custom-dialog completion removes the stack's top overlay, not its own.
  // A zero-height widget supplies the supported TUI/lifecycle hook without changing editor
  // layout; the actual panel is a raw overlay whose handle removes only this instance.
  try {
    ctx.ui.setWidget(OVERLAY_HOST_KEY, (tui) => panel.attach(tui), { placement: "belowEditor" });
  } catch (error) {
    // A throwing factory has not been registered as a widget by the host.
    panel.close(false);
    throw error;
  }
  void panel.refresh();
  return { closed: panel.closed, close: () => panel.close(), retarget: (scope, query) => panel.retarget(scope, query) };
}

class UsageOverlay implements Component, UsageOverlayView {
  private tui?: TUI;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private handle?: OverlayHandle;
  private unsubscribe?: () => void;
  private isClosed = false;
  private generation = 0;
  private pending?: AbortController;
  private snapshot?: { states: readonly ProviderUsageState[]; timestamp: string };
  private failure?: string;
  private autoRefresh: OverlayAutoRefresh;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private settingsInput?: { close(): void };
  private readonly viewport: ScrollView;

  constructor(
    private readonly ctx: ExtensionContext,
    private scope: string,
    private query: UsageQuery,
    autoRefresh: OverlayAutoRefresh = { enabled: false, minutes: DEFAULT_REFRESH_MINUTES },
    private readonly onAutoRefreshChange?: (preference: OverlayAutoRefresh) => void,
  ) {
    this.autoRefresh = { ...autoRefresh };
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.viewport = new ScrollView(
      { render: (width) => this.renderReport(width), invalidate() {} },
      { scrollbar: "hidden", follow: "none" },
    );
  }

  attach(tui: TUI): Component & { dispose(): void } {
    this.tui = tui;
    const options: OverlayOptions = {
      nonCapturing: true,
      anchor: "top-right",
      // Absolute width: the host re-resolves a percentage on every render, so "40%" would keep
      // widening with the terminal instead of stopping at a readable maximum.
      width: panelWidth(tui.terminal?.columns ?? 80),
      maxHeight: "75%",
      margin: { top: 1, bottom: 1, left: 2, right: 2 },
      // The host calls this before resolving the layout and keeps this options object, so the
      // clamp also follows a terminal that grows or shrinks while the panel stays open.
      visible: (termWidth) => {
        options.width = panelWidth(termWidth);
        return true;
      },
    };
    this.handle = tui.showOverlay(this, options);
    this.listen(this.handle);
    return {
      render: () => [],
      invalidate() {},
      // The host is already removing this widget; don't recursively change its registry.
      dispose: () => this.close(false),
    };
  }

  private listen(handle: OverlayHandle): void {
    this.unsubscribe = this.ctx.ui.onTerminalInput((data) => {
      if (this.isClosed || handle.isHidden() || !handle.getBounds()) return;
      if (matchesKey(data, Key.ctrlAlt("q"))) this.close();
      else if (matchesKey(data, Key.ctrlAlt("a"))) this.configureAutoRefresh();
      else if (this.settingsInput) return;
      else if (matchesKey(data, Key.ctrlAlt("r"))) void this.refresh();
      else if (matchesKey(data, Key.ctrlAlt("up"))) this.viewport.scrollBy(-1);
      else if (matchesKey(data, Key.ctrlAlt("down"))) this.viewport.scrollBy(1);
      else return;
      return { consume: true };
    });
  }

  retarget(scope: string, query: UsageQuery): void {
    if (this.isClosed) return;
    this.scope = scope;
    this.query = query;
    void this.refresh();
  }

  async refresh(automatic = false): Promise<void> {
    if (this.isClosed || (automatic && this.pending)) return;
    this.clearRefreshTimer();
    const generation = ++this.generation;
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    this.failure = undefined;
    this.requestRender();
    try {
      const states = await this.query(controller.signal);
      if (this.isClosed || generation !== this.generation) return;
      this.snapshot = { states, timestamp: new Date().toLocaleTimeString() };
      if (!automatic) this.viewport.scrollToStart();
    } catch (error) {
      if (this.isClosed || generation !== this.generation) return;
      this.failure = redactUsageError(errorMessage(error));
    } finally {
      if (!this.isClosed && generation === this.generation) {
        this.pending = undefined;
        this.scheduleRefresh();
        this.requestRender();
      }
    }
  }

  private clearRefreshTimer(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private scheduleRefresh(): void {
    this.clearRefreshTimer();
    if (this.isClosed || !this.autoRefresh.enabled || this.pending) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(true);
    }, this.autoRefresh.minutes * 60_000);
  }

  private configureAutoRefresh(): void {
    const tui = this.tui;
    if (this.isClosed || this.settingsInput || !tui) return;
    const input = new Input();
    let validationError: string | undefined;
    let handle: OverlayHandle | undefined;
    const close = () => {
      handle?.hide();
      this.settingsInput = undefined;
      this.requestRender();
    };
    input.onEscape = close;
    input.onSubmit = (value) => {
      const text = value.trim().toLowerCase();
      if (!text) {
        close();
        return;
      }
      const setting = parseAutoRefreshSetting(/^\d+$/.test(text) ? Number(text) : text);
      if (setting === undefined) {
        validationError = `Use on, off, or whole minutes (1-${MAX_REFRESH_MINUTES}).`;
        this.requestRender();
        return;
      }
      this.autoRefresh = applyAutoRefreshSetting(setting, this.autoRefresh);
      this.onAutoRefreshChange?.({ ...this.autoRefresh });
      this.scheduleRefresh();
      close();
    };
    const preference = this.autoRefresh;
    const dialog: Component & Focusable = {
      get focused() { return input.focused; },
      set focused(value) { input.focused = value; },
      handleInput: (data) => {
        input.handleInput(data);
        this.requestRender();
      },
      invalidate: () => input.invalidate(),
      render: (width) => {
        const theme = this.ctx.ui.theme;
        if (width < 5) return input.render(width);
        const contentWidth = width - 4;
        const lines = [
          ...wrapTextWithAnsi(theme.fg("accent", "Overlay auto-refresh"), contentWidth),
          ...wrapTextWithAnsi(
            `Current: ${preference.enabled ? "on" : "off"} · Interval: ${preference.minutes} min`, contentWidth,
          ),
          "",
          ...wrapTextWithAnsi(theme.fg("muted", "on / off / minutes"), contentWidth),
          ...input.render(contentWidth),
          "",
          ...wrapTextWithAnsi(
            theme.fg(validationError ? "warning" : "dim", validationError ?? "Enter apply · Esc cancel"), contentWidth,
          ),
        ];
        const border = (text: string) => theme.fg("border", text);
        return [
          border(`╭${"─".repeat(width - 2)}╮`),
          ...lines.map((line) => `${border("│")} ${truncateToWidth(line, contentWidth, "…", true)} ${border("│")}`),
          border(`╰${"─".repeat(width - 2)}╯`),
        ];
      },
    };
    // A raw handle removes this exact dialog, even if another overlay opens above it.
    const options: OverlayOptions = {
      anchor: "top-right",
      width: panelWidth(tui.terminal.columns) - 4,
      margin: { top: 3, bottom: 1, left: 4, right: 4 },
      visible: (columns) => {
        options.width = panelWidth(columns) - 4;
        return true;
      },
    };
    handle = tui.showOverlay(dialog, options);
    this.settingsInput = { close };
  }

  close(removeHost = true): void {
    if (this.isClosed) return;
    this.isClosed = true;
    ++this.generation;
    this.clearRefreshTimer();
    this.settingsInput?.close();
    this.pending?.abort();
    this.pending = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.handle?.hide();
    this.handle = undefined;
    try {
      if (removeHost) this.ctx.ui.setWidget(OVERLAY_HOST_KEY, undefined);
    } finally {
      this.resolveClosed();
    }
  }

  invalidate(): void {
    this.viewport.invalidate();
  }

  render(width: number): string[] {
    if (this.isClosed || width < 1) return [];
    const theme = this.ctx.ui.theme;
    const rows = this.tui?.terminal.rows ?? 24;
    // Match the host's maxHeight/margin clamp so it never crops the pinned footer.
    const maxHeight = Math.max(1, Math.min(Math.floor(rows * 0.75), rows - 2));
    const bordered = width >= 4 && maxHeight >= 5;
    const innerWidth = bordered ? width - 2 : width;
    const maxInnerHeight = maxHeight - (bordered ? 2 : 0);
    const footer = this.footerLines(innerWidth, maxInnerHeight);
    const header = [
      theme.fg("accent", `Provider usage / ${this.scope}`),
      ...wrapTextWithAnsi(
        theme.fg(this.pending || this.failure ? "warning" : "muted", this.snapshotLabel(innerWidth)),
        innerWidth,
      ),
    ].slice(0, Math.max(0, maxInnerHeight - footer.length));
    const report = this.viewport.render(innerWidth);
    // Size to the report instead of always claiming the height cap; long reports still scroll.
    const innerHeight = Math.min(maxInnerHeight, header.length + report.length + footer.length);
    const bodyHeight = Math.max(0, innerHeight - header.length - footer.length);
    this.viewport.updateLayout(report.length, bodyHeight, () => this.requestRender());
    const body = report.slice(this.viewport.scrollTop, this.viewport.scrollTop + bodyHeight);
    while (body.length < bodyHeight) body.push("");
    const lines = [...header, ...body, ...footer.map((line) => theme.fg("dim", line))];
    const padded = lines.map((line) => truncateToWidth(line, innerWidth, "…", true));
    if (!bordered) return padded;
    const border = (text: string) => theme.fg("border", text);
    return [
      border(`╭${"─".repeat(innerWidth)}╮`),
      ...padded.map((line) => `${border("│")}${line}${border("│")}`),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
  }

  /** Keep full key names on two rows; compress only when width or body space requires it. */
  private footerLines(innerWidth: number, maxInnerHeight: number): string[] {
    const full = wrapTextWithAnsi(FOOTER_FULL, innerWidth);
    if (full.length === 2 && maxInnerHeight >= full.length + 3) return full;
    const compact = wrapTextWithAnsi(innerWidth >= 36 ? FOOTER_COMPACT : FOOTER_TINY, innerWidth);
    if (compact.length === 1) return compact;
    if (compact.length <= Math.max(1, maxInnerHeight - 2)) return compact;
    return [truncateToWidth("Ctrl+Alt: R/A/Q/↑↓", innerWidth)];
  }

  /** Drop the least important clauses first so a narrow panel keeps a two-line header. */
  private snapshotLabel(innerWidth: number): string {
    const snapshot = this.snapshot;
    const auto = `Auto: ${this.autoRefresh.enabled ? `${this.autoRefresh.minutes} min` : "off"}`;
    const stamp = snapshot ? `Snapshot ${snapshot.timestamp} · ${snapshot.states.length} providers` : "No snapshot";
    const detail = this.pending
      ? `${snapshot ? "Refreshing · prior" : "Querying"} · ${stamp}`
      : this.failure
        ? `Query failed · ${snapshot ? "prior · " : ""}${stamp}`
        : stamp;
    const compactStamp = snapshot ? `Snapshot ${snapshot.timestamp}` : "No snapshot";
    const compact = detail.replace(stamp, compactStamp);
    for (const candidate of [`${detail} · ${auto}`, `${compact} · ${auto}`]) {
      if (candidate.length <= innerWidth) return candidate;
    }
    return `${compact} · ${auto}`;
  }

  private renderReport(width: number): string[] {
    const snapshot = this.snapshot;
    const text = [
      this.failure ? `Query failed: ${this.failure}` : undefined,
      snapshot
        ? formatProviderStates(snapshot.states, {
            width,
            decorateSection: (line) => this.ctx.ui.theme.fg("accent", line),
          }) || "No providers in this scope."
        : this.pending
          ? "Querying provider usage…"
          : "No snapshot available.",
    ]
      .filter((line) => line !== undefined)
      .join("\n\n");
    return wrapTextWithAnsi(text, width).map((line) => this.ctx.ui.theme.fg("text", truncateToWidth(line, width)));
  }

  private requestRender(): void {
    if (!this.isClosed) this.tui?.requestRender();
  }
}
