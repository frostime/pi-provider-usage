import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { errorMessage, redactUsageError } from "./core.js";
import { formatProviderStates } from "./format.js";
import type { ProviderUsageState } from "./types.js";

const OVERLAY_HOST_KEY = "frostime.provider-usage.overlay";

/** Opens a query-only, non-capturing snapshot panel without awaiting its query or dismissal. */
export function openUsageOverlay(
  ctx: ExtensionContext,
  scope: string,
  query: (signal: AbortSignal) => Promise<readonly ProviderUsageState[]>,
): { closed: Promise<void>; close(): void } {
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
  return { closed: panel.closed, close: () => panel.close() };
}

class UsageOverlay implements Component {
  private tui?: TUI;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private handle?: OverlayHandle;
  private unsubscribe?: () => void;
  private isClosed = false;
  private generation = 0;
  private pending?: AbortController;
  private snapshot?: { text: string; timestamp: string; count: number };
  private failure?: string;
  private readonly viewport: ScrollView;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly scope: string,
    private readonly query: (signal: AbortSignal) => Promise<readonly ProviderUsageState[]>,
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
    this.handle = tui.showOverlay(this, {
      nonCapturing: true,
      anchor: "top-right",
      width: "40%",
      minWidth: 40,
      maxHeight: "75%",
      margin: { top: 1, bottom: 1, left: 2, right: 2 },
    });
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
      this.snapshot = {
        text: formatProviderStates(states) || "No providers in this scope.",
        timestamp: new Date().toLocaleTimeString(),
        count: states.length,
      };
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
    const height = Math.max(1, Math.min(Math.floor(rows * 0.75), rows - 2));
    const bordered = width >= 4 && height >= 5;
    const innerWidth = bordered ? width - 2 : width;
    const innerHeight = height - (bordered ? 2 : 0);
    let footer = wrapTextWithAnsi("Ctrl+Alt+R refresh · Ctrl+Alt+Q close\nCtrl+Alt+↑/↓ scroll", innerWidth);
    if (footer.length > innerHeight - 3) {
      footer = wrapTextWithAnsi(
        innerWidth >= 36 ? "Ctrl+Alt: R refresh Q close ↑/↓ scroll" : "Ctrl+Alt:\nR refresh\nQ close\n↑/↓ scroll",
        innerWidth,
      );
      if (footer.length > Math.max(1, innerHeight - 2)) {
        footer = [truncateToWidth("Ctrl+Alt: R/Q/↑↓", innerWidth)];
      }
    }
    const header = [
      theme.fg("accent", `Provider usage / ${this.scope}`),
      ...wrapTextWithAnsi(
        theme.fg(this.pending || this.failure ? "warning" : "muted", this.snapshotLabel()),
        innerWidth,
      ),
    ].slice(0, Math.max(0, innerHeight - footer.length));
    const bodyHeight = Math.max(0, innerHeight - header.length - footer.length);
    const report = this.viewport.render(innerWidth);
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

  private snapshotLabel(): string {
    const snapshot = this.snapshot;
    const stamp = snapshot ? `Snapshot ${snapshot.timestamp} · ${snapshot.count} providers` : "No snapshot";
    if (this.pending) return `${snapshot ? "Refreshing · prior" : "Querying"} · ${stamp}`;
    if (this.failure) return `Query failed · ${snapshot ? "prior · " : ""}${stamp}`;
    return `${stamp} · no auto-refresh`;
  }

  private renderReport(width: number): string[] {
    const text = [
      this.failure ? `Query failed: ${this.failure}` : undefined,
      this.snapshot?.text ?? (this.pending ? "Querying provider usage…" : "No snapshot available."),
    ]
      .filter((line) => line !== undefined)
      .join("\n\n");
    return wrapTextWithAnsi(text, width).map((line) => this.ctx.ui.theme.fg("text", truncateToWidth(line, width)));
  }

  private requestRender(): void {
    if (!this.isClosed) this.tui?.requestRender();
  }
}
