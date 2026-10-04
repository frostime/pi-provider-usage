import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { OAUTH_CREDENTIAL_READINESS_CHANNEL, OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../src/oauth-credential-source.js";
import { OPENAI_CHATGPT_ADAPTER } from "../src/providers/openai-chatgpt.js";
import { resolveUsageAuth } from "../src/query.js";
import usageExtension from "../src/usage.js";

const model = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai", baseUrl: "https://api.openai.com/v1" };
const credential = {
  type: "oauth",
  access: "synthetic-auth-state-access",
  refresh: "synthetic-auth-state-refresh",
  expires: Date.now() + 3_600_000,
  clientId: "synthetic-auth-state-client",
  scopes: ["chatgpt.tokens.use.direct"],
};
const proxy = "https://proxy.example.test/v1";

async function shutdown(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
}

for (const headers of [
  undefined,
  { Authorization: null },
  { Authorization: "" },
  { Authorization: "Bearer model-only-key" },
]) {
  test(`missing provider auth is unavailable with model headers ${JSON.stringify(headers)}`, async () => {
    const reader = vi.fn(() => undefined);
    const context = createMockContext({
      model,
      modelRegistry: {
        getAvailable: () => [model],
        getAll: () => [model],
        getProviderAuth: async () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: true, headers }),
      },
    });
    assert.equal(await resolveUsageAuth(context.ctx, OPENAI_CHATGPT_ADAPTER, undefined, reader), undefined);
    assert.equal(reader.mock.calls.length, 0);
  });
}

type Failure =
  | "missing candidate"
  | "mismatched candidate"
  | "missing client ID"
  | "missing direct scope"
  | "conflicting candidates"
  | "Authorization replacement"
  | "Authorization removal"
  | "empty Authorization"
  | "provider Authorization replacement"
  | "readiness rejection"
  | "credential discovery failure"
  | "provider resolution failure"
  | "provider timeout"
  | "model resolution failure"
  | "configured provider origin"
  | "resolved provider origin"
  | "resolved model origin";

function scenario(failure: Failure, recover = true, route?: "another" | "all") {
  const mock = createMockPi();
  const choices =
    route === "another"
      ? ["View another configured provider…", "OpenAI", "Close"]
      : route === "all"
        ? ["View all configured providers…", "Close"]
        : ["Close"];
  let attempts = 0;
  let title = "";
  const invalid = () => !recover || attempts === 1;
  mock.eventBus.on(OAUTH_CREDENTIAL_READINESS_CHANNEL, (data) => {
    const request = data as { provider: string; waitUntil(value: Promise<unknown>): void };
    if (request.provider !== "openai") return;
    attempts += 1;
    if (failure === "readiness rejection" && invalid()) request.waitUntil(Promise.reject(new Error("not ready")));
  });
  mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
    const request = data as { provider: string; offer(value: unknown): void };
    if (request.provider !== "openai") return;
    if (invalid()) {
      if (failure === "missing candidate") return;
      if (failure === "mismatched candidate") {
        request.offer({ ...credential, access: "synthetic-other-account" });
        return;
      }
      if (failure === "missing client ID") {
        request.offer({ ...credential, clientId: undefined });
        return;
      }
      if (failure === "missing direct scope") {
        request.offer({ ...credential, scopes: [] });
        return;
      }
      if (failure === "conflicting candidates")
        request.offer({ ...credential, refresh: "synthetic-conflicting-refresh" });
    }
    request.offer(credential);
  });
  const emit = mock.rawPi.events.emit;
  mock.rawPi.events.emit = (channel, data) => {
    if (channel === OAUTH_CREDENTIAL_SOURCE_CHANNEL && failure === "credential discovery failure" && invalid()) {
      throw new Error("credential source unavailable");
    }
    emit(channel, data);
  };
  const context = createMockContext({
    mode: "rpc",
    model: route ? { ...model, provider: "unsupported" } : model,
    select: async (value: string) => {
      title = value;
      return choices.shift() ?? "Close";
    },
    modelRegistry: {
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderDisplayName: (provider: string) => (provider === "openai" ? "OpenAI" : provider),
      getProviderAuthStatus: (provider: string) => ({ configured: provider === "openai" }),
      getProvider: () => ({ baseUrl: failure === "configured provider origin" && invalid() ? proxy : model.baseUrl }),
      getProviderAuth: async () => {
        if (failure === "provider resolution failure" && invalid()) throw new Error("native provider auth is pending");
        if (failure === "provider timeout" && invalid())
          throw Object.assign(new Error("native provider auth timed out"), { name: "TimeoutError" });
        return {
          source: "OAuth",
          auth: {
            apiKey: credential.access,
            ...(failure === "resolved provider origin" && invalid() ? { baseUrl: proxy } : {}),
            ...(failure === "provider Authorization replacement" && invalid()
              ? { headers: { Authorization: "Bearer synthetic-other-account" } }
              : {}),
          },
        };
      },
      getApiKeyAndHeaders: async () => {
        if (failure === "model resolution failure" && invalid())
          return { ok: false, error: "native model auth is pending" };
        return {
          ok: true,
          apiKey: credential.access,
          ...(failure === "resolved model origin" && invalid() ? { baseUrl: proxy } : {}),
          ...(failure === "Authorization replacement" && invalid()
            ? { headers: { Authorization: "Bearer synthetic-other-account" } }
            : {}),
          ...(failure === "Authorization removal" && invalid() ? { headers: { Authorization: null } } : {}),
          ...(failure === "empty Authorization" && invalid() ? { headers: { Authorization: "" } } : {}),
        };
      },
    },
  });
  usageExtension(mock.pi, { credentialReader: () => undefined });
  const command = mock.commands.get("usage");
  assert.ok(command);
  return { mock, context, query: () => command.handler("", context.ctx), attempts: () => attempts, title: () => title };
}

for (const failure of [
  "missing candidate",
  "mismatched candidate",
  "missing client ID",
  "missing direct scope",
  "conflicting candidates",
  "Authorization replacement",
  "Authorization removal",
  "empty Authorization",
  "provider Authorization replacement",
  "readiness rejection",
  "credential discovery failure",
  "provider resolution failure",
  "model resolution failure",
  "configured provider origin",
  "resolved provider origin",
  "resolved model origin",
] satisfies Failure[]) {
  test(`native ${failure} is revalidated before a recovered OAuth status is published`, async () => {
    const harness = scenario(failure);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await harness.query();
      assert.match(harness.title(), /Connected \(native OAuth\)/);
      assert.doesNotMatch(harness.title(), /Authentication unavailable|Unsupported/);
      assert.ok(harness.attempts() >= 2);
      assert.equal(harness.context.statuses.get("usage"), "chatgpt usage: web only");
      assert.equal(fetch.mock.calls.length, 0);
    } finally {
      await shutdown(harness.mock, harness.context.ctx);
      vi.unstubAllGlobals();
    }
  });
}

for (const route of ["another", "all"] as const) {
  test(`configured native auth failures are revalidated through the ${route} menu route`, async () => {
    const harness = scenario("missing direct scope", true, route);
    try {
      await harness.query();
      assert.match(harness.title(), /Connected \(native OAuth\)/);
      assert.doesNotMatch(harness.title(), /complete native ChatGPT grant/);
      assert.equal(harness.context.statuses.get("usage"), undefined);
    } finally {
      await shutdown(harness.mock, harness.context.ctx);
    }
  });
}

test("stable native auth failure is revalidated once and remains visible without exhausting retries", async () => {
  const harness = scenario("missing direct scope", false);
  try {
    await harness.query();
    assert.match(harness.title(), /Authentication unavailable:.*complete native ChatGPT grant/);
    assert.equal(harness.context.statuses.get("usage"), "auth unavailable");
    assert.equal(harness.attempts(), 2);
    assert.deepEqual(harness.context.notifications, []);
  } finally {
    await shutdown(harness.mock, harness.context.ctx);
  }
});

test("native auth timeouts preserve query-failed behavior without extra auth reads", async () => {
  const harness = scenario("provider timeout", false);
  try {
    await harness.query();
    assert.match(harness.title(), /Query failed: native provider auth timed out/);
    assert.equal(harness.attempts(), 1);
  } finally {
    await shutdown(harness.mock, harness.context.ctx);
  }
});

for (const boundary of ["session_shutdown", "session_start"] as const) {
  test(`pending native failure revalidation cannot publish after ${boundary}`, async () => {
    const harness = scenario("missing direct scope");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    harness.mock.eventBus.on(OAUTH_CREDENTIAL_READINESS_CHANNEL, (data) => {
      if (harness.attempts() === 2) {
        (data as { waitUntil(value: Promise<unknown>): void }).waitUntil(pending);
        ready();
      }
    });
    const querying = harness.query();
    try {
      await entered;
      const replacement = createMockContext({ mode: "rpc", model: { ...model, provider: "unsupported" } });
      const ctx = boundary === "session_start" ? replacement.ctx : harness.context.ctx;
      for (const handler of harness.mock.events.get(boundary) ?? []) await handler({}, ctx);
      release();
      await querying;
      assert.equal(harness.title(), "");
      assert.notEqual(harness.context.statuses.get("usage"), "chatgpt usage: web only");
    } finally {
      release();
      await querying;
      await shutdown(harness.mock, harness.context.ctx);
    }
  });
}

test("revalidated native failures publish the latest reason rather than an earlier failure", async () => {
  const harness = scenario("missing candidate", false);
  const offer = harness.mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
    if (harness.attempts() >= 2) (data as { offer(value: unknown): void }).offer({ ...credential, scopes: [] });
  });
  try {
    await harness.query();
    assert.match(harness.title(), /complete native ChatGPT grant/);
    assert.doesNotMatch(harness.title(), /does not match an available/);
    assert.equal(harness.attempts(), 4);
  } finally {
    offer();
    await shutdown(harness.mock, harness.context.ctx);
  }
});
