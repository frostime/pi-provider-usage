# Upstream provenance

- Repository: https://github.com/narumiruna/pi-extensions
- Imported subdirectory: `packages/pi-usage`
- Snapshot: `fa8548d258b36446b2157311adbcbca7feae2d94`
- Imported package version: `@narumitw/pi-usage` 0.61.2
- Local import commit: `154b5d8`
- License: MIT; original copyright notice retained in `LICENSE`.

The initial local commit contains all 79 package files unchanged, plus standalone ignore rules. This repository has its own Git history; the rest of the upstream monorepo was not imported.

The fork retains all 17 provider adapters and their query/normalization/authentication rules, but replaces the menu orchestrator with `/provider-usage [provider|all]`. It removes settings persistence, statusline polling/cache, Codex Fast/request rewriting, reset redemption, and the monorepo runtime build. It loads TypeScript source directly using Pi's extension loader.

[Upstream provider contract reference at the imported snapshot](https://github.com/narumiruna/pi-extensions/blob/fa8548d258b36446b2157311adbcbca7feae2d94/packages/pi-usage/docs/providers.md)

[Upstream changelog](docs/UPSTREAM_CHANGELOG.md) is archived history, not this fork's feature contract. Current behavior is documented in `README.md` and `docs/operations.md`.
