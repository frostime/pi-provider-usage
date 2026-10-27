import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import usageExtension from "../src/usage.js";
import { createMockContext, createMockPi, emit } from "./support.js";

const REFRESH = "\x1b[114;7u";
const CLOSE = "\x1b[113;7u";
const model = {
  id: "synthetic-codex-model",
  name: "Codex",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com",
  api: "openai-codex-responses",
};

function setup(settings: Record<string, unknown> = {}) {
  let key = "synthetic-original-key";
  const context = createMockContext({
    model,
    isIdle: () => false,
    waitForIdle: async () => {
      throw new Error("Usage must not wait for the streaming turn.");
    },
    abort: () => {
      throw new Error("Usage must not abort the streaming turn.");
    },
    modelRegistry: {
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthStatus: () => ({ configured: false }),
      getProviderAuth: async () => ({ auth: { apiKey: key } }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key }),
    },
  });
  const mock = createMockPi();
  mock.rawPi.getSettings = () => settings;
  usageExtension(mock.pi, { credentialReader: () => undefined });
  return {
    ...context,
    ...mock,
    command: mock.commands.get("provider-usage:overlay")!,
    rotateKey() {
      key = "synthetic-next-key";
    },
  };
}

function report(used: number) {
  return Response.json({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } } });
}

function output(context: ReturnType<typeof createMockContext>) {
  return stripTerminalSequences(context.overlays.at(-1)?.component?.render(100).join("\n") ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("opening usage returns while the request is pending and the main turn is streaming", async () => {
  const s = setup();
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      requestSignal = options.signal!;
      return new Promise<Response>((_resolve, reject) =>
        requestSignal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
          once: true,
        }),
      );
    }),
  );
  await s.command.handler("", s.ctx);
  await vi.waitFor(() => assert.ok(requestSignal));
  assert.equal(s.overlays.length, 1);
  assert.equal(s.overlays[0]!.options.nonCapturing, true);
  assert.deepEqual(
    [...s.widgets.values()].flatMap((widget) => widget.render(160)),
    [],
  );
  assert.equal(s.overlays[0]!.closed, false);
  assert.deepEqual(s.entries, []);
  assert.deepEqual(s.sentMessages, []);
  assert.deepEqual(s.sentUserMessages, []);
  assert.equal(s.entryRenderers.size, 0);
  assert.equal(s.input("q"), false);
  assert.equal(s.input("\x1b"), false);
  assert.equal(s.input("\r"), false);
  assert.equal(s.input(CLOSE), true);
  assert.equal(requestSignal?.aborted, true);
  await vi.waitFor(() => assert.equal(s.overlays[0]!.closed, true));
  assert.equal(s.terminalInputHandlers.size, 0);
  assert.equal(s.widgets.size, 0);
  assert.equal(s.input(CLOSE), false);
});

test("manual refresh uses fresh auth, replaces the snapshot, and does not run automatically", async () => {
  vi.useFakeTimers();
  const s = setup();
  const headers: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      headers.push(options.headers as Record<string, string>);
      return report(headers.length === 1 ? 30 : 50);
    }),
  );
  await s.command.handler("codex", s.ctx);
  await vi.advanceTimersByTimeAsync(1);
  assert.match(output(s), /70%/);
  assert.match(output(s), /snapshot/i);
  await vi.advanceTimersByTimeAsync(600_000);
  assert.equal(headers.length, 1);
  s.rotateKey();
  assert.equal(s.input(REFRESH), true);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(headers.length, 2);
  assert.equal(headers[1]!.Authorization, "Bearer synthetic-next-key");
  assert.match(output(s), /50%/);
  assert.doesNotMatch(output(s), /70%/);
  assert.deepEqual(s.entries, []);
  s.input(CLOSE);
  assert.equal(s.terminalInputHandlers.size, 0);
  assert.equal(s.widgets.size, 0);
  assert.equal(s.input(REFRESH), false);
});

test("refreshing all rechecks configured providers instead of keeping the original list", async () => {
  const s = setup();
  const go = { ...model, id: "go", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" };
  const registry = s.ctx.modelRegistry as any;
  let goConfigured = false;
  registry.getAll = () => [model, go];
  registry.getAvailable = () => (goConfigured ? [model, go] : [model]);
  registry.getProviderAuthStatus = (id: string) => ({ configured: id === "opencode-go" && goConfigured });
  const fetch = vi.fn(async (url: string) =>
    url.includes("opencode.ai") ? Response.json({ usage: { rolling: { status: "ok", percent: 15 } } }) : report(30),
  );
  vi.stubGlobal("fetch", fetch);
  await s.command.handler("all", s.ctx);
  await vi.waitFor(() => assert.match(output(s), /OpenAI Codex/));
  assert.equal(fetch.mock.calls.length, 1);
  goConfigured = true;
  s.input(REFRESH);
  await vi.waitFor(() => assert.match(output(s), /OpenCode Go/));
  assert.equal(fetch.mock.calls.length, 3);
  s.input(CLOSE);
});

test("session and model changes close the view and remove scoped controls", async () => {
  for (const event of ["model_select", "session_start", "session_shutdown"]) {
    const s = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => report(30)),
    );
    await s.command.handler("codex", s.ctx);
    await vi.waitFor(() => assert.match(output(s), /70%/));
    assert.equal(s.overlays.length, 1);
    assert.equal(s.terminalInputHandlers.size, 1);
    await emit(s, event, s.ctx);
    await vi.waitFor(() => assert.equal(s.overlays[0]!.closed, true));
    assert.equal(s.terminalInputHandlers.size, 0);
    assert.equal(s.widgets.size, 0);
    assert.deepEqual(s.entries, []);
  }
});

test("rerunning the command refreshes the open panel instead of stacking windows", async () => {
  const s = setup();
  const fetch = vi.fn(async () => report(30));
  vi.stubGlobal("fetch", fetch);
  await s.command.handler("codex", s.ctx);
  await vi.waitFor(() => assert.match(output(s), /70%/));
  await s.command.handler("codex", s.ctx);
  await vi.waitFor(() => assert.equal(fetch.mock.calls.length, 2));
  assert.equal(s.overlays.length, 1);
  assert.equal(s.overlays[0]!.closed, false);
  assert.equal(s.terminalInputHandlers.size, 1);
  s.input(CLOSE);
});

test("another scope retargets the same panel and close dismisses it without a query", async () => {
  const s = setup();
  const fetch = vi.fn(async () => report(30));
  vi.stubGlobal("fetch", fetch);
  await s.command.handler("codex", s.ctx);
  await vi.waitFor(() => assert.equal(fetch.mock.calls.length, 1));
  assert.match(output(s), /Provider usage \/ codex/);
  await s.command.handler("all", s.ctx);
  await vi.waitFor(() => assert.equal(fetch.mock.calls.length, 2));
  await vi.waitFor(() => assert.match(output(s), /Provider usage \/ all/));
  assert.equal(s.overlays.length, 1);
  assert.equal(s.overlays[0]!.closed, false);

  await s.command.handler("close", s.ctx);
  assert.equal(s.overlays[0]!.closed, true);
  assert.equal(s.widgets.size, 0);
  assert.equal(s.terminalInputHandlers.size, 0);

  s.notifications.length = 0;
  await s.command.handler("close", s.ctx);
  assert.equal(fetch.mock.calls.length, 2);
  assert.match(s.notifications[0]!.message, /No provider usage overlay is open/);
});

test("close is accepted as an argument, not as a provider", async () => {
  const s = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => report(30)),
  );
  await s.command.handler("close codex", s.ctx);
  assert.match(s.notifications[0]!.message, /Usage: \/provider-usage:overlay/);
});

const AUTO = "\x1b[97;7u";

function setAutoRefresh(s: ReturnType<typeof setup>, value: string) {
  assert.equal(s.input(AUTO), true);
  const dialog = s.overlays.at(-1)!.component!;
  dialog.handleInput(value);
  dialog.handleInput("\r");
  return s.overlays.at(-1)!;
}

function panelOutput(s: ReturnType<typeof setup>) {
  return stripTerminalSequences(s.overlays.find((overlay) => !overlay.closed)!.component.render(100).join("\n"));
}

test("overlay shortcut enables, changes and stops polling without writing session data", async () => {
  vi.useFakeTimers();
  const s = setup();
  const fetch = vi.fn(async () => report(30));
  vi.stubGlobal("fetch", fetch);
  await s.command.handler("codex", s.ctx);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(setAutoRefresh(s, "1").closed, true);
  assert.match(panelOutput(s), /Auto: 1 min/);
  await vi.advanceTimersByTimeAsync(59_999);
  assert.equal(fetch.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(fetch.mock.calls.length, 2);

  setAutoRefresh(s, "off");
  await vi.advanceTimersByTimeAsync(120_000);
  assert.equal(fetch.mock.calls.length, 2);
  assert.match(panelOutput(s), /Auto: off/);
  setAutoRefresh(s, "on");
  assert.match(panelOutput(s), /Auto: 1 min/);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(fetch.mock.calls.length, 3);

  // Closing stops all timers, while reopening retains the run-local preference.
  s.input(CLOSE);
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(120_000);
  assert.equal(fetch.mock.calls.length, 3);
  await s.command.handler("all", s.ctx);
  await vi.advanceTimersByTimeAsync(1);
  assert.match(panelOutput(s), /Auto: 1 min/);
  s.input(CLOSE);
  assert.deepEqual(s.entries, []);
  assert.deepEqual(s.sentMessages, []);
  assert.deepEqual(s.sentUserMessages, []);
});

test("invalid and cancelled input keep the previous preference and never stack settings dialogs", async () => {
  vi.useFakeTimers();
  const s = setup();
  vi.stubGlobal("fetch", vi.fn(async () => report(30)));
  await s.command.handler("codex", s.ctx);
  await vi.advanceTimersByTimeAsync(1);
  const dialogOverlay = setAutoRefresh(s, "true");
  assert.equal(dialogOverlay.closed, false);
  assert.match(stripTerminalSequences(dialogOverlay.component.render(54).join("\n")), /Use on, off/);
  assert.match(panelOutput(s), /Auto: off/);
  s.input(AUTO);
  assert.equal(s.overlays.length, 2);
  dialogOverlay.component.handleInput("\x1b");
  assert.equal(dialogOverlay.closed, true);
  assert.equal(vi.getTimerCount(), 0);

  s.input(AUTO);
  s.input(CLOSE);
  assert.ok(s.overlays.every((overlay) => overlay.closed));
  assert.equal(s.terminalInputHandlers.size, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("settings dialog stays near usage and paints a padded frame at wide and narrow widths", async () => {
  vi.useFakeTimers();
  const s = setup();
  vi.stubGlobal("fetch", vi.fn(async () => report(30)));
  await s.command.handler("codex", s.ctx);
  await vi.advanceTimersByTimeAsync(1);
  s.input(AUTO);
  const dialog = s.overlays.at(-1)!;
  assert.equal(dialog.options.anchor, "top-right");
  assert.deepEqual(dialog.options.margin, { top: 3, bottom: 1, left: 4, right: 4 });
  for (const columns of [400, 160, 100, 60]) {
    s.overlays[0]!.options.visible(columns);
    dialog.options.visible(columns);
    assert.equal(dialog.options.width, s.overlays[0]!.options.width - 4);
    const width = dialog.options.width;
    const lines = dialog.component.render(width);
    assert.match(stripTerminalSequences(lines[0]), /^╭─+╮$/);
    assert.match(stripTerminalSequences(lines.at(-1)), /^╰─+╯$/);
    for (const line of lines) assert.equal(visibleWidth(line), width);
    for (const line of lines.slice(1, -1)) {
      assert.match(stripTerminalSequences(line), /^│ .* │$/);
    }
    const text = stripTerminalSequences(lines.join("\n"));
    assert.match(text, /Current: off · Interval: 5 min/);
    assert.match(text, /on \/ off \/ minutes/);
    assert.match(text, /Enter apply · Esc cancel/);
  }
  s.input(CLOSE);
});

test("configured polling waits for completion, survives failure and clears on lifecycle changes", async () => {
  vi.useFakeTimers();
  const s = setup({ "npm:@frostime/pi-provider-usage": { autoRefreshOverlay: 1 } });
  let finish!: (response: Response) => void;
  const fetch = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockRejectedValueOnce(new Error("network unavailable"))
    .mockImplementation(async () => report(50));
  vi.stubGlobal("fetch", fetch);
  await s.command.handler("codex", s.ctx);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(fetch.mock.calls.length, 1);
  finish(report(30));
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(59_999);
  assert.equal(fetch.mock.calls.length, 2);
  assert.match(panelOutput(s), /network unavailable/);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(fetch.mock.calls.length, 3);
  assert.match(panelOutput(s), /50%/);
  await emit(s, "model_select", s.ctx);
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(120_000);
  assert.equal(fetch.mock.calls.length, 3);
});

test("on uses five minutes by default; invalid config stays off with one warning", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => report(30)));
  const s = setup({ "npm:@frostime/pi-provider-usage": { autoRefreshOverlay: "on" } });
  await s.command.handler("codex", s.ctx);
  await vi.advanceTimersByTimeAsync(1);
  assert.match(panelOutput(s), /Auto: 5 min/);
  s.input(CLOSE);

  const invalid = setup({ "npm:@frostime/pi-provider-usage": { autoRefreshOverlay: true } });
  await invalid.command.handler("codex", invalid.ctx);
  await vi.advanceTimersByTimeAsync(1);
  assert.match(panelOutput(invalid), /Auto: off/);
  assert.equal(invalid.notifications.length, 1);
  invalid.input(CLOSE);
  await invalid.command.handler("codex", invalid.ctx);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(invalid.notifications.length, 1);
  invalid.input(CLOSE);
});
