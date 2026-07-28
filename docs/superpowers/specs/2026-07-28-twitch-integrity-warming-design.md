# Twitch Integrity Token Warming Design

## Scope

This specification adds proactive lifecycle management for Twitch
`Client-Integrity` tokens in the browser extension. It builds on the bounded
refresh and cold-boot work from issues #291 and #292 and requires the
cancellation work from issue #293 before implementation.

The change is extension-only where alarms and browser page contexts are
concerned. The core controller owns the policy through injected host
dependencies so `@lurkloot/core` remains free of WXT and browser globals. The
CLI remains unchanged because its Twitch client does not use browser-minted
integrity.

## Goals

- Avoid paying for a cold Twitch page-context boot on the critical discovery
  or reward-claim path whenever a token can be refreshed ahead of expiry.
- Delay authenticated Twitch work when no valid token is available instead of
  issuing requests that are expected to fail integrity checks.
- Keep Twitch enablement responsive and preserve the user's enabled setting
  while token acquisition happens internally.
- Retry a failed mint on the next normal discovery alarm rather than creating
  an aggressive retry loop.
- Keep Kick and unrelated extension behavior independent from Twitch token
  readiness.
- Expose lifecycle details through English diagnostics only. Do not add popup
  state, activity events, notifications, or locale keys for preparation.

## Non-Goals

- Do not expose a “preparing,” “warming,” or token-readiness state in the popup.
- Do not make platform enablement wait for token acquisition.
- Do not introduce a fixed-period integrity alarm.
- Do not treat integrity availability as Twitch authentication health.
- Do not mint tokens while Twitch is disabled. The repository deliberately has
  no separate global running flag; farming is active when at least one platform
  is enabled.
- Do not change Kick, the CLI integrity model, or the scheduler’s platform-lock
  architecture from issue #294.

## Lifecycle Model

The user-facing Twitch setting records intent only. Enabling Twitch persists
immediately and triggers the ordinary Twitch scheduler path. Internally,
authenticated Twitch work has a prerequisite: a valid integrity bundle must be
loaded from storage or minted from a Twitch page context.

On controller startup, the existing stored-token load remains the first source
of readiness. A token is valid only when its declared `expiresAt` is later than
the current time plus the existing expiry safety skew. An expired stored token
is ignored and diagnosed; it is never attached to a request.

When a normal Twitch tick starts without a valid token, it makes one bounded
mint attempt before authenticated Twitch discovery or account automation. On
success the tick continues. On timeout, cancellation, or page-context failure,
the tick skips authenticated Twitch work without disabling Twitch. The next
normal discovery alarm is the next automatic retry opportunity. No dedicated
short retry alarm is scheduled.

Public work that is explicitly safe without authenticated integrity may
continue only where the adapter already models it as anonymous. The readiness
gate must not silently downgrade an operation intended to use the logged-in
session into an anonymous request.

## Expiry-Driven Refresh Alarm

Add one browser alarm dedicated to Twitch integrity refresh. It is scheduled
from the currently captured token’s `expiresAt`, not at a fixed interval. The
target is two minutes before expiry minus a stable 0–30 second jitter derived
locally for that token. This leaves more than the 30-second acquisition timeout
and existing 30-second validity skew while preventing every client from
refreshing at exactly the same instant. If the computed target is already past,
the next normal tick owns the attempt; scheduling never creates an immediate
alarm loop.

Whenever a new integrity bundle is captured—whether from the proactive alarm,
a normal page request, startup recovery, or a rejection-triggered refresh—the
controller persists it and replaces the prior alarm with one derived from the
new expiry. Rescheduling is idempotent.

When the alarm fires, the controller reloads settings before acting. It mints
only if Twitch is still enabled and the current token is
missing or inside the refresh window. If a naturally captured replacement is
already valid beyond that window, the handler only reschedules from the newer
expiry.

Disabling Twitch, resetting storage, or shutting down the owning host cancels
an active proactive mint and clears the refresh alarm. Disabling every platform
therefore also stops warming without requiring a second master switch.
Re-enabling Twitch recreates the schedule from a still-valid stored token or
lets the next normal Twitch tick perform the initial mint.

## Single-Flight Acquisition

Startup, normal ticks, the expiry alarm, and integrity-rejection retries all
enter the same single-flight acquisition primitive. At most one Twitch
page-context mint may be active. Concurrent callers join its result rather than
opening competing contexts.

The primitive receives:

- whether a fresh context is required;
- the rejected token when a request knows exactly what it transmitted;
- the caller’s `AbortSignal`;
- the diagnostic emitter.

It returns a bounded success result and does not mutate user settings. The
token transmitted by a rejected request remains authoritative for replacement
deduplication, as designed in the #291/#292 fix.

The alarm handler must not hold the controller’s broad scheduler/state lock
while waiting for Twitch to boot and mint. Persistence and alarm rescheduling
occur in short serialized sections after capture. This boundary must be
reconciled with #294’s per-platform locks rather than creating another
controller-wide critical section.

## Scheduler Gating

The Twitch scheduler pipeline checks integrity readiness before constructing or
running authenticated adapter work. The gate applies only when:

- Twitch is enabled; and
- the pending Twitch work requires the logged-in web session.

If acquisition fails, the tick records diagnostics and returns a normal
no-progress Twitch result. It does not emit an interruption activity event,
mark authentication unhealthy, clear campaigns, close an existing farming tab,
or alter Kick state.

An integrity rejection after readiness still uses the existing one-refresh,
one-retry behavior. Proactive warming reduces how often that recovery path is
needed but does not replace it because Twitch can reject an otherwise unexpired
token.

## Diagnostics

All messages are English diagnostic literals and contain no token, cookie,
device identifier, session identifier, or authenticated response content.
Diagnostics distinguish:

- no valid token was available and authenticated Twitch work was delayed;
- proactive refresh started, including the time remaining before expiry;
- a fresh token was captured and the next refresh was scheduled;
- a naturally captured token made the pending alarm obsolete;
- refresh timed out or failed and retry was deferred to the next normal alarm;
- refresh was cancelled because Twitch stopped;
- an expired stored token was ignored after service-worker startup.

Routine successful rescheduling should use debug-level diagnostics. Acquisition
failure uses warning level only when Twitch work was actually delayed; cleanup
and expected cancellation remain debug level.

## Failure Handling

Alarm creation, removal, token persistence, and page-context acquisition are
best-effort boundaries with diagnostics. A failed alarm write must not discard
a freshly captured token. A failed token write leaves the in-memory token
usable for the current service-worker lifetime and may be retried after the
next capture.

If the browser was asleep when the scheduled time passed, the alarm may fire
late. The handler rechecks current token validity and settings rather than
assuming the state captured at scheduling time is still correct.

Cancellation from #293 is required to close an acquisition cleanly. An aborted
mint must release its page-context ownership, remove its waiter, settle joined
callers, and clear the single-flight slot so a later normal alarm can retry.

## Testing

Deterministic controller, tabs, and background-entrypoint tests cover:

- enabling Twitch returns without waiting for a mint;
- no popup snapshot field or user-facing event represents preparation;
- a normal Twitch tick with no valid token waits for one bounded acquisition
  before authenticated work;
- a successful acquisition allows the same tick to continue;
- a failed acquisition skips authenticated Twitch work and does not schedule a
  short retry;
- the next normal alarm retries after a failed acquisition;
- Kick continues when Twitch acquisition is pending or fails;
- a captured token schedules refresh from `expiresAt` with bounded jitter;
- a replacement token atomically replaces the old refresh schedule;
- the alarm handler no-ops or reschedules when a newer token already exists;
- the alarm handler does not mint while Twitch is disabled;
- Twitch disable, reset, and host shutdown cancel active acquisition and clear
  the alarm;
- tick, expiry, and rejection callers share one in-flight mint;
- cancellation releases all waiters and permits a later retry;
- late browser alarms revalidate settings and token state;
- diagnostics contain lifecycle timing but no sensitive integrity values;
- existing auth-health, discovery, claim, and browser-build suites remain
  green.

Tests use fake clocks, mocked alarm dependencies, mocked browser tabs, and
synthetic integrity bundles. They make no live Twitch requests.

## Delivery and Ordering

Implementation starts only after the #291/#292 bounded-refresh work and #293
cancellation are present on the target branch. It should land before or be
rebased explicitly onto #294; its alarm and single-flight behavior must not
restore a controller-wide lock after #294 splits platform pipelines.

The feature is complete when valid tokens schedule proactive refresh,
authenticated Twitch work waits internally for initial readiness, failed
acquisition retries only on the next normal discovery alarm, cancellation
cleans up all ownership, and no preparation state is exposed outside
diagnostics.
