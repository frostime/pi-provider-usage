import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "./support.js";

test("Pi loads this standalone package directly and runs provider-usage through Jiti", async () => {
  const packageRoot = resolve(import.meta.dirname, "..");
  const tempParent = resolve(packageRoot, "tmp");
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(resolve(tempParent, "loader-test-"));
  const agentDir = resolve(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(agentDir);
    // Isolate the real loader from personal configuration and credentials.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [packageRoot],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0]!;
    assert.deepEqual([...extension.commands.keys()], ["provider-usage"]);
    assert.ok(extension.entryRenderers.has("provider-usage"));
    assert.ok(!extension.handlers.has("before_provider_request"));

    const model = {
      id: "synthetic-go-model",
      name: "Go",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    };
    const context = createMockContext({
      mode: "rpc",
      model,
      modelRegistry: {
        getAvailable: () => [model],
        getAll: () => [model],
        getProviderAuth: async () => ({ source: "API key", auth: { apiKey: "synthetic-loader-key" } }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-loader-key" }),
      },
    });
    const fetch = vi.fn(async (url: string) => {
      assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
      return Response.json({ usage: { rolling: { status: "ok", percent: 25 } } });
    });
    vi.stubGlobal("fetch", fetch);
    await extension.commands.get("provider-usage")!.handler("", context.ctx);
    assert.match(context.notifications[0]!.message, /OpenCode Go Usage · Current/);
    assert.match(context.notifications[0]!.message, /75%/);
    assert.equal(fetch.mock.calls.length, 1);
  } finally {
    vi.unstubAllGlobals();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    // root is the exact mkdtemp directory created by this test, under ignored tmp/.
    await rm(root, { recursive: true, force: true });
  }
});
