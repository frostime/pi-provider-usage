import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type Handler = (...args: any[]) => any;

export function createMockPi() {
  const commands = new Map<
    string,
    { description?: string; handler: Handler; getArgumentCompletions?: (prefix: string) => any }
  >();
  const events = new Map<string, Handler[]>();
  const entryRenderers = new Map<string, Handler>();
  const entries: Array<{ customType: string; data: any }> = [];
  const sentMessages: unknown[] = [];
  const sentUserMessages: unknown[] = [];
  const subscriptions = new Map<string, Handler[]>();
  const eventBus = {
    emit(channel: string, data: unknown) {
      for (const handler of subscriptions.get(channel) ?? []) {
        try {
          void Promise.resolve(handler(data)).catch(() => undefined);
        } catch {
          /* Pi isolates observers. */
        }
      }
    },
    on(channel: string, handler: Handler) {
      const handlers = subscriptions.get(channel) ?? [];
      handlers.push(handler);
      subscriptions.set(channel, handlers);
      return () =>
        subscriptions.set(
          channel,
          handlers.filter((item) => item !== handler),
        );
    },
    clear: () => subscriptions.clear(),
  };
  const rawPi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerEntryRenderer: (type: string, renderer: Handler) => entryRenderers.set(type, renderer),
    on(name: string, handler: Handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendMessage: (message: unknown) => sentMessages.push(message),
    sendUserMessage: (message: unknown) => sentUserMessages.push(message),
    events: eventBus,
  };
  return {
    pi: rawPi as unknown as ExtensionAPI,
    rawPi,
    commands,
    events,
    eventBus,
    entryRenderers,
    entries,
    sentMessages,
    sentUserMessages,
  };
}

export function createMockContext(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    model: undefined,
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      select:
        overrides.select ??
        (async () => {
          throw new Error("Usage queries must not open a menu.");
        }),
      custom:
        overrides.custom ??
        (async () => {
          throw new Error("Usage queries must not open a custom UI.");
        }),
    },
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [],
      getEntries: () => [],
    },
    modelRegistry: {
      getAvailable: () => [],
      getAll: () => [],
      getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
    },
    ...overrides,
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notifications, statuses };
}

export async function emit(mock: ReturnType<typeof createMockPi>, event: string, ctx: unknown) {
  for (const handler of mock.events.get(event) ?? []) await handler({}, ctx);
}
