# Prompt Authentication Health Resolution

## Summary

Resolve enabled-platform authentication health promptly after browser startup,
extension installation/update/reload, scheduler ticks, and relevant credential
cookie changes. Twitch and Kick probes run concurrently, each has a configurable
controller-owned timeout with a 10-second default, and each result is persisted
as soon as it settles.

This work addresses GitHub issue #275. It does not add a user-facing timeout
setting or change which cookies are observed.

## Goals

- Move every enabled platform from `checking` to a terminal authentication
  health state within a bounded interval.
- Prevent a slow Twitch probe from delaying Kick persistence, and vice versa.
- Persist authentication health before campaign discovery or other scheduler
  work.
- Refresh authentication health when the UI can present it even if farming is
  stopped.
- Preserve all concurrent scheduler state mutations while applying a
  platform-local authentication update.
- Cancel the auth-specific network request after a timeout rather than leaving
  it running in the background.

## Non-goals

- Exposing the timeout in extension or CLI settings.
- Applying the auth timeout to campaign discovery, progress, claims, heartbeat,
  or other non-authentication requests.
- Changing authentication-health statuses or adding localized messages.
- Changing platform enablement or automatically starting farming.

## Configuration and contracts

`BackgroundControllerDeps` gains an optional `authProbeTimeoutMs` number. The
controller uses `10_000` milliseconds when the host does not provide a value.
This is an internal host dependency, so tests and alternate hosts can choose a
different timeout without adding persisted settings.

`PlatformAdapter.checkAuthHealth` accepts an optional `AbortSignal`. Twitch and
Kick adapters pass that signal in the `RequestInit` for authentication-specific
fetches. Existing callers and adapters remain source-compatible because the
argument is optional.

The timeout covers the complete controller probe, including credential
availability lookup and adapter work. When it expires, the result is:

```ts
{
  status: "unavailable",
  checkedAt: "<current ISO timestamp>",
  reasonCode: "network_unavailable",
  message: { key: "authNetworkUnavailable" },
}
```

Existing mappings remain unchanged: missing cookies produce
`missing_credentials`, unavailable cookie lookup produces
`credential_lookup_failed`, rejected credentials remain adapter-defined, and
other thrown probe failures retain the controller's existing terminal
`unavailable` fallback.

## Controller architecture

The controller separates authentication refresh from the scheduler's long-held
state mutation lock:

1. Load settings and create the platform adapters needed for the refresh.
2. Start one refresh task for every requested, enabled platform without awaiting
   the previous platform.
3. Give each task its own `AbortController` and timeout.
4. When a task settles, clear its timer and acquire the existing state lock.
5. Inside the lock, reload the latest stored state, apply only that platform's
   health transition, then persist the state and report its events.
6. Resolve the platform task only after its state and events are durable.

Each persistence operation therefore performs a fresh load-modify-save while
holding the same lock used by scheduler ticks, telemetry, heartbeat, and other
controller state mutations. It cannot overwrite fields written by a concurrent
operation. The refresh tasks compete for the lock only after their network work
has completed; no network request holds the state lock.

A multi-platform refresh returns after all requested tasks resolve. Because each
task persists independently, a fast platform becomes visible while the other is
still probing. A timeout bounds how long the scheduler waits before proceeding.

## Scheduler flow

At the beginning of `tick`, the controller loads settings, refreshes
authentication for the requested enabled platforms concurrently, and waits for
the bounded refresh group to finish. It then enters the existing serialized
scheduler mutation, reloads settings and state, creates the scheduler adapters,
and performs campaign discovery, progress reads, claims, tab work, notifications,
ad focus, and tabless reconciliation.

The scheduler no longer carries unpersisted probe results in `probedHealth` or
reapplies them during rollback. Auth results are already durable before
scheduler work begins. A later scheduler failure rolls back scheduler work only
and cannot revert the separately persisted authentication fields because the
locked scheduler phase began from the post-refresh state.

Platform-scoped ticks refresh only their requested platform. Disabled platforms
are skipped.

## Startup, installation, and cookie lifecycle

`handleStartup` schedules a bounded refresh for every enabled platform
regardless of `running` or `autoStartDropFarming`. It retains the existing tab
cleanup and farming restart behavior. The refresh does not start farming.
When startup will immediately auto-start through `tick`, that tick supplies the
refresh; otherwise `handleStartup` calls the refresh directly. Thus one startup
path performs one probe per enabled platform.

`ensureAlarm` also schedules the same refresh after creating alarms. Because
`runtime.onInstalled` already calls `ensureAlarm`, fresh installs, updates, and
extension reload/update lifecycle handling refresh authentication even when
farming is stopped. When `ensureAlarm` will immediately auto-start through
`tick`, it delegates the refresh to that tick instead of probing first. No
long-lived auth cache is added.

The credential observer continues to persist `checking` immediately and debounce
rapid cookie changes. Its recheck callback calls the controller's platform-local
bounded authentication refresh directly. It does not invoke a full farming tick,
so a failed or stalled auth request cannot leave `checking` indefinitely and a
cookie event cannot trigger unrelated scheduler work.

## Timeout and cancellation behavior

Each platform has an independent timer. On timeout, the controller aborts that
platform's signal and resolves its task with the terminal network-unavailable
health result. The other platform's timer, request, and persistence are
unaffected.

The timeout race must settle exactly once. A late adapter result or rejection
after the timeout must not produce a second persistence operation or an unhandled
rejection. Timers are cleared on every non-timeout completion. Aborting an auth
fetch is an expected timeout path and must not emit raw exception text or add
localized diagnostic keys.

## Testing

Controller tests use deferred promises to show that:

- Twitch and Kick probes are both started before either resolves.
- Resolving Kick persists Kick health while Twitch remains pending.
- Campaign discovery has not begun before all requested auth tasks are terminal.
- A scheduler failure after the refresh preserves both durable auth results.
- A state mutation queued while a probe is pending is retained when auth health
  is later applied.

Fake-timer tests configure a short `authProbeTimeoutMs` and show that:

- Advancing to the configured deadline resolves a stalled probe to
  `unavailable` with `network_unavailable`.
- The adapter receives an `AbortSignal` that becomes aborted at the deadline.
- One platform timing out does not delay an already resolved platform.
- Late probe settlement does not persist twice or cause an unhandled rejection.

Startup tests show that `handleStartup` and `ensureAlarm` refresh every enabled
platform while farming is stopped and skip disabled platforms. Background
wiring tests or focused lifecycle assertions show that `runtime.onInstalled`
continues through `ensureAlarm`.

Credential observer tests show that the debounced callback invokes the
platform-local refresh path and that its bounded controller behavior—not a full
scheduler tick—owns terminal resolution.

Adapter/transport tests assert that Twitch and Kick auth requests receive the
controller signal while unrelated fetches remain unchanged.

## Acceptance

The implementation is complete when all issue #275 acceptance criteria are
covered by deterministic tests, workspace typechecks pass, the extension test
suite passes, and the scheduler's existing state-locking and rollback tests
remain green.
