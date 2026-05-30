# Stream Farmer — Code Review & Fix Plan

## Context

Stream Farmer is a WXT/TypeScript WebExtension that farms Twitch/Kick drops via real
pinned, muted tabs. The architecture is solid: dependency-injected background controller,
clean platform-adapter pattern, pure parsers, and 35 passing tests (typecheck clean).

This review found a small set of issues worth fixing: two genuine correctness bugs, a
missing-validation bug, a resource/UX gap (watch tabs are never closed), and a
privacy/store-policy inconsistency between the code and the documentation. Scope:
**correctness bugs + UX (tab cleanup) + privacy/docs fix**. Quality-only refactors are out
of scope for now.

The goal is to make the scheduler behave correctly on edge cases, stop leaking browser
tabs, and make the store-readiness docs accurately describe what the code does — without
changing the overall architecture.

---

## Fixes

### 1. Concurrent `fetchJsonInPage` creates duplicate tabs (correctness)

`src/core/tabs.ts` — `fetchJsonInPageWithBrowser` (lines 66–104).

When no platform tab exists yet, parallel callers each run `tabs.query` → `tabs.create`
and all create their own pinned tab. This fires on the very first tick:
`TwitchAdapter.discoverCampaigns` (`src/platforms/twitch.ts:106`) runs `Promise.all` of
the inventory + dashboard GQL calls, then another `Promise.all` over campaign details —
each call independently opens a fresh `https://www.twitch.tv/...` tab on a cold browser.

**Fix:** serialize the "find-or-create tab for origin" step so concurrent callers share one
in-flight creation. Add a module-level `Map<string /* origin */, Promise<number /* tabId */>>`
keyed by `new URL(originUrl).origin`. The first caller for an origin populates the map with
the find-or-create promise; concurrent callers await the same promise. Clear the entry once
resolved (and on rejection) so a later stale tab can still be recreated. Keep the existing
reuse-an-open-tab logic inside that single guarded path.

### 2. `offlineChecks` not reset when switching to a new channel (correctness)

`src/core/scheduler.ts` — `runSchedulerTick` (line 225) sets
`session.offlineChecks = shouldKeep.offlineChecks` unconditionally. When
`shouldKeepWatching` returns `keep:false` because the offline-retry limit was hit (lines
337–339), it returns the *incremented* count (e.g. 3). The scheduler then watches a
**different** channel chosen by `chooseCampaignDecision`, but assigns it that stale
at-limit count — so the fresh channel is abandoned after a single offline check next tick.

**Fix:** reset the counter when the watched channel changes:
`session.offlineChecks = shouldKeep.keep ? shouldKeep.offlineChecks : 0;`
Add a scheduler test asserting that after an offline-limit switch the new session's
`offlineChecks === 0` (extend the existing "switches after offline retry threshold" test in
`tests/scheduler.test.ts:167`).

### 3. `pollIntervalMinutes` not validated/clamped (correctness)

Older removed settings UI code used `Number(event.target.value)`, which yielded `0` or
`NaN` when the field was cleared. That value flowed through `mergeSettings`
(`src/core/settings.ts`) into `browser.alarms.create({ periodInMinutes })`
(`src/background/controller.ts:21,121,128`). `periodInMinutes < 1` / `NaN` is clamped or
rejected by the browser and can silently disable polling.

**Fix:** clamp in `mergeSettings` so persisted/loaded settings are always valid — e.g.
`pollIntervalMinutes: clampInterval(value?.pollIntervalMinutes)` where `clampInterval`
returns `DEFAULT_SETTINGS.pollIntervalMinutes` for non-finite input and otherwise
`Math.min(60, Math.max(1, Math.round(n)))`. This centralizes the guard (covers both the
popup UI and any malformed stored data). Add a `settings` unit test for NaN/0/over-max.

### 4. Watch tabs are never closed on stop/pause/idle (UX / resource leak)

When automation is stopped, a platform is disabled, or a session goes idle, the scheduler
sets the session status to `paused`/`idle` (`src/core/scheduler.ts:186`, `sessionForDecision`
at line 136) but the pinned muted tab stays open forever. There is no close path in
`src/core/tabs.ts`.

**Fix:**
- Add `closePinnedTab(tabId)` / `closePinnedTabWithBrowser(browserApi, tabId)` to
  `src/core/tabs.ts`, mirroring the existing `openPinnedMutedTab*` split (swallow errors for
  already-closed tabs, same as the stale-tab handling at lines 38–40).
- Add an optional `closeWatchTab?(tabId: number): Promise<void>` to `PlatformAdapter`
  (`src/platforms/adapter.ts`) implemented by both adapters via the new helper.
- In `runSchedulerTick`, when a platform transitions to `paused` (disabled/not running,
  line 185) or the decision is `idle` (line 222), close `previous.tabId` if present and clear
  `tabId` on the stored session. Keep it best-effort (wrap in try/catch, emit a `warn` event
  on failure) so cleanup never breaks a tick.
- Add a scheduler test: a session that was `watching` with a `tabId` and then becomes
  paused/idle calls `closeWatchTab` and clears `tabId`.

### 5. Kick credential handling vs. store-readiness claims (privacy / docs)

`src/core/tabs.ts:106–116` (`pageFetchJson`) reads the `session_token` cookie and forwards
it as an `Authorization: Bearer` header for `web.kick.com`. This is required by the Kick web
API, so **the code stays as-is**. But `README.md:3` and `docs/store-readiness.md:6` state the
extension "avoids credential handling" and "does not import, export, request, or store
credentials or cookies" — which is inaccurate.

**Fix (docs only):** update both files to describe the actual behavior accurately:
- It reads the Kick `session_token` **cookie within the page's own origin** solely to
  authorize same-session API calls to `web.kick.com`; the token is never stored, logged,
  exported, or sent anywhere except Kick's own API.
- Keep the accurate claims (no cookie or credential export UI, no credential storage, no
  streamless simulation, no anti-detection). Reword the absolute "does not handle cookies"
  line into "reuses the existing logged-in session (including the same-origin session cookie
  for Kick's API) and never stores or exports credentials."

---

## Out of scope (noted, not changing now)

- Dead branch in `activeReward` (`scheduler.ts:18`): `earnable` already excludes `claimable`,
  so the `?? find(claimable)` fallback can never match. Harmless (auto-claim handles
  claimables) but confusing.
- Duplicated event-append logic: `appendEvent` (`storage.ts:57`) and `addTickEvent`
  (`scheduler.ts:349`) both generate ids and `slice(0, 100)`; could be one helper.
- `scripting.executeScript` result (`tabs.ts:88–93`) isn't guarded against an empty result
  array.

---

## Verification

1. `pnpm test` — all existing 35 tests plus the new tests (offlineChecks reset, interval
   clamp, tab-close on pause/idle) pass.
2. `pnpm typecheck` — clean (new adapter method + helpers typed).
3. `pnpm build && pnpm build:firefox` — both targets build (i.e. `pnpm verify`).
4. Manual, with real logged-in sessions (cannot be unit-tested — private platform APIs):
   - Cold-start a tick and confirm only **one** Twitch tab is created (fix #1), not several.
   - Start farming, then Stop / disable a platform, and confirm the pinned watch tab is
     **closed** (fix #4).
   - Toggle popup settings and confirm normalized persisted settings keep polling valid
     (fix #3).
   - Enable both platforms from the popup and confirm Kick campaign discovery still works
     (confirms the documented cookie behavior in fix #5 is intact).
