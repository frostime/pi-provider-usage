import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import usageExtension from "../src/usage.js";
import { createMockContext, createMockPi, emit } from "./support.js";

const models = [
  {
    id: "codex-model",
    name: "Codex",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com",
    api: "openai-codex-responses",
  },
  {
    id: "go-model",
    name: "Go",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    api: "openai-completions",
  },
  {
    id: "fw-model",
    name: "Fireworks",
    provider: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    api: "openai-completions",
  },
];
const codexPayload = {
  rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 2000000000 } },
};
const goPayload = { usage: { rolling: { status: "ok", percent: 40, resetsAt: "2030-01-01T00:00:00Z" } } };

function setup(configured = ["openai-codex", "opencode-go"], provider = "openai-codex") {
  const available = new Set(configured);
  let key = "synthetic-key";
  const registry = {
    getAvailable: () => models.filter((model) => available.has(model.provider)),
    getAll: () => models,
    getProviderAuthStatus: (id: string) => ({ configured: available.has(id), source: "API key" }),
    getProviderAuth: async (id: string) =>
      available.has(id) ? { auth: { apiKey: key }, source: "API key" } : undefined,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key }),
  };
  const context = createMockContext({
    mode: "rpc",
    model: models.find((model) => model.provider === provider),
    modelRegistry: registry,
  });
  const mock = createMockPi();
  // Never consult real credentials during tests.
  usageExtension(mock.pi, { credentialReader: () => undefined });
  const command = mock.commands.get("provider-usage")!;
  return {
    ...context,
    ...mock,
    command,
    available,
    registry,
    rotateKey: () => {
      key = "synthetic-rotated-key";
    },
  };
}

function stubUsageFetch() {
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    return Response.json(url.includes("opencode.ai") ? goPayload : codexPayload);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function output(context: ReturnType<typeof createMockContext>): string {
  return context.notifications.map((item) => item.message).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("registers only the query command, with no startup queries, statusline, or request rewriting", async () => {
  const s = setup();
  const fetch = stubUsageFetch();
  assert.deepEqual([...s.commands.keys()], ["provider-usage"]);
  for (const event of ["session_start", "model_select", "turn_start"]) await emit(s, event, s.ctx);
  assert.equal(fetch.mock.calls.length, 0);
  assert.deepEqual([...s.statuses], []);
  assert.ok(!s.events.has("before_provider_request"));
  assert.deepEqual(s.entries, []);
});

test("completion exposes configured providers and all, and follows runtime configuration changes", async () => {
  const s = setup();
  await emit(s, "session_start", s.ctx);
  const complete = (prefix: string) => s.command.getArgumentCompletions!(prefix)?.map((item: any) => item.value);
  assert.deepEqual(complete(""), ["codex", "opencode-go", "all"]);
  assert.deepEqual(complete("CODE"), ["codex"]);
  s.available.delete("opencode-go");
  assert.deepEqual(complete(""), ["codex", "all"]);
  assert.equal(complete("unknown"), undefined);
  await emit(s, "session_shutdown", s.ctx);
  assert.equal(complete(""), undefined);
});

test("no argument queries only current provider without creating session entries or model messages", async () => {
  const s = setup();
  const fetch = stubUsageFetch();
  await s.command.handler("", s.ctx);
  assert.equal(fetch.mock.calls.length, 1);
  assert.match(output(s), /OpenAI Codex Usage · Current/);
  assert.match(output(s), /70%/);
  assert.doesNotMatch(output(s), /OpenCode|synthetic-/);
  assert.deepEqual(s.entries, []);
  assert.deepEqual(s.sentMessages, []);
  assert.deepEqual(s.sentUserMessages, []);
  assert.equal(s.entryRenderers.size, 0);
});

test("explicit cross-provider query does not change model, and codex alias and canonical ID both work", async () => {
  const s = setup();
  const fetch = stubUsageFetch();
  await s.command.handler("opencode-go", s.ctx);
  assert.match(output(s), /OpenCode Go Usage · Configured/);
  assert.equal(s.ctx.model?.provider, "openai-codex");
  await s.command.handler("codex", s.ctx);
  await s.command.handler("openai-codex", s.ctx);
  assert.equal(fetch.mock.calls.length, 3);
  assert.match(output(s), /60%/);
});

test("all retains successful reports when another provider fails, without exposing credentials", async () => {
  const s = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("opencode.ai")
        ? new Response("error synthetic-key", { status: 503, statusText: "Unavailable" })
        : Response.json(codexPayload),
    ),
  );
  await s.command.handler("all", s.ctx);
  assert.match(output(s), /OpenAI Codex Usage/);
  assert.match(output(s), /OpenCode Go · Configured\nQuery failed:/);
  assert.match(output(s), /503/);
  assert.doesNotMatch(output(s), /synthetic-key/);
});

test("invalid arguments and unsupported current providers perform no network request", async () => {
  const s = setup();
  const fetch = stubUsageFetch();
  await s.command.handler("codex all", s.ctx);
  await s.command.handler("nonexistent", s.ctx);
  await s.command.handler("constructor", s.ctx);
  const unsupported = createMockContext({ model: { ...models[0], provider: "unsupported-provider" } });
  await s.command.handler("", unsupported.ctx);
  assert.equal(fetch.mock.calls.length, 0);
  assert.equal(s.entries.length, 0);
  assert.match(s.notifications[0]!.message, /Usage: \/provider-usage/);
  assert.match(unsupported.notifications[0]!.message, /not supported/);
});

test("empty provider configuration and print/JSON modes do not query or publish results", async () => {
  const s = setup([]);
  const fetch = stubUsageFetch();
  const empty = createMockContext({ modelRegistry: s.registry });
  await s.command.handler("all", empty.ctx);
  assert.match(empty.notifications[0]!.message, /No supported provider/);
  for (const mode of ["print", "json"]) {
    const context = createMockContext({ mode, model: s.ctx.model, modelRegistry: s.registry });
    await s.command.handler("codex", context.ctx);
    assert.match(context.notifications[0]!.message, /requires TUI or RPC/);
  }
  assert.equal(fetch.mock.calls.length, 0);
  assert.deepEqual(s.entries, []);
});

test("repeated manual queries fetch fresh data rather than serving an account cache", async () => {
  const s = setup();
  const fetch = stubUsageFetch();
  await s.command.handler("codex", s.ctx);
  s.rotateKey();
  await s.command.handler("codex", s.ctx);
  assert.equal(fetch.mock.calls.length, 2);
  assert.equal(
    (fetch.mock.calls[1]![1].headers as Record<string, string>).Authorization,
    "Bearer synthetic-rotated-key",
  );
});

test("multiple billing accounts require selection without querying or aggregating them", async () => {
  const s = setup(["fireworks"], "fireworks");
  const fetch = vi.fn(async () => Response.json({ accounts: [{ name: "accounts/a" }, { name: "accounts/b" }] }));
  vi.stubGlobal("fetch", fetch);
  await s.command.handler("", s.ctx);
  assert.equal(fetch.mock.calls.length, 1);
  assert.match(output(s), /Selection required/);
  assert.match(output(s), /not supported/);
  assert.doesNotMatch(output(s), /rated spend:/);
});

test("one billing account is selected automatically", async () => {
  const s = setup(["fireworks"], "fireworks");
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json(url.includes("billing") ? { lineItems: [] } : { accounts: [{ name: "accounts/only" }] });
    }),
  );
  await s.command.handler("fireworks", s.ctx);
  assert.equal(urls.length, 2);
  assert.match(urls[1]!, /accounts\/only/);
  assert.match(output(s), /Fireworks API Spend/);
});

test("an authentication rotation before sending the usage request fails safely", async () => {
  const s = setup();
  const fetch = stubUsageFetch();
  let reads = 0;
  s.registry.getProviderAuth = async () => ({
    auth: { apiKey: ++reads === 1 ? "original" : "changed" },
    source: "API key",
  });
  // Cross-provider auth comes from the registry rather than selected-model auth.
  await s.command.handler("opencode-go", s.ctx);
  assert.equal(fetch.mock.calls.length, 0);
  assert.match(output(s), /authentication changed/);
});

test("shutdown and model changes cancel in-flight requests and suppress late reports", async () => {
  for (const event of ["session_shutdown", "model_select"]) {
    const s = setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        requestSignal = options.signal!;
        started();
        return new Promise<Response>((_resolve, reject) =>
          requestSignal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
            once: true,
          }),
        );
      }),
    );
    const command = s.command.handler("", s.ctx);
    await ready;
    await emit(s, event, s.ctx);
    await command;
    assert.equal(requestSignal?.aborted, true);
    assert.deepEqual(s.entries, []);
  }
});

test("a stalled auth resolver times out while all still reports other providers", async () => {
  vi.useFakeTimers();
  const s = setup();
  stubUsageFetch();
  const original = s.registry.getProviderAuth;
  s.registry.getProviderAuth = async (id: string) => (id === "opencode-go" ? new Promise(() => {}) : original(id));
  const pending = s.command.handler("all", s.ctx);
  await vi.advanceTimersByTimeAsync(15001);
  await pending;
  assert.match(output(s), /OpenAI Codex Usage/);
  assert.match(output(s), /OpenCode Go · Configured\nQuery failed: Timed out/);
});

test("RPC returns the report through notification without opening terminal UI", async () => {
  const s = setup();
  stubUsageFetch();
  const rpc = createMockContext({ mode: "rpc", model: s.ctx.model, modelRegistry: s.registry });
  await s.command.handler("", rpc.ctx);
  assert.match(rpc.notifications[0]!.message, /OpenAI Codex Usage/);
  assert.deepEqual(s.entries, []);
});
