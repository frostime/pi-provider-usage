import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import type { Component, Terminal } from "@earendil-works/pi-tui";
import { test } from "vitest";
// Characterize the exact host widget/input boundary against the pinned Pi dev dependency.
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { openUsageOverlay } from "../src/usage-overlay.js";

initTheme("dark", false);

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`${Renderer.name}: usage preserves editor input/streaming and closes only its own overlay`, async () => {
    let feed!: (data: string) => void;
    const writes: string[] = [];
    const terminal: Terminal = {
      columns: 160,
      rows: 48,
      kittyProtocolActive: false,
      start(onInput) {
        feed = onInput;
      },
      stop() {},
      drainInput: async () => {},
      write: (data) => {
        writes.push(data);
      },
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
    };
    const tui = new Renderer(terminal);
    let streamed = "assistant is streaming";
    const stream: Component = { render: () => [streamed], invalidate() {} };
    const editor = {
      focused: false,
      draft: "keep draft",
      getText() {
        return this.draft;
      },
      render() {
        return [this.draft + (this.focused ? CURSOR_MARKER : "")];
      },
      invalidate() {},
      handleInput(data: string) {
        this.draft += data;
        tui.requestRender();
      },
    };
    const above = new Container();
    const below = new Container();
    tui.addChild(stream);
    tui.addChild(above);
    tui.addChild(editor);
    tui.addChild(below);
    tui.setFocus(editor);
    const mode = {
      ui: tui,
      extensionWidgetsAbove: new Map(),
      extensionWidgetsBelow: new Map(),
      widgetContainerAbove: above,
      widgetContainerBelow: below,
      extensionTerminalInputSubscriptions: new Set(),
      renderWidgets: InteractiveMode.prototype.renderWidgets,
      renderWidgetContainer: InteractiveMode.prototype.renderWidgetContainer,
    };
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme: { fg: (_role: string, text: string) => text } as Theme,
        setWidget: InteractiveMode.prototype.setExtensionWidget.bind(mode),
        onTerminalInput: InteractiveMode.prototype.addExtensionTerminalInputListener.bind(mode),
      },
    } as unknown as ExtensionContext;
    const before = below.render(160);
    const signals: AbortSignal[] = [];
    tui.start();
    let overlay: ReturnType<typeof openUsageOverlay> | undefined;
    let confirmationHandle: ReturnType<typeof tui.showOverlay> | undefined;
    const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
    try {
      overlay = openUsageOverlay(ctx, "all", async (signal) => {
        signals.push(signal);
        return [
          {
            providerId: "example",
            providerName: "Example",
            displayState: "configured",
            status: "query-failed",
            message: "503",
          },
        ];
      });
      await frame();
      assert.equal(editor.focused, true);
      assert.deepEqual(below.render(160), before);
      assert.ok(writes.some((data) => data.includes("Provider usage")));
      feed("q");
      assert.equal(editor.draft, "keep draftq");
      feed("\x1b[114;7u");
      await frame();
      assert.equal(signals.length, 2);
      assert.equal(editor.draft, "keep draftq");
      streamed = "assistant continues streaming underneath usage";
      tui.requestRender();
      await frame();
      assert.ok(writes.some((data) => data.includes("continues streaming")));

      const confirmation = {
        focused: false,
        inputs: [] as string[],
        render: () => ["another confirmation"],
        invalidate() {},
        handleInput(data: string) {
          this.inputs.push(data);
        },
      };
      confirmationHandle = tui.showOverlay(confirmation, { width: 32 });
      await frame();
      assert.equal(confirmation.focused, true);
      feed("\x1b[113;7u");
      await overlay.closed;
      assert.equal(confirmationHandle.isFocused(), true);
      assert.equal(confirmation.focused, true);
      assert.deepEqual(confirmation.inputs, []);
      assert.equal(mode.extensionWidgetsBelow.size, 0);
      assert.equal(mode.extensionTerminalInputSubscriptions.size, 0);
      assert.deepEqual(below.render(160), before);
      feed("r");
      assert.deepEqual(confirmation.inputs, ["r"]);
      confirmationHandle.hide();
      assert.equal(editor.focused, true);
      assert.equal(editor.draft, "keep draftq");
    } finally {
      overlay?.close();
      confirmationHandle?.hide();
      tui.stop();
    }
  });
}
