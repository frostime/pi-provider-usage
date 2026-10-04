import assert from "node:assert/strict";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { OPENAI_CHATGPT_ADAPTER, UnsupportedOpenAIUsageAuthError } from "../src/providers/openai-chatgpt.js";
import { resolveUsageAuth } from "../src/query.js";
import usageExtension from "../src/usage.js";
import { createMockContext, createMockPi } from "./support.js";

const credential: Credential = {
  type: "oauth",
  access: "synthetic-chatgpt-access",
  refresh: "synthetic-chatgpt-refresh",
  expires: Date.now() + 3_600_000,
  clientId: "synthetic-native-client",
  scopes: ["chatgpt.tokens.use.direct"],
};

async function createRegistry(stored: Credential | null = credential) {
  const store: CredentialStore = {
    read: async (provider) => (provider === "openai" ? (stored ?? undefined) : undefined),
    list: async () => (stored ? [{ providerId: "openai", type: stored.type }] : []),
    modify: async () => {
      throw new Error("A fresh synthetic credential must not be refreshed.");
    },
    delete: async () => undefined,
  };
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const model = registry.getAll().find((candidate) => candidate.provider === "openai");
  assert.ok(model);
  return { runtime, registry, model };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("real Pi native OAuth reports authentication and a usage link without backend requests", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("Native auth status must not query an unverified endpoint.");
  });
  vi.stubGlobal("fetch", fetch);
  const { registry, model } = await createRegistry();
  const mock = createMockPi();
  usageExtension(mock.pi, { credentialReader: () => credential });
  const { ctx, notifications } = createMockContext({ mode: "rpc", model, modelRegistry: registry });
  await mock.commands.get("provider-usage")!.handler("", ctx);
  const text = notifications[0]?.message ?? "";
  assert.match(text, /Connected \(native OAuth\)/);
  assert.match(text, /https:\/\/chatgpt.com\/settings\/usage/);
  assert.doesNotMatch(text, /Unsupported|[0-9]+%|synthetic-/);
  assert.equal(fetch.mock.calls.length, 0);
});

test("real Pi without credentials reports auth unavailable rather than API-key unsupported", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const { registry, model } = await createRegistry(null);
  const mock = createMockPi();
  usageExtension(mock.pi, { credentialReader: () => undefined });
  const { ctx, notifications } = createMockContext({ mode: "rpc", model, modelRegistry: registry });
  await mock.commands.get("provider-usage")!.handler("", ctx);
  const text = notifications[0]?.message ?? "";
  assert.match(text, /Authentication unavailable: No runtime credential/);
  assert.doesNotMatch(text, /API-key|Unsupported/);
});

test("real Pi runtime API-key overrides never reuse stored OAuth as plan authentication", async () => {
  const { runtime, registry, model } = await createRegistry();
  const { ctx } = createMockContext({ model, modelRegistry: registry });
  assert.ok(await resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential));
  await runtime.setRuntimeApiKey("openai", "synthetic-runtime-api-key");
  await assert.rejects(
    () => resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential),
    UnsupportedOpenAIUsageAuthError,
  );
  await runtime.removeRuntimeApiKey("openai");
  assert.ok(await resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential));
});

test("real Pi model Authorization overrides cannot inherit another OAuth account's plan status", async () => {
  const { runtime, registry, model: original } = await createRegistry();
  for (const authorization of ["Bearer synthetic-model-api-key", "", `Bearer ${credential.access}`]) {
    runtime.registerProvider("openai", { models: [{ ...original, headers: { authorization } }] });
    const model = registry.find("openai", original.id);
    assert.ok(model);
    const { ctx } = createMockContext({ model, modelRegistry: registry });
    const resolving = resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential);
    if (authorization === `Bearer ${credential.access}`) assert.ok(await resolving);
    else await assert.rejects(() => resolving, /authorization.*match/);
  }
});
