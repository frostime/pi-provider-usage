# @frostime/pi-provider-usage

[中文文档](./README.zh-CN.md)

A Pi extension that only queries Provider usage, forked and modified from [pi-usage](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage).

## Usage

```text
/provider-usage:print                   Print the Provider of the current model
/provider-usage:print codex             Print OpenAI Codex
/provider-usage:print all               Print all configured and supported Providers

/provider-usage:overlay                 Show the current Provider in an overlay panel
/provider-usage:overlay opencode-go     Show OpenCode Go in that panel
/provider-usage:overlay all             Show all configured and supported Providers
/provider-usage:overlay close           Close the panel
```

Type `/provider-usage:print ` or `/provider-usage:overlay ` to trigger argument completion. Completion only lists configured, built-in supported Providers and `all`; the overlay command also offers `close`. `codex` is a shorthand for `openai-codex`, and the full ID also works. Querying another Provider does not switch the current model.

`print` queries once and reports the result as plain text. It works in TUI and RPC mode and opens no panel.

`overlay` displays a panel on the right side, capped at 72 columns and sized to its report, showing query progress and snapshot time. It requires TUI mode.

![Overlay](./assets/showit.webp)

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+R` | Re-query the current scope; `all` re-checks configured Providers |
| `Ctrl+Alt+A` | Set overlay auto-refresh: `on`, `off`, or an integer interval in minutes |
| `Ctrl+Alt+Q` | Close the overlay and cancel any pending queries |
| `Ctrl+Alt+↑/↓` | Scroll through long results |

Running the overlay command again retargets the existing panel instead of stacking windows. The overlay and input listeners are cleaned up on `close`, model or session switch, or exit.

### Overlay auto-refresh

Auto-refresh is off by default. With the panel open, press `Ctrl+Alt+A` to enter `on`, `off`, or a whole number of minutes (1–35791). Enter applies the value; Esc or empty input cancels. `on` reuses the last interval, or 5 minutes if none was set. The input dialog temporarily takes focus and restores the previous focus when dismissed.

To enable it by default, add this to Pi's `settings.json` and run `/reload`:

```json
{
  "npm:@frostime/pi-provider-usage": {
    "autoRefreshOverlay": 5
  }
}
```

The setting accepts `"on"`, `"off"`, or an integer number of minutes, not booleans. Shortcut changes last for this Pi run, including reopening the panel and switching models or sessions; they do not modify the file. Polling only runs while the overlay is open. Each completed query schedules the next refresh, with no overlapping automatic queries. Automatic refresh preserves the scroll position; manual refresh returns to the top. Closing the panel clears its timer and pending input dialog. `print` is unchanged and always queries on demand.

## Install from npm

```bash
pi install npm:@frostime/pi-provider-usage
```

## Install from GitHub

```bash
pi install git:github.com/frostime/pi-provider-usage
```

## Local Loading

Requires a Pi version that supports non-focus-stealing overlays, terminal input listeners, and valid authentication endpoint validation; Pi **1.0.2** is used for development and testing.

```bash
# Run in this repository directory, loaded only for this launch
pi -e .

# Or register as a personal local extension
pi install .
```

TypeScript source is loaded directly, no build step required. No third-party runtime dependencies; Pi provides the host packages.

Development checks:

```bash
npm ci --ignore-scripts
npm run check
```

## Scope and Limitations

Retains the upstream 17 Provider IDs; see [Provider documentation](docs/providers.md) for the full list. Different Providers return subscription quotas, balances, or spending respectively; different currencies and billing semantics are not mixed.

- Native `openai` ChatGPT OAuth can only display authentication status and a usage web link; it cannot query numeric quotas. `openai-codex` can query numeric quotas. OpenAI API-key usage queries are not supported.
- Fireworks is queried automatically when only one billing account is visible; when multiple accounts exist, it prompts that an account must be specified. The current version has no account selection feature—it does not default to the first account, nor does it aggregate.
- A Provider query uses the authentication currently resolved by Pi; it does not iterate over other saved accounts.
- Credentials for custom or proxy endpoints are not forwarded to official usage APIs. Official APIs may change, and returned data may be delayed.

For query, timeout, and cancellation behavior, see [Operations documentation](docs/operations.md).

## Security and Provenance

The extension runs with the same process permissions as Pi; only load code you trust. Authentication is used solely to request the matching official APIs; endpoint validation, request-boundary authentication re-verification, error redaction, and response size limits are retained, and HTTP redirects are rejected. Results do not store keys or tokens.

For the upstream snapshot and scope of modifications, see [UPSTREAM.md](UPSTREAM.md). Licensed under [MIT](LICENSE), with upstream copyright notices retained.
