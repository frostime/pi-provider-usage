import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
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

function setup() {
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
  usageExtension(mock.pi, { credentialReader: () => undefined });
  return {
    ...context,
    ...mock,
    command: mock.commands.get("provider-usage")!,
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

test("new commands and model/session changes close the old view and remove scoped controls", async () => {
  for (const event of ["model_select", "session_start", "session_shutdown"]) {
    const s = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => report(30)),
    );
    await s.command.handler("codex", s.ctx);
    await vi.waitFor(() => assert.match(output(s), /70%/));
    await s.command.handler("codex", s.ctx);
    await vi.waitFor(() => assert.match(output(s), /70%/));
    assert.equal(s.overlays.length, 2);
    assert.equal(s.overlays[0]!.closed, true);
    assert.equal(s.overlays[1]!.closed, false);
    assert.equal(s.terminalInputHandlers.size, 1);
    await emit(s, event, s.ctx);
    await vi.waitFor(() => assert.equal(s.overlays[1]!.closed, true));
    assert.equal(s.terminalInputHandlers.size, 0);
    assert.equal(s.widgets.size, 0);
    assert.deepEqual(s.entries, []);
  }
});
