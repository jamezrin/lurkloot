# Critical failure prompt — design

Date: 2026-07-25
Status: approved (design), not yet implemented
Relates to: #53 (stuck progress detector), #51 (transport-health canary)

## Problem

When the extension stops working — a platform API changes, a region blocks a
host, an integrity token stops being credited — the user is told nothing. The
popup keeps showing campaigns, the engine keeps looping, and the drop never
completes. The user discovers it hours or days later, and the only recourse is
a one-star review.

A second, sharper case comes from a real report (NETV4R, 2026-07-24): the Kick
managed page-context tab reopened immediately every time it was closed, fast
enough that the user could not click the extension icon to disable it. Their
diagnostic log was **empty** for that episode, so there was nothing to send.

This design adds a per-platform detector that declares the extension
critically broken only when it is certain, replaces the drops view with an
explanation, and gives the user one button that collects diagnostics and opens
a GitHub issue.

## Goals

- Detect, with near-zero false-positive risk, that a platform is producing no
  value for the user.
- Detect and **stop** a page-context reopen loop, which is user-hostile
  regardless of accrual.
- Give the user a report worth pasting into an issue, even when
  `diagnosticLogging` is off (its default).
- Let the user dismiss and resume, with the prompt able to return.
- Localize all user-facing copy.

## Non-goals

- Auto-remediation beyond opening the page-context circuit breaker.
- The transport-health canary (#51) and proxy plumbing (#52).
- Configurable thresholds. Constants only, plus one kill switch.

## Detection

Per platform. Two independent triggers.

### Trigger 1 — sustained API failure AND no forward progress

Both conditions must hold continuously over the same window.

**Failing.** The platform's tick ended in error: session `status === "error"`,
the platform is in error backoff (`retryAfter` set / `isInBackoff`), or
`discoverCampaigns`/`readProgress` threw. Tracked as *accumulated failing
time*, not a tick count, so a slow tick cadence cannot shorten the window.

**No forward progress.** Over the same window, either:

- a reward was watched under conditions that should accrue — the precondition
  set from #53: session `status === "watching"`, channel live, category
  matches, heartbeat healthy or tab playback progressing, campaign and reward
  window active — and `watchedMinutes` never increased; **or**
- no watch session was ever sustained at all (the failure is severe enough
  that farming never starts).

**Reset.** The window resets to zero whenever any accrual precondition breaks
mid-window (channel offline, category change, heartbeat unhealthy,
tabless→tab fallback, engine paused, `pauseOnManualWatch`, target/campaign/
reward switch, account change) or the platform recovers a clean tick. Elapsed
time is accumulated from healthy-tick deltas, never wall-clock subtraction, so
a suspended browser does not read as a huge stuck window.

**Threshold.** 45 minutes of accumulated failing time, and at least 6 failing
ticks.

### Trigger 2 — page-context churn

Standalone; no API-failure or accrual requirement. Five managed page-context
creations for the same platform within 10 minutes flags immediately.

On flag the **circuit breaker** opens: `openPageContext` refuses to create a
context for that platform, and any retained context tab is closed once. This
is the fix for the reported symptom — the user regains control of the browser.
Farming that depends on the page context stops for that platform until the
prompt is dismissed.

### Event semantics

Edge-triggered, one event per episode:

- `critical_failure_detected` — level `error`, `data: { reason:
  "no_progress" | "page_context_churn" }`
- `critical_failure_cleared` — level `info`, emitted on dismissal

No per-tick flooding.

## State

`SchedulerState` gains:

```ts
criticalHealth?: Partial<Record<Platform, CriticalHealthState>>;

interface CriticalHealthState {
  status: "ok" | "flagged";
  reason?: "no_progress" | "page_context_churn";
  flaggedAt?: string;
  failingMs: number;
  failingTicks: number;
  lastAccrualAt?: string;
  lastWatchedMinutes?: number;
  contextOpens: string[];      // ISO timestamps, trimmed to the churn window
  breakerOpen: boolean;
  dismissedAt?: string;
  cooldownUntil?: string;
  records: FailureRecord[];    // always-on ring buffer, max 30
}
```

`status`, `reason`, `flaggedAt`, `breakerOpen`, `cooldownUntil` and `records`
persist. Counters (`failingMs`, `failingTicks`, `contextOpens`) reset on
restart — MV3 service workers recycle constantly, so an in-memory-only flag
would rarely survive long enough to be seen, while stale counters from an old
outage should not accumulate across sessions.

### Always-on failure ring buffer

`diagnosticLogging` defaults to `false` (`packages/shared/src/settings.ts`),
so at the moment a user hits this prompt their diagnostic history is usually
empty — precisely the NETV4R case. The detector therefore keeps its own
bounded buffer of the last 30 `FailureRecord`s regardless of that setting:

```ts
interface FailureRecord {
  at: string;
  platform: Platform;
  kind: "api_error" | "auth" | "context_open" | "no_accrual";
  code?: string;        // SafeFetchError.kind, reasonCode, or open reason
  status?: number;      // HTTP status when known
  detail?: string;      // short, truncated; error message only
}
```

No response bodies, no tokens, no cookies. Names and identifiers are limited
to what activity events already contain.

## Dismissal

"Dismiss and try again" clears all counters, closes the circuit breaker, sets
`cooldownUntil = now + detection window`, emits `critical_failure_cleared`,
and returns the platform to normal operation. Re-flagging requires the
cooldown to elapse and the full window to rebuild from zero, so a hard outage
cannot re-trigger the prompt instantly.

## Popup UI

New `packages/popup-ui/src/criticalFailure.tsx` exporting
`CriticalFailurePanel`. `Popup.tsx` renders it in place of `DropsPanel` when
`snapshot.criticalHealth?.[platform]?.status === "flagged"`. The header,
platform switcher, settings and activity log stay reachable, so the other
platform keeps working and the user can still self-diagnose.

Contents:

- Error icon and title.
- Explanation naming the reason: stalled progress, or a tab that kept
  reopening (the latter states that reopening has been stopped).
- Primary button **"Copy logs & open issue"**: builds the report, writes it
  with `navigator.clipboard.writeText` inside the click gesture, then opens
  the prefilled issue URL via `openHttpsLink`. If the clipboard write fails,
  it renders the report in a selectable `<textarea>` and does **not** open the
  issue — never send the user to a blank issue form with nothing copied.
- Secondary button **"Dismiss and try again"**.

The issue URL is `https://github.com/jamezrin/lurkloot/issues/new` with a
prefilled title (`Critical failure: <reason> on <platform>`) and a short body
template containing a paste marker. The report itself goes to the clipboard,
not the URL, to avoid length truncation.

## Report

Builder in `packages/shared/` (pure, unit-testable, reused by the CLI).
Markdown, in this order:

1. Extension version, browser/user agent, locale, platform.
2. Detector summary: reason, flagged-at, window length, failing tick count,
   last accrual timestamp and `watchedMinutes`, page-context open count.
3. Current session state, auth health, watch mode, and settings relevant to
   farming (booleans and enums only).
4. The failure ring buffer.
5. Recent activity events, and diagnostic events when `diagnosticLogging` is
   on.

Channel and campaign names are included; credentials, cookies, tokens and
response bodies never are.

## Settings

One new advanced setting: `criticalFailurePromptEnabled`, default `true`.
When off, the detector does not run and the panel never renders. Added through
the existing `settingsSchema` migration path.

## Localization

~10 new message keys (title, two reason bodies, two button labels, clipboard
fallback copy, copied confirmation) added to all ten catalogs in
`packages/locales/messages/`.

## Testing

Vitest in `packages/extension/tests/`, mocked adapters and injected clock:

- Steady accrual with occasional errors never flags.
- Sustained failure plus plateau flags once after the window, not before.
- Mid-window recovery, offline, category change, heartbeat dip and target
  switch each reset the window.
- Never-started farming plus sustained failure flags.
- Churn threshold flags; breaker gates `openPageContext`; below-threshold
  churn does not flag.
- Dismiss resets counters, closes the breaker, and the cooldown blocks
  immediate re-flagging.
- Persisted flag survives a simulated restart while counters reset.
- Report builder produces a usable report with an empty ring buffer and with
  `diagnosticLogging` off.
- `coreBoundary.test.ts` stays green — no browser globals in core.

## Rejected alternatives

**Popup-side derivation** from the activity stream: cannot circuit-break tab
creation, cannot notify, and has nothing to read when the diagnostic log is
empty — the exact reported case.

**A separate background watchdog** in the extension: duplicates state
plumbing, excludes the CLI, and needs its own seam into `tabs.ts` for the
breaker.
