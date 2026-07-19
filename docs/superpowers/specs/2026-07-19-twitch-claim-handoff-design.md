# Accelerate Twitch Reward Handoff After a Claim

**Date:** 2026-07-19

Resolves [#110](https://github.com/jamezrin/lurkloot/issues/110). Related to [#106](https://github.com/jamezrin/lurkloot/issues/106).

## Purpose

When a Twitch reward is claimed, `runSchedulerTick` reconciles campaign state and picks the next
watch target within the same tick. Two things still stall the chain:

- Twitch's inventory may not yet report the next reward as active at the moment that tick reads
  progress, so the scheduler sees no successor.
- Even when the successor is chosen correctly, the first tabless heartbeat for it waits on the fixed
  one-minute `WATCH_ALARM_NAME` alarm.

Together these cost up to a minute of unearned watch time per reward in a campaign chain, and delay
confirmation that the next reward has activated.

This design adds a bounded, abortable post-claim handoff that re-polls for the successor and, once
it appears, transmits immediately instead of waiting for the alarm.

## Goals

- Let a newly available next reward begin earning before the next regular heartbeat alarm.
- Keep the refresh loop bounded in both cadence and total duration, and abortable at any point.
- Make the retry interval and maximum duration configurable in Advanced Settings and CLI JSONC.
- Fall back to unmodified alarm-driven scheduling whenever the handoff cannot confirm a successor.
- Never duplicate claims or heartbeats as a result of the handoff.

## Non-goals

- Changing alarm cadence, or replacing alarm-driven scheduling in any way.
- Implementing the handoff for Kick. Kick's tabless watcher holds a persistent viewer WebSocket and
  self-paces its sends, so there is no equivalent minute of dead time to recover. See
  `packages/core/src/core/tablessWatch.ts`.
- Reloading or navigating a healthy visible watch tab.
- Making every timing constant in the controller configurable.

## Considered Approaches

### Bounded loop of scoped `tick([platform])` — selected

The handoff re-runs the existing scheduler tick for the claimed platform at the configured interval
until the session lands on a different reward, then fires one immediate tabless heartbeat.

A scoped tick already performs `discoverCampaigns()` + `readProgress()`, so this costs the same
platform requests as a hand-rolled inventory poll while reusing eligibility filtering, claim
guarding, target selection, and watcher reconciliation. Duplicate claims are prevented for free:
`claimReadyRewards` only acts on rewards whose `status` is `"claimable"`, so a re-tick over
already-claimed rewards is a no-op.

### Lightweight inventory poll, then a single tick

Poll `readProgress` directly in the loop and run one tick only after detecting a successor. Fewer
state writes, but it reimplements eligibility detection outside the scheduler, where it can drift
out of agreement with `isEligible` / `isRewardAvailableToEarn`.

### A dedicated short-interval alarm

Not viable. `chrome.alarms` clamps to a one-minute minimum, so it cannot express a five-second
cadence — the exact constraint that motivated the fixed one-minute watch alarm in the first place.

## Architecture

### Adapter capability

`PlatformAdapter` gains an optional capability flag alongside `supportsTabless`
(`packages/core/src/platforms/adapter.ts:56`):

```ts
// Whether a bounded post-claim refresh is worthwhile on this platform. Twitch
// only reveals the next reward in a campaign chain on a subsequent inventory
// read, so re-polling recovers watch time the fixed alarm would waste.
supportsPostClaimHandoff?: boolean;
```

The Twitch adapter sets it; Kick leaves it unset. The controller stays platform-neutral, per the
`CLAUDE.md` rule that platform behavior lives behind `PlatformAdapter`.

### Trigger

`tick()` already runs inside `withEventCollector` and therefore observes every emitted event. It
collects the `reward_claimed` activity events (`packages/core/src/core/scheduler.ts:473`) and returns
the claimed reward ids keyed by platform, so its current `Promise<void>` becomes
`Promise<ClaimedRewards>` where `ClaimedRewards = Partial<Record<Platform, string[]>>`. The popup's
manual-claim path (`packages/core/src/background/controller.ts:771`) triggers the handoff on the same
basis, passing the id it just claimed.

The ids, not merely the platforms, are what the handoff needs: it recognises a successor as "the
session is watching a reward that is not one of the ones just claimed". Deriving that from the
session's own `rewardId` after the tick does not work, because by then the session already points at
the successor — which would be recorded as claimed, and the loop would never terminate.

A handoff starts only when the platform's adapter declares `supportsPostClaimHandoff`, the settings
enable it, and farming is running.

### Driver

`runClaimHandoff(platform)` runs **outside** the state lock. Each iteration's `tick()` acquires the
lock on its own and releases it, which keeps a handoff from blocking telemetry writes, heartbeats,
or user actions for its whole duration. This mirrors the existing arrangement in
`runWatchHeartbeat`, which deliberately defers its trailing `tick()` until after its locked closure
returns.

A per-controller `Map<Platform, AbortController>` tracks in-flight handoffs. Starting a handoff for a
platform that already has one is a no-op rather than a restart. The map entry is claimed
**synchronously, before the first await**: registering it after the async setup would let two
triggers past the duplicate guard into concurrent loops, and would let an `abortClaimHandoffs()`
arriving mid-setup miss the handoff entirely. Everything after the reservation runs inside a `try`
whose `finally` releases it.

There is also a fast path before the loop. When the triggering tick already selected the successor,
there is nothing to poll for, so the handoff skips straight to the immediate heartbeat.

Loop shape, per iteration:

1. Check `signal.aborted`; exit if set.
2. `await deps.wait(min(intervalMs, deadline - now), signal)` — capped at the remaining budget, so an
   interval longer than what is left cannot push a refresh past the deadline.
3. Check `signal.aborted` and the deadline; exit if either has passed.
4. `await tick([platform])`.
5. Check `signal.aborted`; exit if set.
6. Load state, re-check `signal.aborted` (a cancellation during the load must not still transmit),
   then evaluate stop conditions.

### Re-entrancy and boundedness

A `reward_claimed` event emitted by a handoff's *own* tick does not start a nested handoff and does
not extend the deadline. The deadline is computed once, when the handoff starts. This is what makes
the "does not duplicate claims or watch heartbeats uncontrollably" criterion structural rather than
incidental: the worst case is fixed at `ceil(maxSeconds / intervalSeconds)` ticks per handoff,
regardless of how many rewards claim during it.

### Stop conditions

The loop ends on the first of:

- **Success** — the platform session has `status === "watching"` and a `rewardId` that differs from
  every reward id claimed so far in this handoff.
- **Nothing left** — the tick produced no eligible reward for the platform (for example a session
  reason code of `campaign_ineligible`). Exits early rather than burning the remaining budget.
- **Deadline** — `maxSeconds` elapsed since the handoff started.
- **Abort** — see below.

### Abort

The handoff aborts on farming stopped, the platform being disabled, `beginSettingsSession()`,
runtime restart, and CLI shutdown — the last of these before the transport is disposed, so a handoff
cannot keep refreshing against disposed resources or hold the process open with a pending delay.
Abort is checked immediately before and after every await, so a stop request takes effect within one
in-flight tick rather than at the next interval boundary.

### Tail action

On success:

- **Tabless** (`session.watchMode === "tabless"`) — send one immediate heartbeat through the
  platform's `TablessWatchController`. Skipped when a heartbeat already landed within the last 30
  seconds **and** the watcher's `channelUrl` is unchanged, so the handoff and the one-minute alarm
  cannot double-send to the same channel. A channel switch always transmits immediately, because the
  session's `lastHeartbeatAt` then refers to the previous target.
- **Visible tab** — nothing further. The tick that detected the successor has already re-pointed or
  retained the tab, and a healthy tab earns progress continuously, so there is nothing to accelerate.

On timeout, no-successor, or abort: emit a diagnostic and stop. Alarm scheduling is never touched by
any path in this design, so every failure mode degrades to exactly today's behavior with state
intact.

### Testability

`BackgroundControllerDeps` gains an optional `wait(ms, signal): Promise<void>`, defaulting to a
`setTimeout`-based implementation. Tests inject a manually-advanced implementation and drive the
loop deterministically, instead of coordinating fake timers against real promise scheduling.

## Settings

New `EngineSettings` fields (`packages/shared/src/models.ts:261`), with defaults and clamping in
`packages/shared/src/settings.ts:60` and `:134`:

| Field | Default | Clamp |
| --- | --- | --- |
| `postClaimHandoff` | `true` | boolean |
| `postClaimHandoffIntervalSeconds` | `5` | 1–30 |
| `postClaimHandoffMaxSeconds` | `45` | 5–120 |

The defaults give at most nine inventory reads per claim and always finish before the next
one-minute alarm, so the handoff and the alarm never contend.

Enablement is an explicit boolean rather than an overloaded `postClaimHandoffMaxSeconds: 0`. A magic
zero inside a `NumberSettingRow` reads as a bug to the user. The cost is a third row in an Advanced
section that currently holds two.

## Affected Files

- `packages/core/src/platforms/adapter.ts` — `supportsPostClaimHandoff` capability flag.
- `packages/core/src/platforms/twitch/index.ts` — declare the capability.
- `packages/core/src/background/controller.ts` — `runClaimHandoff`, abort map, claimed-platform
  return from `tick()`, manual-claim trigger, `deps.wait`.
- `packages/shared/src/models.ts`, `packages/shared/src/settings.ts` — fields, defaults, clamps.
- `packages/cli/src/config.ts:57` — JSONC template entries with explanatory comments.
- `packages/popup-ui/src/settings.tsx:155` — one `SettingRow` toggle plus two `NumberSettingRow`s in
  the Advanced section; interval and maximum are disabled while the toggle is off.
- `packages/locales/messages/*.json` — six new keys across all ten catalogs.

## Testing

In `packages/extension/tests/backgroundController.test.ts`:

- **Success** — successor appears mid-loop; exactly one immediate heartbeat is sent and the loop ends.
- **Timeout** — no successor within `maxSeconds`; loop ends, alarms untouched, state uncorrupted.
- **Abort** — farming stops mid-handoff; loop ends without a further tick or heartbeat.
- **No next reward** — platform has nothing eligible; loop exits early rather than at the deadline.
- **Visible tab** — successor detected in playback mode; the tick runs and no heartbeat is sent.
- **No double heartbeat** — a recent heartbeat on an unchanged channel suppresses the immediate send.
- **No nested handoff** — a claim occurring inside a handoff neither starts a second handoff nor
  extends the original deadline.
- **Unsupported platform** — Kick claims do not start a handoff.

In the shared settings suite: clamping of out-of-range, missing, and non-numeric values for all three
new fields.

All coverage is engine-level. Consistent with the repository's standing decision not to assert on
workflow YAML, nothing here tests `.github/workflows` content.
