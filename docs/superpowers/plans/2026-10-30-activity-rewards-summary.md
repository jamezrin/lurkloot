# Activity Rewards Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Activity into a per-farming-session summary of every reward obtained (drops, Twitch points per channel, Kick cards, Twitch Extension rewards), with status collapsed and tab open/close moved to Diagnostics.

**Architecture:** The engine owns session identity (`SchedulerState.farmingSessions`) and stamps `sessionId` on every activity event at its single report choke point (`reportBestEffort`). Listed rewards stay rows in the events store; tallied Twitch points never become rows and are folded into a per-session summary record by a pure reducer in `@lurkloot/shared`, applied by the extension's IndexedDB repository inside one transaction. The popup groups rows by session and renders rewards through a kind-keyed view-model registry with a generic fallback.

**Tech Stack:** TypeScript (strict, ESM), React popup (`@lurkloot/popup-ui`), WXT extension, IndexedDB (`fake-indexeddb` in tests), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-activity-rewards-summary-design.md`

## Global Constraints

- `@lurkloot/core` stays browser-free; `packages/extension/tests/coreBoundary.test.ts` must keep passing.
- Diagnostics are English literals; no `diagnostic*` locale keys. Activity text is localized in popup-ui only.
- Image URLs stored on events are https only (`safeHttpsUrl`); anything else is dropped.
- Activity retention stays 30 days; Diagnostics 7 days; `MAX_RECORDS_PER_CATEGORY = 2_000`.
- No new browser permissions. If an image host turns out to be blocked, say so in the PR; do not add a permission.
- Session state has exactly two writers: the settings-commit reconcile and the startup reconcile.
- "Enabled" is `settings.platform[p].enabled`; there is no global switch.
- Points count everything on the account (maintainer decision). Listed rewards with no open session get `sessionId: null` and render in an "Outside a session" block per local day; rows with no `sessionId` key (pre-change) render in "Earlier".
- Locale bodies are translated by inexpensive subagents (Haiku), one per locale; preserve `$1` placeholders, brand names, and "farm".
- Every phase ends with `pnpm typecheck && pnpm test` green and a Conventional Commit.
- Do not assert on `.github/workflows` contents in tests.

## Review Focus

1. A stored row with a code this build no longer renders (or a `page_context_*` row) must render nothing rather than crash or print `[object Object]` — test in Task 1.
2. Points arriving while Twitch is disabled, or after the session closed, must not be folded into any session — test in Task 8 (fold) and Task 7 (owner not subscribed without an open session).
3. Two `append` calls racing on the same session (tick batch and push batch) must both be counted — test in Task 9.
4. Disabling and re-enabling a platform within one minute must produce two distinct sessions, and events emitted just before the disable (reported after it) must land in the closed session, not "Outside" — test in Task 6.
5. A Twitch `points-earned` for a channel the engine has never seen and `resolveChannels` failing must still be counted under the channel id — test in Task 7.

---

## Phase 1 — Event contracts and legacy safety

### Task 1: Shared reward and session contracts

**Files:**
- Create: `packages/shared/src/rewards.ts`
- Create: `packages/shared/src/farmingSessions.ts`
- Modify: `packages/shared/src/events.ts`, `packages/shared/src/models.ts` (SchedulerState), `packages/shared/package.json` (exports, following the existing subpath pattern)
- Modify (exhaustive switches only): `packages/core/src/core/activityDiagnostics.ts`, `packages/cli/src/events.ts`, `packages/popup-ui/src/activity.logic.ts`
- Test: `packages/extension/tests/rewardContracts.test.ts`, extend `packages/extension/tests/activityView.test.ts`, `packages/extension/tests/activityDiagnostics.test.ts`

**Interfaces:**
- Produces (`@lurkloot/shared/rewards`):
  - `type ListedRewardKind = "challenge_card" | "extension_capture" | "extension_pack" | "extension_giveaway"`
  - `type TalliedKind = "channel_points"`
  - `type RewardCountKey = "drop" | ListedRewardKind`
  - `interface RewardSource { platform: Platform; extension?: TwitchExtensionProviderId }`
  - `interface RewardDetail { key: string; value: string | number }`
  - `interface RewardObtainedData { kind: ListedRewardKind; source: RewardSource; name?: string; imageUrl?: string; amount?: number; rarity?: string; channel?: string; itemId?: string; details?: RewardDetail[] }`
  - `interface PointsEarnedData { channelId: string; channelLogin?: string; channelDisplayName?: string; channelImageUrl?: string; reason: string; amount: number }`
  - `function safeHttpsUrl(value: unknown): string | undefined`
- Produces (`@lurkloot/shared/events`), added to the `ActivityEvent` union, all `category: "activity"`:
  - `reward_obtained` — `level: "info"; platform: Platform; data: RewardObtainedData`
  - `points_earned` — `level: "info"; platform: Platform; data: PointsEarnedData`
  - `session_started` — `level: "info"; platform: Platform; data: { sessionId: string; startedAt: string }`
  - `session_ended` — `level: "info"; platform: Platform; data: { sessionId: string; startedAt: string; endedAt: string; reason: "disabled" }`
  - `CampaignRewardData` gains `gameName?: string; gameImageUrl?: string`; `reward_claimed.data` gains `channel?: string`.
  - Rename the existing union to `ActivityEventBody` and export `type ActivityEvent = ActivityEventBody & { sessionId?: string | null }`.
- Produces (`@lurkloot/shared/farmingSessions`):
  - `interface TallyEntry { kind: TalliedKind; subject: { id: string; login?: string; name?: string; imageUrl?: string }; total: number; breakdown: Record<string, { count: number; amount: number }> }`
  - `interface FarmingSessionSummary { id: string; platform: Platform; startedAt: string; endedAt?: string; tallies: Record<string, TallyEntry>; rewardCounts: Partial<Record<RewardCountKey, number>> }`
  - `function isActivityTimelineEvent(event: { category: string; code?: string }): boolean` — false for `page_context_opened`/`page_context_closed` and diagnostics.
  - `function rewardCountKey(event: ActivityEvent): RewardCountKey | undefined` — `reward_claimed` → `"drop"`, `reward_obtained` → its `kind`, else undefined.
  - `function tallyKey(event: ActivityEvent): string | undefined` — `points_earned` → `` `channel_points:${channelId}` ``, else undefined.
  - (`foldSessionEvent` is added in Task 8.)
- Produces (`models.ts`): `SchedulerState.farmingSessions?: Partial<Record<Platform, { id: string; startedAt: string }>>`

- [ ] **Step 1: Write the failing tests**

`rewardContracts.test.ts`:
```ts
expect(safeHttpsUrl("https://files.kick.com/a.png")).toBe("https://files.kick.com/a.png");
expect(safeHttpsUrl("http://x/a.png")).toBeUndefined();
expect(safeHttpsUrl("javascript:alert(1)")).toBeUndefined();
expect(safeHttpsUrl(42)).toBeUndefined();
expect(isActivityTimelineEvent({ category: "activity", code: "page_context_opened" })).toBe(false);
expect(isActivityTimelineEvent({ category: "activity", code: "page_context_closed" })).toBe(false);
expect(isActivityTimelineEvent({ category: "activity", code: "reward_claimed" })).toBe(true);
expect(tallyKey(pointsEvent({ channelId: "123" }))).toBe("channel_points:123");
expect(rewardCountKey(dropClaimedEvent())).toBe("drop");
expect(rewardCountKey(rewardObtainedEvent({ kind: "challenge_card" }))).toBe("challenge_card");
```
`activityView.test.ts` — new cases:
```ts
it("renders nothing for a stored row whose code this build does not know", ...)
// record: { id, at, category: "activity", code: "invented_code", level: "info", platform: "twitch", data: {} }
expect(formatActivityEvent(record as never, t)).toBe("");
expect(buildActivityCard(record as never, t)).toBeUndefined();
```
`activityDiagnostics.test.ts`: `withActivityDiagnostics` forwards a `points_earned` event but emits **no** diagnostic mirror for it; still mirrors `reward_obtained`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/rewardContracts.test.ts tests/activityView.test.ts tests/activityDiagnostics.test.ts`
Expected: FAIL (modules/exports missing).

- [ ] **Step 3: Implement the contracts**

- Add the types and functions above.
- In `formatCurrentActivity` and `buildActivityCard`, replace `default: { const exhaustive: never = event; return exhaustive; }` with a guard that keeps the compile-time exhaustiveness check but returns `""` / `undefined` at runtime.
- Add cases for the four new codes. Popup: return `""` / `undefined` for now (Task 10 adds real text and layouts; no new locale keys in this task). CLI: `reward_obtained` → `` `Obtained ${kind}${name ? ` ${name}` : ""}${channel ? ` on ${channel}` : ""}` ``; `points_earned` → `` `+${amount} points (${reason}) on ${channelLogin ?? channelId}` ``; `session_started`/`session_ended` → `` `${platform} farming session started` `` / `ended`.
- In `withActivityDiagnostics`, skip the mirror when `tallyKey(event) !== undefined`. `activityDiagnostic` still gets cases for every new code (flatten `source`/`details` into the flat `data` record: `sourcePlatform`, `sourceExtension`, `detail_<key>`).
- In `cli/src/events.ts`, print `points_earned` only at debug level (follow how the CLI chooses levels for events).

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm typecheck && pnpm --filter @lurkloot/extension exec vitest run tests/rewardContracts.test.ts tests/activityView.test.ts tests/activityDiagnostics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(shared): add reward, points and farming session event contracts"`

### Task 2: Enrich drop events with game and channel

**Files:**
- Modify: `packages/core/src/core/rewardClaims.ts:~100-112`, `packages/core/src/background/claimService.ts` (three `reward_claimed` emits near 493, 568, 652), `packages/core/src/core/scheduler.ts` (`reward_claimed` emit near 1812), `packages/core/src/background/helpers.ts:~100-130` (`farming_started`/`farming_stopped`)
- Test: extend `packages/extension/tests/backgroundController/claims.test.ts` and `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 `CampaignRewardData.gameName/gameImageUrl`, `reward_claimed.data.channel`.
- Produces: `reward_claimed`, `farming_started`, `farming_stopped` carry `gameName`/`gameImageUrl` from `DropCampaign` when present (image through `safeHttpsUrl`), and `reward_claimed.channel` when the claim happened while watching a known channel.

- [ ] **Step 1: Failing tests** — an automatic claim of a reward in a campaign with `gameName: "Rust"`, `gameImageUrl: "https://static-cdn.jtvnw.net/ttv-boxart/rust.jpg"` emits `reward_claimed` whose data has both fields; a campaign with `gameImageUrl: "http://insecure"` emits no `gameImageUrl`; `farming_started` carries `gameName`.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController/claims.test.ts tests/scheduler.test.ts` — FAIL.
- [ ] **Step 3: Implement** — spread the optional fields at every emit site; the intermediate `events.push({...})` record in `rewardClaims.ts` carries them through to `scheduler.ts`/`claimService.ts`.
- [ ] **Step 4: Run** the same command — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(core): carry game name, box art and channel on drop events`

### Task 3: Kick daily card as `reward_obtained`

**Files:**
- Modify: `packages/core/src/platforms/adapter.ts:74-78` (`ClaimedChallenge`), `packages/core/src/platforms/kick/index.ts` (`KickChallengeClaimResponse`, `claimChallenges`), `packages/core/src/core/scheduler.ts` (~1631 emit), `packages/core/src/background/kickRuntime.ts` (~243 emit), `packages/core/src/background/reporting.ts:~485` (notification), `packages/core/src/background/tickRun.ts:~587` (fact filter)
- Test: extend `packages/extension/tests/adapters.test.ts` (Kick challenge cases near 1249), `packages/extension/tests/backgroundController/kickChallenges.test.ts`, `packages/extension/tests/backgroundController/claims.test.ts`

**Interfaces:**
- Produces: `ClaimedChallenge` gains `imageUrl?: string; consolation?: { watchTimeMinutes?: number; badgeImageUrl?: string }`.
- Produces: both emitters send `reward_obtained` with `data: { kind: "challenge_card", source: { platform: "kick" }, rarity, imageUrl?, itemId: winner id when present, details: [{ key: "recurrence", value }, { key: "consolationMinutes", value }?] }`. `challenge_claimed` is no longer emitted.
- The claim notification fires for `reward_obtained` with `kind === "challenge_card"` (same copy keys, `rarity` and the `recurrence` detail).
- `tickRun.ts` keeps `reward_obtained` events in the rollback fact filter, alongside `reward_claimed`.

- [ ] **Step 1: Failing tests**
  - adapter: claim response `{ data: { challenge_id: "done", winner: { id: "card", rarity: "legendary", card_url: "https://files.kick.com/cards/x.png" }, consolation: { watch_time_minutes: 30, next_level_badge: { image_url: "https://files.kick.com/b.png" } } } }` → `{ id: "done", rarity: "legendary", recurrence: "daily", imageUrl: "https://files.kick.com/cards/x.png", consolation: { watchTimeMinutes: 30, badgeImageUrl: "https://files.kick.com/b.png" } }`; `card_url: "http://..."` → no `imageUrl`.
  - controller: a claimed challenge produces exactly one `reward_obtained` with `kind: "challenge_card"`, and zero `challenge_claimed` events; the notification is still sent once.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/adapters.test.ts tests/backgroundController/kickChallenges.test.ts tests/backgroundController/claims.test.ts` — FAIL.
- [ ] **Step 3: Implement** as described; update the existing tests that asserted `challenge_claimed` to the new shape.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(kick): report the daily-challenge card art and consolation`

### Task 4: Twitch Extension rewards as `reward_obtained`

**Files:**
- Modify: `packages/extension/src/extensions/nopixel/driver.ts` (pack open, giveaway join callbacks), `packages/extension/src/extensions/fortnite/driver.ts` (`onCaptured`), `packages/extension/entrypoints/background.ts:~344-410` (`publishDriverAction`, host `publish`)
- Test: extend `packages/extension/tests/nopixelProvider.test.ts`, `packages/extension/tests/fortniteDriver.test.ts`; new `packages/extension/tests/driverRewards.test.ts` for the event builder

**Interfaces:**
- Produces: NoPixel `options.onOpened?(pack: { cardCount: number; editions: Partial<Record<"normal" | "legendary" | "gold", number>> })`, recorded from the open response's cards when the open is accepted and reported when removal is confirmed. `onJoined()` unchanged.
- Produces: Fortnite `onCaptured?(capture: { collectableId: string })`. No name/image (vendor fields unverified — see spec "Verify live").
- Produces in `background.ts`: `function driverRewardEvent(provider, channel, reward): ActivityEvent` (export it from a small module `packages/extension/src/extensions/rewardEvents.ts` so it can be unit-tested) building `reward_obtained` with `source: { platform: "twitch", extension: provider }`, `channel`, and kind:
  - NoPixel pack → `extension_pack`, `amount: cardCount`, `details: [{ key: "edition_<edition>", value: n }]`
  - NoPixel giveaway → `extension_giveaway`
  - Fortnite capture → `extension_capture`, `itemId: collectableId`
  - Fortnite takeover is not a reward: it emits an English diagnostic through the host's existing `diagnostic` hook and no activity event.
- The host `publish` sends events through `controller.reportEvents(events)` instead of `reportEvents(events)`, so they pass the engine's report choke point. `twitch_extension_action` is no longer emitted.

- [ ] **Step 1: Failing tests** — NoPixel: opening a pack whose response is `[{card_id:1,edition:"normal"},{card_id:2,edition:"gold"},{card_id:3,edition:"normal"}]` calls `onOpened` once with `{ cardCount: 3, editions: { normal: 2, gold: 1 } }`; Fortnite: a confirmed capture calls `onCaptured` with `{ collectableId: "sprite" }`; `driverRewardEvent("nopixel", "streamer", { type: "pack", ... })` returns the expected `reward_obtained` shape.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/nopixelProvider.test.ts tests/fortniteDriver.test.ts tests/driverRewards.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(extensions): report pack, giveaway and capture rewards`

### Task 5: Keep tab open/close out of Activity

**Files:**
- Modify: `packages/extension/src/core/activityMessages.ts` (`createActivityEventReporter`), `packages/popup-ui/src/activity.tsx` (`forPlatform` filter)
- Test: extend `packages/extension/tests/activityMessages.test.ts`, `packages/extension/tests/activityLogView.test.tsx`

**Interfaces:**
- Consumes: `isActivityTimelineEvent` (Task 1).
- Produces: the reporter drops activity events failing `isActivityTimelineEvent` before `append` (their diagnostic mirrors pass through when diagnostic logging is on). The popup's Activity list filters stored legacy rows with the same predicate.

- [ ] **Step 1: Failing tests** — reporter given `[page_context_opened activity, its diagnostic mirror, reward_claimed]` with diagnostics on appends only the mirror and `reward_claimed`; with diagnostics off appends only `reward_claimed`. Popup: a stored legacy `page_context_opened` row is not rendered in Activity and does not throw. Existing churn test in the scheduler/tickRun suite still passes (no change to `tickRun.ts:~664`).
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/activityMessages.test.ts tests/activityLogView.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, then `pnpm test` — PASS.
- [ ] **Step 5: Commit** `feat(activity): move tab open and close events to diagnostics`

## Phase 2 — Sessions, points and storage

### Task 6: Farming session identity and stamping

**Files:**
- Create: `packages/core/src/background/farmingSessions.ts`
- Modify: `packages/core/src/background/controller.ts` (compose), `packages/core/src/background/settingsTransitions.ts` (`commitSettings` finally, after `rescheduleSettingsJobs`), `packages/core/src/background/lifecycle.ts` (`reconcileStartup`, after `normalizeStartupSettings`), `packages/core/src/background/reporting.ts` (`reportBestEffort`)
- Test: `packages/extension/tests/backgroundController/farmingSessions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FarmingSessionsService {
    // Opens a session for each enabled platform without one and closes the
    // session of each disabled platform. The only writer of state.farmingSessions
    // besides startup. Emits session_started / session_ended through reportBestEffort.
    reconcile(): Promise<void>;
    // Sets sessionId on activity events that carry a platform: the open session's
    // id when emittedAt >= its startedAt, else the last closed session's id for that
    // platform when emittedAt falls inside it, else null. Events without a platform
    // and session_* events keep what they have.
    stamp(events: readonly EngineEvent[]): EngineEvent[];
  }
  export function createFarmingSessions(deps: {
    loadSettings(): Promise<EngineSettings>;
    withStateLock<T>(run: () => Promise<T>): Promise<T>;
    loadState(): Promise<SchedulerState>;
    saveState(state: SchedulerState): Promise<void>; // use the controller's existing persist helper
    report(events: readonly EngineEvent[]): Promise<void>;
    now(): Date;
    newId(): string; // crypto.randomUUID in production
  }): FarmingSessionsService;
  ```
- The service keeps the last closed session per platform in memory (`{ id, startedAt, endedAt }`), hydrated on first `reconcile`.
- `reportBestEffort` calls `farmingSessions.stamp(events)` before `ports.events.report`. Session events are emitted with their own top-level `sessionId` equal to `data.sessionId`.

- [ ] **Step 1: Failing tests**
  - enabling Twitch opens a session: `state.farmingSessions.twitch` set, one `session_started` reported with that id.
  - a `reward_claimed` reported while open carries `sessionId` equal to it; a Kick event while Kick is disabled carries `sessionId: null`; an `interruption` with no platform has no `sessionId` key.
  - disable then enable within 60 s yields two different ids, one `session_ended` (reason `"disabled"`) between them.
  - an event with `emittedAt` before the disable but reported after it carries the closed session's id (Review Focus 4).
  - startup with Twitch enabled and no open session opens one; startup with one already open keeps its id (survives restart).
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController/farmingSessions.test.ts` — FAIL.
- [ ] **Step 3: Implement** using the state-lock commit pattern `kickRuntime.ts` uses (load latest under the lock, spread, persist).
- [ ] **Step 4: Run** — PASS, then `pnpm test` — PASS.
- [ ] **Step 5: Commit** `feat(core): give each farming session an id and stamp it on activity`

### Task 7: Twitch points owner and channel resolution

**Files:**
- Modify: `packages/core/src/platforms/twitch/channelPointsPush.ts` (owners, `wantsPointsTopic`, `handleNotification`), `packages/core/src/platforms/adapter.ts`, `packages/core/src/platforms/twitch/index.ts` (`resolveChannels`), `packages/shared/src/models.ts` (`ChannelIdentity`), `packages/core/src/background/channelPoints.ts` (`reconcileTwitchChannelPointsPush`)
- Test: extend `packages/extension/tests/twitchChannelPointsPush.test.ts`; new `packages/extension/tests/backgroundController/channelPointsTally.test.ts`; extend `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Produces in `channelPointsPush.ts`:
  - `interface TwitchPointsEarnedNotice { userId: string; channelId: string; reason: string; amount: number; at: number }` — from `points-earned` (`data.point_gain.total_points`, `reason_code`, `channel_id`).
  - `TwitchHermesOwners.onPointsEarned?(notice: TwitchPointsEarnedNotice): void`; `wantsPointsTopic()` also true when it is set.
  - In `handleNotification`, call `onPointsEarned` **before** the `WATCH_STREAK` early return, so streak payouts are both tallied and still reach `onWatchStreakEarned`.
- Produces in shared: `interface ChannelIdentity { login: string; displayName?: string; imageUrl?: string }`.
- Produces on `PlatformAdapter`: `resolveChannels?(ids: string[], options?: AdapterOperationOptions): Promise<Record<string, ChannelIdentity>>`. Twitch implementation: one GQL request `users(ids: $ids) { id login displayName profileImageURL(width: 70) }`, at most 100 ids, `imageUrl` through `safeHttpsUrl`. Note in code that this query is unverified against the live schema (CLAUDE.md "Manually Reproducing Platform GQL Requests").
- In `channelPoints.ts`: pass `onPointsEarned` whenever `state.farmingSessions?.twitch` is set (independent of auto-claim). The handler resolves identity from channels already in state (candidates/watch target carry `channelId`), else a per-run in-memory cache filled by `resolveChannels`; then emits `points_earned` through a `withEventCollector` + `reportBestEffort`. Resolution failure emits the event without login (Review Focus 5).

- [ ] **Step 1: Failing tests**
  - push: a `points-earned` with `reason_code: "WATCH_STREAK"`, `total_points: 450`, `channel_id: "77"` calls both `onPointsEarned({ channelId: "77", reason: "WATCH_STREAK", amount: 450, ... })` and `onWatchStreakEarned`; with only `onPointsEarned` set, the topic is subscribed.
  - controller: with Twitch enabled and auto-claim off, a points notice produces one `points_earned` event with the session's id; with Twitch disabled the points owner is not passed (topic not subscribed for points).
  - unknown channel + `resolveChannels` rejecting → event emitted with `channelId: "77"` and no `channelLogin`; `resolveChannels` called once for two notices on the same channel (cache).
  - adapter: `resolveChannels(["77"])` maps a GQL `users` response to `{ "77": { login: "shroud", displayName: "shroud", imageUrl: "https://static-cdn.jtvnw.net/x.png" } }`.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/twitchChannelPointsPush.test.ts tests/backgroundController/channelPointsTally.test.ts tests/adapters.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, then `pnpm test` — PASS.
- [ ] **Step 5: Commit** `feat(twitch): tally channel points earned during a farming session`

### Task 8: Session fold reducer

**Files:**
- Modify: `packages/shared/src/farmingSessions.ts`
- Test: `packages/extension/tests/farmingSessionsFold.test.ts`

**Interfaces:**
- Produces: `function foldSessionEvent(summary: FarmingSessionSummary | undefined, event: StoredEngineEvent): FarmingSessionSummary | undefined` — pure, never mutates its input.
  - `session_started` → create `{ id, platform, startedAt, tallies: {}, rewardCounts: {} }` or keep the existing one.
  - `session_ended` → set `endedAt`.
  - event with `tallyKey` and a string `sessionId` → add `amount` to `total` and to `breakdown[reason]` (`count + 1`, `amount + n`); update `subject.login/name/imageUrl` when the event carries them.
  - event with `rewardCountKey` and a string `sessionId` → increment that counter.
  - any event whose `sessionId` is not a string → return `summary` unchanged.
  - no summary yet but string `sessionId` → create one with `startedAt = event.at`.

- [ ] **Step 1: Failing tests** — fold of `[session_started, points(WATCH 50, ch 1), points(CLAIM 50, ch 1), points(WATCH_STREAK 450, ch 1), reward_claimed, session_ended]` gives `tallies["channel_points:1"].total === 550`, `breakdown.CLAIM` `{ count: 1, amount: 50 }`, `rewardCounts.drop === 1`, `endedAt` set; a `points_earned` with `sessionId: null` leaves the summary unchanged; input object is not mutated (`Object.freeze` it).
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/farmingSessionsFold.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(shared): fold farming session events into a summary`

### Task 9: Sessions store and query

**Files:**
- Modify: `packages/extension/src/core/activityStorage.ts` (DB version 3, `sessions` store keyed by `id` with index `platform_startedAt` on `["platform", "startedAt"]`), `packages/extension/src/core/activityMessages.ts`, `packages/shared/src/messages.ts`, `packages/extension/entrypoints/background.ts` (wire handler)
- Test: extend `packages/extension/tests/activityStorage.test.ts`, `packages/extension/tests/activityMessages.test.ts`

**Interfaces:**
- Consumes: `foldSessionEvent`, `tallyKey`, `rewardCountKey` (Tasks 1, 8).
- Produces:
  - `ActivityRepository.append` opens one readwrite transaction over `events` and `sessions`; for each event: if it has a string `sessionId`, read-fold-put its session record; append it to `events` unless `tallyKey(event)` is defined.
  - `ActivityRepository.loadSessions(platform: Platform): Promise<FarmingSessionSummary[]>` — sessions for the platform whose `endedAt` is absent or within 30 days, newest `startedAt` first, at most 200.
  - `prune()` deletes sessions whose `endedAt` is older than 30 days; never an open one. `clear()` and `deleteDatabase()` cover the store.
  - Message: `{ type: "getActivitySessions"; platform: Platform }` → `{ sessions: FarmingSessionSummary[] }` (`ActivitySessionsPage` in `messages.ts`), routed with the other activity messages in `createRuntimeMessageDispatcher`.

- [ ] **Step 1: Failing tests** (fake-indexeddb)
  - appending 30 `points_earned` events for one session stores **zero** rows in `events` (`count("activity") === 0` aside from the session events) and one session with `total` equal to the sum.
  - two concurrent `append` calls (`Promise.all`) each with one points event for the same session fold to both amounts (Review Focus 3).
  - a v2 database with existing rows upgrades to v3 and keeps its rows.
  - prune removes a session ended 31 days ago, keeps one ended 29 days ago and the open one.
  - `getActivitySessions` returns only the requested platform's sessions.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/activityStorage.test.ts tests/activityMessages.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, then `pnpm test` — PASS.
- [ ] **Step 5: Commit** `feat(activity): store farming session summaries`

## Phase 3 — Popup

### Task 10: Session timeline and reward views

**Files:**
- Create: `packages/popup-ui/src/activityRewards.ts` (reward view-model registry), `packages/popup-ui/src/activitySessions.tsx` (session block, points rows, reward rows)
- Modify: `packages/popup-ui/src/activity.logic.ts` (timeline builder), `packages/popup-ui/src/activity.tsx` (render timeline when not in Diagnostics), `packages/popup-ui/src/Popup.tsx` (load `getActivitySessions` alongside the activity stream; refresh on the same triggers), `packages/popup-ui/src/demo.ts` (answer `getActivitySessions`; tour data with one open session, one past session, one Outside block), `packages/popup-ui/src/marketing.tsx` (same data for screenshots; no rating claims)
- Test: extend `packages/extension/tests/activityView.test.ts` (logic), `packages/extension/tests/activityLogView.test.tsx` (rendering)

**Interfaces:**
- Produces in `activityRewards.ts`:
  ```ts
  type RewardLayout = "drop" | "card" | "pack" | "item" | "generic";
  interface RewardView {
    layout: RewardLayout; title: string; imageUrl?: string; overlayImageUrl?: string;
    subtitle?: string; chips: Array<{ label: string; tone?: "rarity" | "highlight" }>;
    rarity?: string; linkUrl?: string;
  }
  function buildRewardView(event: ActivityHistoryRecord, t: TFunction): RewardView | undefined;
  ```
  Registry keyed by `reward_claimed` → drop; `reward_obtained` by `kind` (`challenge_card` → card, `extension_pack` → pack, `extension_capture`/`extension_giveaway` → item); legacy `challenge_claimed` → card without image; legacy `twitch_extension_action` → item; unknown `kind` → generic using `name`, `imageUrl`, `source`, `channel`, `details` as chips.
- Produces in `activity.logic.ts`:
  ```ts
  type TimelineBlock =
    | { type: "session"; summary: FarmingSessionSummary; open: boolean; rewards: ActivityHistoryRecord[]; status: ActivityHistoryRecord[] }
    | { type: "outside"; day: string; rewards: ActivityHistoryRecord[]; status: ActivityHistoryRecord[] }
    | { type: "earlier"; rewards: ActivityHistoryRecord[]; status: ActivityHistoryRecord[] };
  function buildActivityTimeline(sessions: FarmingSessionSummary[], events: ActivityHistoryRecord[], platform: Platform): TimelineBlock[];
  ```
  Rows with a string `sessionId` go to that session; `sessionId: null` to an "outside" block per local day; no `sessionId` key to "earlier" (last); platformless rows to the session whose `[startedAt, endedAt ?? now]` contains their `at`, else outside. Rewards are rows where `buildRewardView` is defined; status is every other timeline row except `session_*`. Blocks sort newest first; "earlier" last.
- Rendering (layout A per spec): open session expanded; past sessions collapsed to one line (`startedAt–endedAt`, points total, reward count from `rewardCounts`) and expand on click; inside a block: totals tiles (only non-zero), Rewards, Points by channel (sorted by total desc; reason chips: WATCH → Watching, CLAIM → Bonus ×n, WATCH_STREAK → Streak highlighted, RAID → Raid, others raw), Status collapsed behind "Status (n)". Images via `ImageWithFallback`. Card layout is portrait with a rarity-coloured border (common/uncommon/rare/epic/legendary/mythic).
- New locale keys (English bodies here; Task 11 translates): `activitySessionCurrent` "This session", `activitySessionOutside` "Outside a session", `activitySessionEarlier` "Earlier", `activityTotalPoints` "points", `activityTotalDrops` "drops", `activityTotalCards` "cards", `activityTotalExtension` "extension", `activitySectionRewards` "Rewards", `activitySectionPoints` "Points by channel", `activitySectionStatus` "Status ($1)", `activitySessionSummary` "$1 points · $2 rewards", `pointsReasonWatch` "Watching", `pointsReasonClaim` "Bonus ×$1", `pointsReasonWatchStreak` "Streak", `pointsReasonRaid` "Raid", `rewardCardTitle` "$1 card", `rewardPackTitle` "Pack opened · $1 cards", `rewardCaptureTitle` "Capture", `rewardGiveawayTitle` "Giveaway entered", `activitySessionStarted` "Started a farming session", `activitySessionEnded` "Ended the farming session". Also give `reward_obtained`/`points_earned`/`session_*` real text in `formatCurrentActivity` (used by copy/export).

- [ ] **Step 1: Failing tests**
  - `buildActivityTimeline` with one open session, one closed session, a `sessionId: null` reward from yesterday and a legacy row → blocks `[session(open), session, outside, earlier]` with each row in the right block.
  - `buildRewardView` for a `reward_obtained` card with `rarity: "legendary"` and `imageUrl` → `layout: "card"`, `imageUrl` set, a rarity chip; an invented `kind` → `layout: "generic"` with detail chips.
  - rendering: the open session shows "This session", a points row "shroud +550" with a "Streak" chip, and "Status (2)" collapsed; clicking a past session line expands it.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/activityView.test.ts tests/activityLogView.test.tsx` — FAIL.
- [ ] **Step 3: Implement**; add the English keys to `packages/locales/messages/en.json` only.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck && pnpm test && pnpm build:site` — PASS.
- [ ] **Step 5: Commit** `feat(popup): show activity as per-session reward summaries`

## Phase 4 — Locales, docs, verification

### Task 11: Translate the new keys

**Files:** `packages/locales/messages/*.json` (17 non-English catalogs: ar, cs, de, es, fa, fr, hi, id, it, ja, ko, pl, pt_BR, ru, tr, uk, zh_CN). Remove `activityPageContext*` keys only if nothing renders them any more (grep first; the legacy rows are filtered, so they should be unused).

- [ ] **Step 1:** Dispatch one Haiku subagent per locale with the English key/value list from Task 10, the rules (preserve `$1`, brand names Twitch/Kick/Lurkloot/Fortnite/NoPixel, keep "farm" as the gaming term), and ask for JSON back only.
- [ ] **Step 2:** Merge each result into its catalog in the same key order as `en.json`.
- [ ] **Step 3:** Run the locale catalog tests: `pnpm test` — PASS (catalog-parity tests enforce key sets and placeholders).
- [ ] **Step 4: Commit** `feat(locales): translate activity session summary copy`

### Task 12: Architecture docs and full verification

**Files:** `docs/architecture.md`

- [ ] **Step 1:** Add a section "Activity sessions and reward kinds": session ownership (two writers), stamping at `reportBestEffort`, the reward-kind registry and how a new kind or extension provider plugs in (emit `reward_obtained` with a new `ListedRewardKind`, optionally add a popup layout; otherwise the generic row shows it), tallied events never stored as rows, and the sessions store.
- [ ] **Step 2:** Run `pnpm verify` — PASS.
- [ ] **Step 3: Commit** `docs(architecture): describe activity sessions and reward kinds`
- [ ] **Step 4:** Review the full diff against CLAUDE.md "Architecture Rules"; fix or note exceptions for the PR.
