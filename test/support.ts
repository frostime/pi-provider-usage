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
  const terminalInputHandlers = new Set<(data: string) => { consume?: boolean } | undefined>();
  const overlays: Array<{ component?: any; options: any; closed: boolean }> = [];
  const widgets = new Map<string, any>();
  const terminal = { columns: 160, rows: 64 };
  let renderRequests = 0;
  const tui = {
    terminal,
    requestRender: () => {
      renderRequests += 1;
    },
    showOverlay(component: any, options: any) {
      const overlay = { component, options, closed: false };
      overlays.push(overlay);
      return {
        hide: () => {
          overlay.closed = true;
        },
        isHidden: () => overlay.closed,
        getBounds: () => (overlay.closed ? undefined : { row: 2, col: 90, width: 64, height: 48 }),
      };
    },
  };
  const theme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  const custom = (factory: any, options: any) => {
    const overlay: (typeof overlays)[number] = { options, closed: false };
    overlays.push(overlay);
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        if (overlay.closed) return;
        overlay.closed = true;
        resolve();
        overlay.component?.dispose?.();
      };
      Promise.resolve(factory(tui, theme, {}, done))
        .then((component) => {
          if (overlay.closed) return;
          overlay.component = component;
          options?.onHandle?.({ isHidden: () => false, getBounds: () => ({ row: 2, col: 90, width: 64, height: 48 }) });
        })
        .catch(reject);
    });
  };
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    model: undefined,
    ui: {
      theme,
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      setWidget: (key: string, content: any) => {
        widgets.get(key)?.dispose?.();
        widgets.delete(key);
        if (content !== undefined) widgets.set(key, typeof content === "function" ? content(tui, theme) : content);
      },
      select:
        overrides.select ??
        (async () => {
          throw new Error("Usage queries must not open a menu.");
        }),
      custom: overrides.custom ?? custom,
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
        terminalInputHandlers.add(handler);
        return () => {
          terminalInputHandlers.delete(handler);
        };
      },
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
  return {
    ctx: ctx as unknown as ExtensionCommandContext,
    notifications,
    statuses,
    overlays,
    widgets,
    terminal,
    terminalInputHandlers,
    input(data: string) {
      for (const handler of [...terminalInputHandlers]) {
        if (handler(data)?.consume) return true;
      }
      return false;
    },
    get renderRequests() {
      return renderRequests;
    },
  };
}

export async function emit(mock: ReturnType<typeof createMockPi>, event: string, ctx: unknown) {
  for (const handler of mock.events.get(event) ?? []) await handler({}, ctx);
}
