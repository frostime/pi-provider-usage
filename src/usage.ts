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
import { openUsageOverlay, type UsageOverlayView } from "./usage-overlay.js";
import { resolveUsageTarget } from "./usage-targets.js";

const PRINT_COMMAND = "provider-usage:print";
const OVERLAY_COMMAND = "provider-usage:overlay";
const ALL_ARGUMENT = "all";
const CLOSE_ARGUMENT = "close";
const QUERY_TIMEOUT_MS = 15_000;
const ALL_PROVIDER_CONCURRENCY = 2;

interface UsageExtensionDependencies {
  credentialReader?: StoredCredentialReader;
}

/** A resolved command argument: which providers to query, and how the scope is labelled. */
interface UsageScope {
  label: string;
  adapters: readonly UsageProviderAdapter[];
  /** The `all` scope re-checks which providers are configured on every query. */
  recheckConfigured: boolean;
}

/** Either a scope to query, or a message that ends the command without a request. */
type UsageArgument =
  | { kind: "scope"; scope: UsageScope }
  | { kind: "notice"; message: string; level: "info" | "warning" };

export default function providerUsageExtension(
  pi: ExtensionAPI,
  dependencies: UsageExtensionDependencies = {},
) {
  const credentialCandidates = createOAuthCredentialCandidateReader(pi, dependencies.credentialReader);
  let completionContext: ExtensionContext | undefined;
  let overlay: UsageOverlayView | undefined;
  let pendingPrint: AbortController | undefined;

  const cancelActiveWork = () => {
    const previous = overlay;
    const printing = pendingPrint;
    overlay = undefined;
    pendingPrint = undefined;
    previous?.close();
    printing?.abort();
  };
  pi.on("session_start", (_event, ctx) => {
    cancelActiveWork();
    completionContext = ctx;
  });
  pi.on("model_select", (_event, ctx) => {
    cancelActiveWork();
    completionContext = ctx;
  });
  pi.on("session_shutdown", () => {
    cancelActiveWork();
    completionContext = undefined;
  });

  /** Builds a query that stays valid only while this session and model remain current. */
  const createQuery = (ctx: ExtensionContext, scope: UsageScope) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const modelId = modelIdentity(ctx);
    return async (signal: AbortSignal): Promise<ProviderUsageState[]> => {
      const assertCurrent = () => {
        if (signal.aborted || ctx.sessionManager.getSessionId() !== sessionId || modelIdentity(ctx) !== modelId) {
          throw abortError();
        }
      };
      assertCurrent();
      const adapters = scope.recheckConfigured ? configuredAdapters(ctx) : scope.adapters;
      const outcomes = await runWithConcurrency(
        adapters,
        ALL_PROVIDER_CONCURRENCY,
        (adapter) =>
          queryAdapter(ctx, adapter, signal, assertCurrent, dependencies.credentialReader, credentialCandidates),
        signal,
      );
      assertCurrent();
      return outcomes.map((outcome, index): ProviderUsageState => {
        if (outcome.status === "fulfilled") return outcome.value;
        if (isStaleExtensionContextError(outcome.reason)) throw outcome.reason;
        const adapter = adapters[index]!;
        return {
          ...providerState(ctx, adapter),
          status: "query-failed",
          message: redactUsageError(errorMessage(outcome.reason)),
        };
      });
    };
  };

  const completeArguments = (prefix: string, includeClose: boolean) => {
    if (!completionContext) return null;
    const candidates = configuredAdapters(completionContext).map((adapter) => ({
      value: commandArgument(adapter.id),
      label: commandArgument(adapter.id),
      description: adapter.displayName,
    }));
    candidates.push({ value: ALL_ARGUMENT, label: ALL_ARGUMENT, description: "All configured providers" });
    if (includeClose) {
      candidates.push({ value: CLOSE_ARGUMENT, label: CLOSE_ARGUMENT, description: "Close the overlay" });
    }
    const matches = candidates.filter((item) => item.value.startsWith(prefix.toLowerCase()));
    return matches.length > 0 ? matches : null;
  };

  pi.registerCommand(PRINT_COMMAND, {
    description: "Print usage of the current Provider, one Provider, or all",
    getArgumentCompletions: (prefix) => completeArguments(prefix, false),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify(`/${PRINT_COMMAND} requires TUI or RPC mode.`, "warning");
        return;
      }
      completionContext = ctx;
      const argument = parseUsageArgument(PRINT_COMMAND, ctx, args);
      if (argument.kind === "notice") {
        ctx.ui.notify(argument.message, argument.level);
        return;
      }

      const controller = new AbortController();
      // A later query supersedes an in-flight print, as the overlay refresh does.
      pendingPrint?.abort();
      pendingPrint = controller;
      try {
        const states = await createQuery(ctx, argument.scope)(controller.signal);
        ctx.ui.notify(formatProviderStates(states), "info");
      } catch (error) {
        if (controller.signal.aborted || isStaleExtensionContextError(error) || isAbortError(error)) return;
        ctx.ui.notify(redactUsageError(errorMessage(error)), "error");
      } finally {
        controller.abort();
        if (pendingPrint === controller) pendingPrint = undefined;
      }
    },
  });

  pi.registerCommand(OVERLAY_COMMAND, {
    description: "Show or refresh the usage overlay for the current Provider, one Provider, or all; `close` hides it",
    getArgumentCompletions: (prefix) => completeArguments(prefix, true),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${OVERLAY_COMMAND} requires TUI mode.`, "warning");
        return;
      }
      completionContext = ctx;
      const argument = args.trim().toLowerCase();
      if (argument === CLOSE_ARGUMENT) {
        if (!overlay) {
          ctx.ui.notify("No provider usage overlay is open.", "info");
          return;
        }
        overlay.close();
        overlay = undefined;
        return;
      }

      const parsed = parseUsageArgument(OVERLAY_COMMAND, ctx, argument);
      if (parsed.kind === "notice") {
        ctx.ui.notify(parsed.message, parsed.level);
        return;
      }
      const query = createQuery(ctx, parsed.scope);
      if (overlay) {
        overlay.retarget(parsed.scope.label, query);
        return;
      }
      const view = openUsageOverlay(ctx, parsed.scope.label, query);
      overlay = view;
      // Do not keep the slash-command handler pending while the user keeps the panel open.
      void view.closed.then(() => {
        if (overlay === view) overlay = undefined;
      });
    },
  });
}

function parseUsageArgument(command: string, ctx: ExtensionContext, args: string | undefined): UsageArgument {
  const argument = (args ?? "").trim().toLowerCase();
  if (/\s/u.test(argument)) {
    return { kind: "notice", message: `Usage: /${command} [provider|${ALL_ARGUMENT}]`, level: "warning" };
  }
  if (argument === ALL_ARGUMENT) {
    const adapters = configuredAdapters(ctx);
    if (adapters.length === 0) {
      return {
        kind: "notice",
        message: "No supported provider has configured authentication.",
        level: "info",
      };
    }
    return { kind: "scope", scope: { label: ALL_ARGUMENT, adapters, recheckConfigured: true } };
  }

  const providerId = argument === "codex" ? "openai-codex" : argument || ctx.model?.provider;
  const adapter = adapterForProvider(providerId);
  if (!adapter) {
    return {
      kind: "notice",
      level: "warning",
      message: providerId
        ? `Usage reporting is not supported for ${redactUsageError(providerId)}. Use /${command} ${ALL_ARGUMENT} or choose a provider from completion.`
        : `No model is selected. Specify a provider or ${ALL_ARGUMENT}.`,
    };
  }
  return {
    kind: "scope",
    scope: { label: commandArgument(adapter.id), adapters: [adapter], recheckConfigured: false },
  };
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
