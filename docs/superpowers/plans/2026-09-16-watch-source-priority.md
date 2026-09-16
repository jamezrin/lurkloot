# Watch-Source Priority Implementation Plan

**Goal:** Implement per-platform watch-source priority for #548, including future Kick mechanisms.

**Architecture:** Shared source registry and normalized per-platform settings drive the browser-free scheduler. A source-specific supplemental selector lets hosts yield unavailable sources independently. Popup and CLI share the setting.

**Tech Stack:** TypeScript, pnpm, WXT, React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-watch-source-priority.md`.

## Global constraints

Work in `.worktrees/watch-source-priority` on `feat/watch-source-priority`. PR base is `feat/twitch-extension-foundation` (#541). Preserve within-source ranking, engine/browser boundary and security guards. Diagnostics remain English literals. No new permissions/dependencies. User explicitly requests no questions and delegates decisions.

## Task 1: Shared settings, popup and CLI

Files: `packages/shared/src/{models,settings,settingsSchema,watchSources}.ts`, shared exports; `packages/popup-ui/src/{settingsRegistry,watchSourcePriority,tips}.tsx`, locales; CLI settings/config/docs; focused settings/UI/CLI tests.

Interface: `WatchSourceId = "drops" | "nopixel" | "fortnite" | "idle_watchlist"`; `PlatformSettings.watchSourcePriority: WatchSourceId[]`; `DEFAULT_WATCH_SOURCE_PRIORITY: Record<Platform, readonly WatchSourceId[]>`; `normalizeWatchSourcePriority(platform: Platform, value: unknown): WatchSourceId[]`, exported from `@lurkloot/shared/watchSources`.

- [x] Write failing normalization, persistence, legacy migration and reorder/reset UI tests; run the focused tests to confirm failure.
- [x] Implement the shared registry and normalize missing/invalid orders. Explicit order overrides legacy flag; false legacy flag initializes Idle first when no order exists. Version migration where required.
- [x] Add the platform UI rows, native named buttons, reset and locale copy; remove the obsolete visible toggle and correct tips. Save with `tickAfterSave: true`.
- [x] Support orders in CLI normalization/generated config and document unsupported providers yielding.
- [x] Run focused settings/UI/CLI tests and typecheck; report exact evidence.

## Task 2: Scheduler and provider selection

Files: core scheduler/controller, extension background and host; scheduler/supplemental/provider-host tests.

Interface: append optional `source?: WatchSourceId` to the supplemental selector callback arguments. Scheduler calls it once for each supplemental source in configured order and validates returned id matches the requested source. The host filters to that provider and applies completion/failure cooldowns before discovery.

- [x] Write failing tests for Idle-first on both platforms, providers ahead of drops, active reorder, unavailable source yielding and source-specific callback routing.
- [x] Split Drops and Idle selection while preserving ordinary within-source selection/retention and snapshot compatibility.
- [x] Select supplemental sources in configured order around the ordinary decision; higher-priority sources override a retained ordinary session. Carry correct retention into tabless sessions.
- [x] Replace holder-first provider ranking with configured ranking, retain current channel within each provider, and enforce bounded completion reprobes.
- [x] Run focused scheduler/controller/host tests and resolve regressions.

## Task 3: Integration, review and PR

- [x] Review full diff against spec with independent settings/CLI and engine reviewers; address material findings.
- [x] Run `pnpm verify` and `pnpm build:cli`.
- [x] Use Playwright (Browser plugin absent) for compiled popup reorder/reset/search and keyboard checks at popup/narrow viewports; capture screenshots outside temporary code, publish useful PR evidence.
- [x] Update implementation decisions and validation documentation.
- [x] Commit Conventionally, push, and open a separate PR with dependency on #541 and link #548. Replan the issue.

Delivered as [PR #556](https://github.com/jamezrin/lurkloot/pull/556), targeting #541's branch. [Issue #548](https://github.com/jamezrin/lurkloot/issues/548) now records the Twitch/Kick scope and resolved decisions. GitHub validation and build results are tracked on the PR; inspect them and address task-related failures before handoff.

Final local evidence: `pnpm verify` passed all workspace typechecks, 2,260 extension tests, 199 CLI tests, tooling/site tests and both browser builds. CLI build and release-version check passed. Compiled-popup reorder/persistence/reset/search/focus, Arabic RTL, dark mode and overflow/error checks passed. Four material engine review findings were reproduced and fixed with regression coverage; final independent reviews have no remaining material findings. Screenshots and autonomous decisions are in `docs/watch-source-priority.md`.
