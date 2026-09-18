# Watch-source priority

Issue [#548](https://github.com/jamezrin/lurkloot/issues/548) covers priority between watch sources. Campaign/category ranking and the order of channels inside the Idle Watchlist remain separate.

Implemented in [PR #556](https://github.com/jamezrin/lurkloot/pull/556).

Each platform has `platform[platform].watchSourcePriority`. Twitch defaults to Drops → NoPixelV → Fortnite → Idle Watchlist. Kick defaults to Drops → Idle Watchlist. Settings offers source-named up/down buttons and a per-platform reset. Disabled or ungranted providers remain orderable and yield at selection time. Saving an order requests a tick for that platform.

## Decisions made autonomously

1. **Build on #541.** This implementation depends on its supplemental watch lane. #541 was merged into `develop` before this PR was retargeted to `develop`.
2. **Priority takes effect on the next tick.** The first eligible source wins even during an active session. A newly eligible higher source can interrupt an in-progress drop or earning provider. No additional switching delay is introduced: normal polling, five-minute provider discovery caching, channel-health retries and provider cooldowns bound the checks. Within Drops, existing reward-progress retention and explicit campaign ranking still apply.
3. **Replace the fallback-only control.** Schema 6 materializes missing orders. The deprecated serialized `idleWatchlistFallbackOnly` field remains accepted for old settings/configs. A missing platform order with that field `false` becomes Idle Watchlist first. This strengthens the previous sticky-Idle behavior: Idle can now win the initial selection as well. An explicit order always wins, including an empty or malformed order that normalizes to defaults.
4. **New sources append.** Normalization discards unknown/wrong-platform IDs and duplicates, preserves valid relative order and appends missing supported sources in registry order. A future source therefore starts after all existing user preferences, including Idle if it is already last; users can promote it. Future-schema settings imports retain the existing explicit rejection.
5. **Completion reprobes use configured priority.** Known-complete providers yield for a 30-minute budget, capped at the next UTC day for NoPixelV. Once due, they compete at their configured position on the next tick. Incidental work on a lower source must not renew that budget. Failed due reprobes consume their turn; provider channel failures retry after five minutes. This preserves bounded probes without a holder-first exception that contradicts user order.

Authentication, manual-watch/manual-close pauses, campaign/category eligibility, exclusions and host capabilities remain authoritative. Automatic Drops and supplemental provider selection honor excluded channels; explicitly listed Idle channels retain the existing exception. The default subscription-only fallback restriction is preserved; putting Idle ahead of Drops makes Idle an explicit preferred source.

Supplemental targets retain the existing tabless-only contract and never fall back to a video tab. The CLI carries the same source-order setting but currently has no NoPixelV or Fortnite implementation, so those sources yield. No permissions, credential storage or dependencies are added.

## Adding a future Kick source

Add its stable ID to `WatchSourceId` and to `DEFAULT_WATCH_SOURCE_PRIORITY.kick` in `packages/shared/src/watchSources.ts`. Add its label to the exhaustive `WATCH_SOURCE_NAME_KEYS` map and locale catalogs. Inject the host's source-specific selector through `BackgroundControllerDeps.selectSupplementalWatchTarget`; it receives the requested platform and source and returns an eligible target or `undefined`. Wire the Kick host into the extension background as needed. Existing stored orders automatically append the new source without a migration solely for that addition. A mechanism that needs visible-tab watching would extend the supplemental target contract when implemented.

## Validation

Focused tests cover both platform orders, every current Twitch source, active preemption/reordering, skipped sources, incomplete-discovery eligibility, source failures, provider completion/reprobe/day reset, malformed orders, storage/export/import and CLI propagation.

After merging current `develop` into the feature branch, `pnpm verify` passed all workspace typechecks, 110 extension test files (2,273 tests), 13 CLI test files (199 tests), 95 tooling tests, site tests/build and Chromium/Firefox builds. `pnpm build:cli` also passed. Independent settings/CLI and engine reviews found no remaining material issues after regression-backed fixes, including snapshot selection preserving Drops progress when preferred Idle yields.

Compiled-popup Playwright QA uses a synthetic browser runtime with persisted settings; it exercises Twitch/Kick reorder, platform-targeted tick requests, keyboard boundary focus, reload persistence, source-name search and reset. Viewports are 400×600 and 400×500, with English and Arabic, light/dark presentation, no horizontal overflow or console/page errors. Browser plugin was unavailable, so the existing regular Playwright dependency was used. This validates policy/UI behavior rather than live provider earning, whose acceptance remains tracked in #541.

Screenshots: [Twitch settings](watch-source-priority/settings.png), [Kick settings](watch-source-priority/kick.png), [Arabic RTL in dark mode](watch-source-priority/rtl.png).
