# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file tracks this package only. The upstream history is kept separately in
[docs/UPSTREAM_CHANGELOG.md](docs/UPSTREAM_CHANGELOG.md).

## [Unreleased]

## [0.4.0] - 2026-10-24

### Added
- Each provider block in the overlay starts with a full-width, accent-colored title rule. The rule
  replaces the plain heading line, so it adds no height.

### Changed
- The overlay caps its width at 72 columns (40% of the terminal, minimum 44) instead of growing with
  the terminal, and follows terminal resizes without leaving an oversized panel.
- The overlay shrinks to its report height instead of always claiming 75% of the screen. Long reports
  still scroll inside the panel with the footer pinned.
- Usage rows use a narrower label column and progress bar in both the overlay and `print` output. A
  row that still does not fit moves the whole value (bar, percentage, reset time) below its label.
- Reset times are compact and locale-independent: `HH:mm` for today, `MM-DD HH:mm` otherwise, with
  the year only when it differs.
- Narrow panels shorten the footer and snapshot line instead of wrapping them.

## [0.3.0] - 2026-10-13

### Changed
- **Breaking:** the single `/provider-usage` command is split in two.
  `/provider-usage:print [provider|all]` queries once and reports plain text, and works in TUI and RPC
  mode. `/provider-usage:overlay [provider|all]` shows the panel and requires TUI mode.
- Running the overlay command again now retargets the open panel to the new scope and queries it
  immediately, instead of closing it and opening another window. Repeating the same scope refreshes in place.
- Overlay argument completion additionally offers `close`.

### Added
- `/provider-usage:overlay close` dismisses the panel without issuing a query, and reports when no panel is open.
- A pending print query is cancelled when a later print query starts, matching how the overlay refresh works.

### Removed
- **Breaking:** the `/provider-usage` command name. Use `provider-usage:print` or `provider-usage:overlay`.

## [0.2.0] - 2026-10-05

### Added
- Provider usage is shown in a transient, non-focus-stealing overlay panel on the right side, with
  `Ctrl+Alt+R` to refresh, `Ctrl+Alt+Q` to close, and `Ctrl+Alt+↑/↓` to scroll.
- The command returns while its query is still pending, so the main agent turn keeps streaming and the
  editor keeps focus.

### Changed
- Running the command again replaces the existing overlay instead of stacking panels.
- Closing the overlay, or a model or session change or exit, removes the panel, its input listener, and any
  in-flight query.

## [0.1.0] - 2026-10-04

### Added
- Initial release: the upstream `pi-usage` extension reduced to a query-only provider usage report for
  `/provider-usage [provider|all]`, keeping the upstream 17 provider adapters and their quota, balance, and
  spend semantics.
- Usage queries authenticate with the credentials Pi resolves at runtime, validate endpoints, re-check
  credentials around each request, redact errors, and limit response size; HTTP redirects are rejected.
- Fireworks billing accounts are queried automatically when only one is visible, and reported as needing an
  explicit choice when several are visible.

[Unreleased]: https://github.com/frostime/pi-provider-usage/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/frostime/pi-provider-usage/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/frostime/pi-provider-usage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/frostime/pi-provider-usage/tree/v0.1.0
