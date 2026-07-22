# Scheduler Authentication Health Integration

## Problem

The scheduler currently runs account-dependent platform operations without consulting the persisted authentication-health state. This allows missing, rejected, blocked, or temporarily unavailable authentication to fall into ordinary platform-error handling. Kick can additionally continue from public campaign data and present a misleading active farming session after authenticated progress or challenge calls fail.

Issue #204 requires enabled platforms to remain enabled while account automation is suspended, to recover automatically after authentication becomes healthy, and to keep authentication failures separate from ordinary retry backoff.

## Design

### Scheduler-level authentication gate

`runSchedulerTick` will gate each enabled platform before challenge polling, backoff handling, discovery, progress, claiming, channel selection, watch setup, channel-point claiming, or heartbeat reconciliation can run.

Only `healthy` authentication permits account automation. `checking`, `missing_credentials`, `invalid_credentials`, `blocked`, and `unavailable` are non-operational states. For a non-operational platform, the scheduler will:

- preserve `settings.platform[platform].enabled`;
- stop any existing watch tab and remove its managed-watch-tab record;
- close managed page-context tabs for that platform;
- replace the active presentation with a non-watching session;
- clear retry timestamps and preserve the existing ordinary error count without incrementing it;
- retain the authentication-health value as the authoritative explanation; and
- skip every account-dependent adapter operation.

The session will use `paused` with a new `authentication_unhealthy` reason code. This exposes an explicit operational state without conflating authentication with an ordinary platform failure or expanding the session status union solely for this issue.

Campaign data for a non-operational platform will be cleared so stale or public-only inventory cannot imply that rewards are actively being farmed. Authentication-health data itself remains intact for the popup work in issue #205.

### Recovery

Credential observation and explicit probes already transition authentication health through `checking` to a terminal result. When a successful recheck stores `healthy`, the next platform-specific or ordinary scheduler tick passes the gate and resumes discovery and farming automatically. No settings toggle or error-backoff expiry is required.

### Authentication failures during execution

The scheduler gate prevents known unhealthy sessions from starting work. Authentication may nevertheless fail after a healthy probe because a token expires or the platform begins blocking requests during a tick.

Adapters will expose a small, browser-free authentication-failure classification contract for errors raised by account-dependent operations. The scheduler will recognize those failures, map them to sanitized `PlatformAuthHealth`, update the platform health through the existing `applyPlatformAuthHealth` transition helper, emit the resulting user-visible activity event, and suspend the platform without entering ordinary backoff.

This classification will be applied consistently to discovery, progress, reward claims, channel points, challenges, channel validation/watch setup, and tabless heartbeat failures. In particular, challenge and Kick progress handling must rethrow classified authentication failures instead of converting them into optional diagnostics or public-data fallback behavior. Non-authentication failures retain current behavior, including challenge best-effort diagnostics and ordinary platform backoff.

### Controller and heartbeat coordination

The core scheduler owns the gate so browser and future CLI hosts share the same behavior. The controller will reconcile tabless watchers only for sessions that remain operationally watching. When an authentication transition suspends a platform, existing watchers are stopped by normal reconciliation and cannot emit further heartbeats.

Authentication transitions remain activity events regardless of the diagnostic logging setting. Ordinary diagnostics continue to respect existing persistence policy.

## Data and API changes

- Add `authentication_unhealthy` to `WatchReasonCode` and `FarmingStopReason`.
- Add the same reason to page-context close reasons where platform cleanup reports why the context closed.
- Add a sanitized core authentication-failure type/classifier that carries only status, reason code, safe message metadata, and optional troubleshooting reference.
- Reuse `PlatformAuthHealth`, `applyPlatformAuthHealth`, and `auth_health_changed`; do not introduce a second authentication state.
- Do not persist tokens, cookies, request headers, or authenticated response bodies.

## Error handling

Authentication failures are control flow for platform suspension, not scheduler errors. They do not increment `errorChecks`, set `retryAfter`, emit `platform_backoff`, or disable the platform.

Transient non-authentication failures continue to use the existing exponential platform backoff. An authentication status of `unavailable` also suspends account work until a probe changes it; it is distinguishable through its reason code (`credential_lookup_failed`, `platform_unavailable`, or `network_unavailable`).

If cleanup of an existing watch/page-context resource fails while suspending, the scheduler records a diagnostic but still commits the safe non-watching operational state. Cleanup failure must not allow additional account work in that tick.

## Testing

Focused deterministic scheduler and controller tests will cover:

- startup with missing credentials: no account-dependent calls and no watching session;
- logout while farming: watch resources stop, stale campaigns clear, and farming stops with the authentication reason;
- login recovery: healthy recheck resumes automation without changing platform enablement;
- invalid token: authentication activity transition and suspension without backoff;
- Kick WAF/security-policy blocking: blocked health with safe reference and no public-data farming presentation;
- transient platform failure: existing ordinary backoff remains unchanged;
- challenge and progress authentication failures: neither path swallows the failure;
- tabless watching: authentication suspension stops the watcher and prevents further heartbeats; and
- diagnostic logging disabled: authentication transition activity still persists.

Tests will follow the existing Vitest adapter mocks and controller harness. Each behavior will first be expressed as a failing test before production code changes.

## Out of scope

- Popup rendering and copy changes belong to issue #205.
- CLI-specific credential observation and parity belong to issue #206.
- Changes to platform enabled settings, credential storage, or browser permissions are not required.
