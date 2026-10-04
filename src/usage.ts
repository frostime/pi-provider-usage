import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortError, awaitWithDeadline, errorMessage, redactUsageError, runWithConcurrency } from "./core.js";
import { formatProviderStates } from "./format.js";
import {
  createOAuthCredentialCandidateReader,
  type OAuthCredentialCandidateReader,
  type StoredCredentialReader,
} from "./oauth-credential-source.js";
import { UnsupportedOpenAIUsageAuthError } from "./providers/openai-chatgpt.js";
import {
  adapterForProvider,
  isStaleExtensionContextError,
  providerIsConfigured,
  queryProviderUsage,
  resolveUsageAuth,
  usageAdapters,
} from "./query.js";
import type { ProviderUsageState, ResolvedUsageAuth, UsageProviderAdapter } from "./types.js";
import { openUsageOverlay } from "./usage-overlay.js";
import { resolveUsageTarget } from "./usage-targets.js";

const COMMAND = "provider-usage";
const QUERY_TIMEOUT_MS = 15_000;
const ALL_PROVIDER_CONCURRENCY = 2;

interface UsageExtensionDependencies {
  credentialReader?: StoredCredentialReader;
}

export default function providerUsageExtension(pi: ExtensionAPI, dependencies: UsageExtensionDependencies = {}) {
  const credentialCandidates = createOAuthCredentialCandidateReader(pi, dependencies.credentialReader);
  let completionContext: ExtensionContext | undefined;
  let activeView: { close(): void } | undefined;

  const closeActiveView = () => {
    const previous = activeView;
    activeView = undefined;
    previous?.close();
  };
  pi.on("session_start", (_event, ctx) => {
    closeActiveView();
    completionContext = ctx;
  });
  pi.on("model_select", (_event, ctx) => {
    closeActiveView();
    completionContext = ctx;
  });
  pi.on("session_shutdown", () => {
    closeActiveView();
    completionContext = undefined;
  });

  pi.registerCommand(COMMAND, {
    description: "Show provider usage: current provider, a provider ID, or all",
    getArgumentCompletions: (prefix) => {
      if (!completionContext) return null;
      const candidates = configuredAdapters(completionContext).map((adapter) => ({
        value: commandArgument(adapter.id),
        label: commandArgument(adapter.id),
        description: adapter.displayName,
      }));
      candidates.push({ value: "all", label: "all", description: "All configured providers" });
      const matches = candidates.filter((item) => item.value.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify(`/${COMMAND} requires TUI or RPC mode.`, "warning");
        return;
      }
      completionContext = ctx;
      const argument = args.trim().toLowerCase();
      if (/\s/u.test(argument)) {
        ctx.ui.notify(`Usage: /${COMMAND} [provider|all]`, "warning");
        return;
      }
      let adapters: readonly UsageProviderAdapter[];
      if (argument === "all") {
        adapters = configuredAdapters(ctx);
        if (adapters.length === 0) {
          ctx.ui.notify("No supported provider has configured authentication.", "info");
          return;
        }
      } else {
        const providerId = argument === "codex" ? "openai-codex" : argument || ctx.model?.provider;
        const adapter = adapterForProvider(providerId);
        if (!adapter) {
          ctx.ui.notify(
            providerId
              ? `Usage reporting is not supported for ${redactUsageError(providerId)}. Use /${COMMAND} all or choose a provider from completion.`
              : "No model is selected. Specify a provider or all.",
            "warning",
          );
          return;
        }
        adapters = [adapter];
      }

      closeActiveView();
      const sessionId = ctx.sessionManager.getSessionId();
      const modelId = modelIdentity(ctx);
      const query = async (signal: AbortSignal): Promise<ProviderUsageState[]> => {
        const assertCurrent = () => {
          if (signal.aborted || ctx.sessionManager.getSessionId() !== sessionId || modelIdentity(ctx) !== modelId) {
            throw abortError();
          }
        };
        assertCurrent();
        // Refresh the configured set as well as credentials when the scope is all.
        const currentAdapters = argument === "all" ? configuredAdapters(ctx) : adapters;
        const outcomes = await runWithConcurrency(
          currentAdapters,
          ALL_PROVIDER_CONCURRENCY,
          (adapter) =>
            queryAdapter(ctx, adapter, signal, assertCurrent, dependencies.credentialReader, credentialCandidates),
          signal,
        );
        assertCurrent();
        return outcomes.map((outcome, index): ProviderUsageState => {
          if (outcome.status === "fulfilled") return outcome.value;
          if (isStaleExtensionContextError(outcome.reason)) throw outcome.reason;
          const adapter = currentAdapters[index]!;
          return {
            ...providerState(ctx, adapter),
            status: "query-failed",
            message: redactUsageError(errorMessage(outcome.reason)),
          };
        });
      };

      if (ctx.mode === "tui") {
        const scope = argument === "all" ? "all" : commandArgument(adapters[0]!.id);
        const view = openUsageOverlay(ctx, scope, query);
        activeView = view;
        // Do not keep the slash-command handler pending while the user keeps the panel open.
        void view.closed.then(() => {
          if (activeView === view) activeView = undefined;
        });
        return;
      }

      const controller = new AbortController();
      const request = { close: () => controller.abort() };
      activeView = request;
      try {
        const states = await query(controller.signal);
        ctx.ui.notify(formatProviderStates(states), "info");
      } catch (error) {
        if (controller.signal.aborted || isStaleExtensionContextError(error) || isAbortError(error)) return;
        ctx.ui.notify(redactUsageError(errorMessage(error)), "error");
      } finally {
        controller.abort();
        if (activeView === request) activeView = undefined;
      }
    },
  });
}

function configuredAdapters(ctx: ExtensionContext): UsageProviderAdapter[] {
  return usageAdapters().filter(
    (adapter) => adapter.id === ctx.model?.provider || providerIsConfigured(ctx, adapter.id),
  );
}

function commandArgument(providerId: string): string {
  return providerId === "openai-codex" ? "codex" : providerId;
}

function modelIdentity(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function providerState(ctx: ExtensionContext, adapter: UsageProviderAdapter) {
  return {
    providerId: adapter.id,
    providerName: adapter.displayName,
    displayState: ctx.model?.provider === adapter.id ? ("current" as const) : ("configured" as const),
  };
}

async function queryAdapter(
  ctx: ExtensionContext,
  adapter: UsageProviderAdapter,
  callerSignal: AbortSignal,
  assertCurrent: () => void,
  credentialReader: StoredCredentialReader | undefined,
  credentialCandidates: OAuthCredentialCandidateReader,
): Promise<ProviderUsageState> {
  const state = providerState(ctx, adapter);
  const controller = new AbortController();
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  const deadlineAt = Date.now() + QUERY_TIMEOUT_MS;
  const remainingTime = () => Math.max(1, deadlineAt - Date.now());
  let auth: ResolvedUsageAuth | undefined;
  let failureStatus: "auth-unavailable" | "query-failed" = "auth-unavailable";
  const resolveAuth = () => resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates);
  const query = async (): Promise<ProviderUsageState> => {
    assertCurrent();
    auth = await resolveAuth();
    signal.throwIfAborted();
    assertCurrent();
    if (!auth)
      return {
        ...state,
        status: "auth-unavailable",
        message: `No runtime credential is configured for ${adapter.displayName}.`,
      };
    const expectedFingerprint = auth.fingerprint;
    failureStatus = "query-failed";
    const guard = async () => {
      signal.throwIfAborted();
      assertCurrent();
      const fresh = await resolveAuth();
      signal.throwIfAborted();
      assertCurrent();
      if (fresh?.fingerprint !== expectedFingerprint) {
        throw new Error("Provider authentication changed during the query; run the command again.");
      }
    };
    const target = await resolveUsageTarget(adapter, auth, undefined, signal, remainingTime(), guard);
    if (target.kind === "selection-required") {
      return {
        ...state,
        status: "selection-required",
        singularLabel: adapter.targets!.singularLabel,
        pluralLabel: adapter.targets!.pluralLabel,
        choices: target.choices,
      };
    }
    // Revalidate even adapters that do not call the guard themselves, before sending credentials.
    await guard();
    const report = await queryProviderUsage(adapter, auth, signal, remainingTime(), guard, target.targetId);
    await guard();
    return { ...state, status: "ready", report };
  };
  try {
    return await awaitWithDeadline(query(), callerSignal, QUERY_TIMEOUT_MS, `querying ${adapter.displayName} usage`);
  } catch (error) {
    if (callerSignal.aborted || isStaleExtensionContextError(error) || isAbortError(error)) throw error;
    return {
      ...state,
      status:
        error instanceof UnsupportedOpenAIUsageAuthError
          ? "unsupported"
          : isTimeoutError(error)
            ? "query-failed"
            : failureStatus,
      message: redactUsageError(errorMessage(error), auth?.secrets),
    };
  } finally {
    controller.abort();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
