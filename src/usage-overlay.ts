import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { errorMessage, redactUsageError } from "./core.js";
import { formatProviderStates } from "./format.js";
import type { ProviderUsageState } from "./types.js";

const OVERLAY_HOST_KEY = "frostime.provider-usage.overlay";

/** Panel width clamp: 40% of the terminal, but never wider than a readable data panel. */
const PANEL_WIDTH_SHARE = 0.4;
const PANEL_MIN_WIDTH = 44;
const PANEL_MAX_WIDTH = 72;
const FOOTER_FULL = "Ctrl+Alt+R refresh · Ctrl+Alt+Q close · Ctrl+Alt+↑/↓ scroll";
const FOOTER_COMPACT = "Ctrl+Alt: R refresh · Q close · ↑/↓ scroll";
const FOOTER_TINY = "Ctrl+Alt:\nR refresh\nQ close\n↑/↓ scroll";

function panelWidth(terminalColumns: number): number {
  const share = Math.floor(terminalColumns * PANEL_WIDTH_SHARE);
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, share));
}

/** Queries one usage scope; called on open, on retarget, and on manual refresh. */
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
): UsageOverlayView {
  const panel = new UsageOverlay(ctx, scope, query);
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
  private readonly viewport: ScrollView;

  constructor(
    private readonly ctx: ExtensionContext,
    private scope: string,
    private query: UsageQuery,
  ) {
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

  async refresh(): Promise<void> {
    if (this.isClosed) return;
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
      this.viewport.scrollToStart();
    } catch (error) {
      if (this.isClosed || generation !== this.generation) return;
      this.failure = redactUsageError(errorMessage(error));
    } finally {
      if (!this.isClosed && generation === this.generation) {
        this.pending = undefined;
        this.requestRender();
      }
    }
  }

  close(removeHost = true): void {
    if (this.isClosed) return;
    this.isClosed = true;
    ++this.generation;
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

  /** Prefer a single control line; degrade only when the terminal is too narrow or too short. */
  private footerLines(innerWidth: number, maxInnerHeight: number): string[] {
    const full = wrapTextWithAnsi(FOOTER_FULL, innerWidth);
    if (full.length === 1) return full;
    const compact = wrapTextWithAnsi(innerWidth >= 36 ? FOOTER_COMPACT : FOOTER_TINY, innerWidth);
    if (compact.length === 1) return compact;
    if (compact.length <= Math.max(1, maxInnerHeight - 2)) return compact;
    return [truncateToWidth("Ctrl+Alt: R/Q/↑↓", innerWidth)];
  }

  /** Drop the least important clauses first so a narrow panel keeps a two-line header. */
  private snapshotLabel(innerWidth: number): string {
    const snapshot = this.snapshot;
    const stamp = snapshot ? `Snapshot ${snapshot.timestamp} · ${snapshot.states.length} providers` : "No snapshot";
    const detail = this.pending
      ? `${snapshot ? "Refreshing · prior" : "Querying"} · ${stamp}`
      : this.failure
        ? `Query failed · ${snapshot ? "prior · " : ""}${stamp}`
        : `${stamp} · no auto-refresh`;
    const withoutAutoRefresh = detail.replace(" · no auto-refresh", "");
    const compactStamp = snapshot ? `Snapshot ${snapshot.timestamp}` : "No snapshot";
    const compact = withoutAutoRefresh.replace(stamp, compactStamp);
    for (const candidate of [detail, withoutAutoRefresh, compact]) {
      if (candidate.length <= innerWidth) return candidate;
    }
    return compact;
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
