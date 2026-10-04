import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-usage",
  forbiddenEagerInputs: [],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-usage-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("usage"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const credential = {
      type: "oauth",
      access: "synthetic-generated-access",
      refresh: "synthetic-generated-refresh",
      expires: Date.now() + 3_600_000,
      clientId: "synthetic-generated-client",
      scopes: ["chatgpt.tokens.use.direct"],
    };
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: credential }), { mode: 0o600 });
    const model = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai", baseUrl: "https://api.openai.com/v1" };
    let title = "";
    const context = createMockContext({
      mode: "rpc",
      cwd: root,
      model,
      select: async (value: string) => {
        title = value;
        return "Close";
      },
      modelRegistry: {
        getAvailable: () => [model],
        getAll: () => [model],
        getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: credential.access } }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: credential.access }),
      },
    });
    try {
      // Trigger the generated native-auth path and lazy Kit boundary through Jiti, not Vitest's importer.
      const command = extension.commands.get("usage");
      assert.ok(command);
      await command.handler("", context.ctx);
      assert.match(title, /Connected \(native OAuth\)/);
      assert.match(title, /Numerical usage.*unavailable/);
      assert.match(title, /https:\/\/chatgpt\.com\/settings\/usage/);
      assert.equal(context.statuses.get("usage"), "chatgpt usage: web only");
    } finally {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, context.ctx);
    }
    assert.equal(context.statuses.get("usage"), undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
