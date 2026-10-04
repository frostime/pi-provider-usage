import assert from "node:assert/strict";
import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { openUsageOverlay } from "../src/usage-overlay.js";
import type { ProviderUsageState } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const controls = {
  refresh: "\x1b[114;7u",
  close: "\x1b[113;7u",
  up: "\x1b[1;7A",
  down: "\x1b[1;7B",
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Only the custom UI/input boundary is faked; rendering and key parsing are real pi-tui. */
function fakeUI() {
  type Panel = Component & { dispose?(): void };
  const widgets = new Map<string, Panel>();
  const terminal = { rows: 32, columns: 120 };
  const listeners = new Set<Parameters<ExtensionUIContext["onTerminalInput"]>[0]>();
  let component: Panel | undefined;
  let options: Parameters<TUI["showOverlay"]>[1];
  let attached = false;
  let hidden = false;
  let rendered = false;
  let disposals = 0;
  let renders = 0;
  let editor = "draft 中文";
  const editorInputs: string[] = [];
  const editorFocus = {};
  const focus = editorFocus;
  let color = "36";
  const theme = { fg: (_token: string, text: string) => `\x1b[${color}m${text}\x1b[0m` } as Theme;
  const forbidden = () => {
    throw new Error("Overlay touched main UI/focus or the custom-dialog stack");
  };
  const handle: OverlayHandle = {
    isHidden: () => hidden,
    getBounds: () => (rendered && attached && !hidden ? { row: 1, col: 2, width: 40, height: 20 } : undefined),
    isFocused: () => false,
    hide: () => {
      attached = false;
    },
    setHidden: forbidden,
    focus: forbidden,
    unfocus: forbidden,
  };
  const tui = {
    terminal,
    requestRender: () => {
      renders++;
    },
    setFocus: forbidden,
    hideOverlay: forbidden,
    showOverlay(panel: Panel, suppliedOptions: Parameters<TUI["showOverlay"]>[1]) {
      component = panel;
      options = suppliedOptions;
      attached = true;
      return handle;
    },
  } as unknown as TUI;
  const ui = new Proxy(
    {
      setWidget(key: string, content: unknown, suppliedOptions?: { placement?: string }) {
        const previous = widgets.get(key);
        if (previous) {
          disposals++;
          previous.dispose?.();
        }
        widgets.delete(key);
        if (content === undefined) return;
        assert.equal(suppliedOptions?.placement, "belowEditor");
        const anchor = (content as (tui: TUI, theme: Theme) => Panel)(tui, theme);
        assert.deepEqual(anchor.render(120), []);
        widgets.set(key, anchor);
      },
      theme,
      onTerminalInput: (listener: Parameters<ExtensionUIContext["onTerminalInput"]>[0]) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    {
      get(target, key) {
        return key in target ? Reflect.get(target, key) : forbidden;
      },
    },
  );
  const ctx = { ui, mode: "tui", hasUI: true } as unknown as ExtensionContext;
  return {
    ctx,
    terminal,
    editorInputs,
    widgets,
    setHidden: (value: boolean) => {
      hidden = value;
    },
    changeTheme: () => {
      color = "35";
    },
    get options() {
      return options;
    },
    get component() {
      return component!;
    },
    get attached() {
      return attached;
    },
    get disposals() {
      return disposals;
    },
    get listeners() {
      return listeners.size;
    },
    get renders() {
      return renders;
    },
    get editor() {
      return editor;
    },
    get focus() {
      return focus;
    },
    editorFocus,
    render(width = 48) {
      rendered = true;
      return component!.render(width);
    },
    input(data: string) {
      for (const listener of listeners) {
        if (listener(data)?.consume) return true;
      }
      editorInputs.push(data);
      if (data.length === 1 && data >= " ") editor += data;
      return false;
    },
  };
}

function state(message: string): ProviderUsageState {
  return {
    providerId: "example",
    providerName: "Example",
    displayState: "configured",
    status: "query-failed",
    message,
  };
}

function pendingQueries() {
  const requests: Array<ReturnType<typeof deferred<readonly ProviderUsageState[]>> & { signal: AbortSignal }> = [];
  return {
    requests,
    query(signal: AbortSignal) {
      const request = { ...deferred<readonly ProviderUsageState[]>(), signal };
      requests.push(request);
      return request.promise;
    },
  };
}

test("opens synchronously without taking focus, and intercepts only visible panel controls", async () => {
  const ui = fakeUI();
  const work = pendingQueries();
  const overlay = openUsageOverlay(ui.ctx, "all", work.query);
  assert.equal(typeof overlay.close, "function");
  assert.equal(work.requests.length, 1);
  assert.equal(ui.attached, true);
  assert.equal(ui.input(controls.refresh), false);
  await flush();
  assert.deepEqual(ui.options, {
    nonCapturing: true,
    anchor: "top-right",
    width: "40%",
    minWidth: 40,
    maxHeight: "75%",
    margin: { top: 1, bottom: 1, left: 2, right: 2 },
  });
  assert.equal(ui.listeners, 1);
  assert.equal(ui.editor, "draft 中文");
  assert.equal(ui.focus, ui.editorFocus);
  assert.equal(ui.component.handleInput, undefined);
  assert.equal("focused" in ui.component, false);
  assert.match(plain(ui.render().join("\n")), /Provider usage \/ all/);
  for (const key of ["q", "\x1b", "\r", "\x1b[A", "\x1b[B", "\x12"]) assert.equal(ui.input(key), false);
  assert.equal(ui.editor, "draft 中文q");
  ui.setHidden(true);
  assert.equal(ui.input(controls.close), false);
  assert.equal(ui.input(controls.refresh), false);
  ui.setHidden(false);
  for (const key of [controls.up, controls.down, controls.refresh]) assert.equal(ui.input(key), true);
  assert.equal(work.requests.length, 2);
  assert.equal(work.requests[0].signal.aborted, true);
  assert.equal(ui.input(controls.close), true);
  await overlay.closed;
  assert.equal(work.requests[1].signal.aborted, true);
  assert.equal(ui.listeners, 0);
  assert.equal(ui.attached, false);
  assert.equal(ui.focus, ui.editorFocus);
  for (const key of Object.values(controls)) assert.equal(ui.input(key), false);
  assert.equal(work.requests.length, 2);
});

test("refresh retains the prior timestamped snapshot, aborts superseded queries, and ignores late outcomes", async () => {
  const ui = fakeUI();
  const work = pendingQueries();
  const overlay = openUsageOverlay(ui.ctx, "example", work.query);
  await flush();
  work.requests[0].resolve([state("first snapshot")]);
  await flush();
  const snapshot = plain(ui.render(80).join("\n"));
  assert.match(snapshot, /Snapshot \S+/);
  assert.match(snapshot, /no auto-refresh/);
  ui.input(controls.refresh);
  assert.match(plain(ui.render(80).join("\n")), /Refreshing · prior.*Snapshot/);
  assert.match(plain(ui.render(80).join("\n")), /first snapshot/);
  ui.input(controls.refresh);
  assert.equal(work.requests[1].signal.aborted, true);
  const beforeStale = ui.renders;
  work.requests[1].resolve([state("stale success")]);
  await flush();
  assert.equal(ui.renders, beforeStale);
  assert.doesNotMatch(plain(ui.render(80).join("\n")), /stale success/);
  work.requests[2].resolve([state("new snapshot")]);
  await flush();
  assert.match(plain(ui.render(80).join("\n")), /new snapshot/);
  assert.doesNotMatch(plain(ui.render(80).join("\n")), /Refreshing|first snapshot/);
  ui.input(controls.refresh);
  ui.input(controls.refresh);
  work.requests[3].reject(new Error("stale rejection"));
  await flush();
  assert.doesNotMatch(plain(ui.render(80).join("\n")), /stale rejection/);
  overlay.close();
  await overlay.closed;
  const afterClose = ui.renders;
  assert.equal(work.requests[4].signal.aborted, true);
  work.requests[4].resolve([state("after close")]);
  await flush();
  assert.equal(ui.renders, afterClose);
  assert.deepEqual(ui.render(), []);
});

test("close before the first render removes the host and ignores a late query failure", async () => {
  const ui = fakeUI();
  const work = pendingQueries();
  const overlay = openUsageOverlay(ui.ctx, "all", work.query);
  overlay.close();
  overlay.close();
  await overlay.closed;
  assert.equal(work.requests[0].signal.aborted, true);
  assert.equal(ui.disposals, 1);
  assert.equal(ui.attached, false);
  assert.equal(ui.widgets.size, 0);
  assert.equal(ui.listeners, 0);
  const rendersAfterClose = ui.renders;
  work.requests[0].reject(new Error("late cancelled failure"));
  await flush();
  assert.equal(ui.renders, rendersAfterClose);
  assert.equal(work.requests.length, 1);
});

test("an input-listener setup failure removes the created overlay without starting a query", () => {
  let removals = 0;
  let queries = 0;
  const handle = {
    hide: () => {
      removals++;
    },
  };
  const tui = { showOverlay: () => handle } as unknown as TUI;
  const ctx = {
    ui: {
      setWidget: (_key: string, factory: (tui: TUI) => Component) => factory(tui),
      onTerminalInput: () => {
        throw new Error("input setup failed");
      },
    },
  } as unknown as ExtensionContext;
  assert.throws(
    () =>
      openUsageOverlay(ctx, "all", async () => {
        queries++;
        return [];
      }),
    /input setup failed/,
  );
  assert.equal(removals, 1);
  assert.equal(queries, 0);
});

test("query failures are visible and retryable without discarding a successful snapshot", async () => {
  const ui = fakeUI();
  let attempt = 0;
  const overlay = openUsageOverlay(ui.ctx, "all", () => {
    attempt++;
    if (attempt === 1) throw new Error("initial failure");
    if (attempt === 3) return Promise.reject(new Error("refresh failure"));
    return Promise.resolve([state("retained data")]);
  });
  await flush();
  assert.match(plain(ui.render(80).join("\n")), /Query failed: initial failure/);
  ui.input(controls.refresh);
  await flush();
  assert.match(plain(ui.render(80).join("\n")), /retained data/);
  ui.input(controls.refresh);
  await flush();
  const failedRefresh = plain(ui.render(80).join("\n"));
  assert.match(failedRefresh, /Query failed · prior · Snapshot/);
  assert.match(failedRefresh, /Query failed: refresh failure/);
  assert.match(failedRefresh, /retained data/);
  const anchorKey = ui.widgets.keys().next().value!;
  ui.ctx.ui.setWidget(anchorKey, undefined);
  await overlay.closed;
  assert.equal(ui.listeners, 0);
  assert.equal(ui.disposals, 1);
});

test("keeps detailed provider currencies and selection semantics in the panel", async () => {
  const ui = fakeUI();
  ui.terminal.rows = 80;
  const states: ProviderUsageState[] = [
    {
      status: "ready",
      providerId: "deepseek",
      providerName: "DeepSeek",
      displayState: "current",
      report: {
        providerId: "deepseek",
        providerName: "DeepSeek",
        capturedAt: 123,
        source: "balance",
        semantics: { kind: "api-key", label: "API account balance" },
        buckets: [],
        metrics: [
          { id: "api-availability", label: "Availability", value: "available" },
          { id: "cny", label: "Total", value: 3.12, currency: "CNY" },
          { id: "usd", label: "Total", value: 2.34, currency: "USD" },
        ],
      },
    },
    {
      status: "selection-required",
      providerId: "xai",
      providerName: "xAI",
      displayState: "configured",
      singularLabel: "team",
      pluralLabel: "teams",
      choices: [],
    },
    state("503 Service Unavailable"),
  ];
  const overlay = openUsageOverlay(ui.ctx, "all", async () => states);
  await flush();
  const output = plain(ui.render(160).join("\n"));
  for (const text of [
    "DeepSeek API Balance · Current",
    "Semantics: API account balance",
    "CNY balance:",
    "CNY 3.12",
    "USD balance:",
    "USD 2.34",
    "Selection required: multiple teams",
    "503 Service Unavailable",
  ]) {
    assert.ok(output.includes(text), text);
  }
  overlay.close();
  await overlay.closed;
});

test("wraps ANSI/CJK by columns, pins the footer, scrolls to both ends, and reclamps on resize", async () => {
  const ui = fakeUI();
  const message = Array.from({ length: 40 }, (_, i) => `row-${i} \x1b[31m中文漢字\x1b[0m ${"长".repeat(24)}`).join(
    "\n",
  );
  const overlay = openUsageOverlay(ui.ctx, "中文 scope", async () => [state(message)]);
  await flush();
  for (const rows of [32, 12, 6, 3]) {
    ui.terminal.rows = rows;
    for (const width of [80, 40, 18, 4, 1]) {
      const lines = ui.render(width);
      assert.ok(lines.length <= Math.max(1, Math.min(Math.floor(rows * 0.75), rows - 2)));
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
      // At usable widths even a very short terminal keeps a control footer rather than cropping it.
      if (width >= 40) assert.match(plain(lines.join("\n")), /Ctrl\+Alt/);
    }
  }
  ui.terminal.rows = 12;
  const compact = plain(ui.render(18).join("\n"));
  for (const control of ["Ctrl+Alt", "R refresh", "Q close", "↑/↓ scroll"]) assert.ok(compact.includes(control));
  ui.terminal.rows = 32;
  const top = plain(ui.render(40).join("\n"));
  assert.match(top, /row-0/);
  assert.doesNotMatch(top, /row-39/);
  for (let i = 0; i < 400; i++) ui.input(controls.down);
  const bottom = plain(ui.render(40).join("\n"));
  assert.match(bottom, /row-39/);
  assert.doesNotMatch(bottom, /row-0 /);
  assert.match(bottom, /Ctrl\+Alt\+Q close/);
  ui.input(controls.down);
  assert.equal(plain(ui.render(40).join("\n")), bottom);
  ui.terminal.rows = 64;
  assert.match(plain(ui.render(80).join("\n")), /row-39/);
  for (let i = 0; i < 400; i++) ui.input(controls.up);
  assert.match(plain(ui.render(80).join("\n")), /row-0/);
  ui.changeTheme();
  ui.component.invalidate();
  const themed = ui.render(80).join("\n");
  assert.ok(themed.includes("\x1b[35m"));
  assert.equal(ui.focus, ui.editorFocus);
  assert.equal(ui.editor, "draft 中文");
  overlay.close();
  await overlay.closed;
});
