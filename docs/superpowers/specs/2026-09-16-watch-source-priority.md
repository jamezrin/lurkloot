# Watch-source priority for Twitch and Kick

Implement #548 as a separate PR built on #541. The PR was initially stacked; it was retargeted to `develop` after #541 merged. The user authorizes autonomous design and implementation and requests that decisions be flagged at delivery.

## Policy

- Each platform owns `watchSourcePriority`: Twitch defaults to `drops`, `nopixel`, `fortnite`, `idle_watchlist`; Kick defaults to `drops`, `idle_watchlist`.
- A shared registry and `normalizeWatchSourcePriority(platform, value)` keep orders complete and duplicate-free, discard unknown/wrong-platform entries, preserve valid relative order, and append missing sources. A future source joins through the registry and the generic scheduler selection hook.
- Settings exposes numbered source rows with named native up/down buttons and a reset button in each platform section. Unavailable extension providers remain orderable and yield during selection. Orders persist through normal settings storage/export/import and CLI config.
- The configured order selects the first eligible source on each scheduler tick, including during active sessions. No extra switching delay is introduced: normal polling, existing channel-health retries and provider cooldowns bound switching. Campaign/reward progress retention remains within the Drops source; source priority can interrupt it. Idle Watchlist keeps its own channel order.
- Provider completion and failure cooldowns remain authoritative. A known-complete provider yields for up to 30 minutes (NoPixelV capped at next UTC day), then gets a bounded reprobe in its configured position. A newly eligible higher-priority provider can preempt an earning lower-priority provider. No blanket holder-first ranking may contradict user order.
- Authentication, manual-watch/manual-close pauses, exclusions and tabless-only provider restrictions remain authoritative. Source failures yield without exposing private provider errors.
- Replace the visible fallback-only toggle with source ordering. Retain its serialized field as a deprecated compatibility input; when an order is missing and that flag is false, initialize Idle Watchlist first for both platforms. Explicit source order always wins. This strengthens the old sticky-idle option to predictable Idle-first selection and is a flagged migration decision.
- CLI has the same engine setting and skips providers without an injected implementation. No new permissions or external dependency are required.

## Acceptance

Deterministic tests cover both platforms, every Twitch source first, unavailable/disabled/ungranted/cooling sources, active-session reorder and preemption, completion/reprobe/day-reset, exclusions/pauses/auth/tabless guards, normalization, restart and export/import. Browser QA covers reorder/reset, keyboard focus, search and narrow popup layout. Run `pnpm verify` and CLI build. Deliver a separate PR with validation evidence and the decisions above.
