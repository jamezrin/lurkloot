# Scheduler Authentication Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suspend every account-dependent platform operation while authentication is unhealthy, preserve enabled settings, and resume automatically after a healthy recheck without entering ordinary error backoff.

**Architecture:** The controller refreshes sanitized auth health before scheduler execution. The core scheduler treats persisted health as a per-platform gate, converts mid-tick authentication failures into auth transitions, and leaves non-auth failures on the existing backoff path. Session and campaign state are cleared when blocked so public or stale data cannot imply active farming.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest, browser-free `@lurkloot/core`, shared contracts in `@lurkloot/shared`.

## Global Constraints

- Keep enabled platforms enabled while authentication is unhealthy.
- Only `healthy` authentication permits account-dependent work; every other auth status suspends it.
- Authentication suspension must not increment `errorChecks` or set `retryAfter`.
- Authentication transitions must remain activity events even when diagnostic logging is disabled.
- Do not persist or log tokens, cookies, sensitive headers, or authenticated response bodies.
- Popup UX is out of scope for issue #204.

---

### Task 1: Model and enforce the scheduler auth gate

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `SchedulerState.authHealth: Record<Platform, PlatformAuthHealth>`.
- Produces: `WatchReasonCode` and `FarmingStopReason` member `authentication_unhealthy`; scheduler sessions use `{ status: "paused", reasonCode: "authentication_unhealthy" }`.

- [ ] **Step 1: Write failing scheduler-gate tests**

Add table-driven cases for `checking`, `missing_credentials`, `invalid_credentials`, `blocked`, and `unavailable`. Use an enabled platform with spies for `discoverCampaigns`, `readProgress`, `claimReward`, `claimChallenges`, `listCandidateChannels`, `checkChannel`, `prepareWatchTab`, and `claimChannelPoints`. Assert all remain uncalled, the platform setting object is unchanged, campaigns are empty, and the resulting session is:

```ts
expect(result.state.sessions.kick).toMatchObject({
  status: "paused",
  reasonCode: "authentication_unhealthy",
  errorChecks: 2,
  retryAfter: undefined,
  channel: undefined,
  campaignId: undefined,
  rewardId: undefined,
});
```

Add a logout-while-watching case asserting `stopWatchTab(previous)` and `stopPageContextTabs(..., { platforms: ["kick"], reason: "authentication_unhealthy", emit })` run and managed watch/page-context state is removed.

- [ ] **Step 2: Verify the new tests fail for the missing gate**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
```

Expected: FAIL because discovery/challenge methods run and `authentication_unhealthy` is not a valid reason.

- [ ] **Step 3: Add the reason contracts and minimal gate**

Add `authentication_unhealthy` to `WatchReasonCode`, `FarmingStopReason`, and `PageContextCloseReason`. In `runSchedulerTick`, after disabled/manual-watch handling and before challenges/backoff, branch on:

```ts
if (nextState.authHealth[platform].status !== "healthy") {
  try {
    await adapter.stopWatchTab?.(previous);
  } catch (error) {
    emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Could not stop watch tab");
  }
  nextState.sessions[platform] = {
    ...previous,
    status: "paused",
    channel: undefined,
    campaignId: undefined,
    rewardId: undefined,
    tabId: undefined,
    tabManagedByExtension: undefined,
    playback: undefined,
    playbackChecks: 0,
    retryAfter: undefined,
    message: "Authentication unavailable",
    reasonCode: "authentication_unhealthy",
    watchMode: undefined,
    tablessFallback: undefined,
    heartbeatChecks: 0,
    lastHeartbeatAt: undefined,
    lastHeartbeatOk: undefined,
  };
  nextState.campaigns[platform] = [];
  nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
  nextState.managedPageContextTabs = await stopPageContextTabs(
    nextState.managedPageContextTabs ?? {},
    { platforms: [platform], reason: "authentication_unhealthy", emit },
  );
  continue;
}
```

Keep `errorChecks` unchanged and ensure cleanup errors cannot fall through into account work.

- [ ] **Step 4: Run the focused tests to green**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
```

Expected: PASS, including existing scheduler behavior after updating healthy test fixtures to use explicit healthy auth state.

- [ ] **Step 5: Commit the auth gate**

```bash
git add packages/shared/src/models.ts packages/shared/src/events.ts packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "fix(scheduler): gate account work on authentication health"
```

### Task 2: Refresh auth health before each platform tick and recover automatically

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `PlatformAdapter.checkAuthHealth(): Promise<PlatformAuthHealth>` and optional `checkCredentialAvailability(platform)`.
- Produces: an internal `probeAuthHealth(platform, settings, emit): Promise<PlatformAuthHealth>` used by both explicit checks and scheduler ticks.

- [ ] **Step 1: Write failing startup and recovery tests**

Add a startup-logged-out test whose credential availability reports missing and assert a running/enabled platform calls neither its adapter probe nor discovery. Assert the setting remains enabled and state becomes `missing_credentials` plus `authentication_unhealthy`.

Add a recovery sequence:

```ts
vi.mocked(env.twitch.checkAuthHealth)
  .mockResolvedValueOnce({
    status: "invalid_credentials",
    checkedAt: "2026-07-22T12:00:00.000Z",
    reasonCode: "credentials_rejected",
    message: { key: "authInvalidCredentials" },
  })
  .mockResolvedValueOnce({
    status: "healthy",
    checkedAt: "2026-07-22T12:01:00.000Z",
    message: { key: "authHealthy" },
  });

await env.controller.tickAndHandOff(["twitch"]);
expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
await env.controller.tickAndHandOff(["twitch"]);
expect(env.twitch.discoverCampaigns).toHaveBeenCalledOnce();
expect(env.settings.platform.twitch.enabled).toBe(true);
```

Assert both semantic health changes publish `auth_health_changed` activity events.

- [ ] **Step 2: Verify the tests fail because tick does not probe**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Expected: FAIL because tick uses stale/default health and does not perform the expected probe/recovery.

- [ ] **Step 3: Extract the probe and refresh selected platforms under the state lock**

Extract the body shared by `checkAuthHealth` and `tick`:

```ts
async function probeAuthHealth(
  platform: Platform,
  settings: S,
  adapter: PlatformAdapter,
): Promise<PlatformAuthHealth> {
  const availability = await deps.checkCredentialAvailability?.(platform);
  if (availability?.status === "missing") return missingCredentialHealth();
  if (availability?.status === "unavailable") return credentialLookupUnavailableHealth();
  return adapter.checkAuthHealth();
}
```

At the start of the locked tick, create adapters once, probe only requested/enabled platforms, apply every result with `applyPlatformAuthHealth`, emit transition events, and pass the updated state to `runSchedulerTick`. Disabled platforms retain current disabled cleanup semantics and need no authenticated request.

Ensure `checkAuthHealth(platform)` reuses the helper without recursively acquiring the state lock.

- [ ] **Step 4: Run controller and scheduler tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit automatic auth refresh and recovery**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(controller): refresh auth health before scheduler ticks"
```

### Task 3: Convert mid-tick auth failures instead of swallowing them

**Files:**
- Modify: `packages/core/src/core/fetchError.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/fetchError.test.ts`
- Test: `packages/extension/tests/adapters.test.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Produces: `authHealthFromError(error: unknown, checkedAt?: string): PlatformAuthHealth | undefined` in `fetchError.ts`.
- Consumes: sanitized `SafeFetchError.failure`; Twitch converts credential GQL failure into a compatible sanitized error at its request boundary.

- [ ] **Step 1: Write failing classifier tests**

Test exact mappings:

```ts
expect(authHealthFromError(new SafeFetchError({ kind: "authentication_rejected", status: 401 })))
  .toMatchObject({ status: "invalid_credentials", reasonCode: "credentials_rejected" });
expect(authHealthFromError(new SafeFetchError({ kind: "security_policy_blocked", reference: "safe-ref" })))
  .toMatchObject({
    status: "blocked",
    reasonCode: "security_policy_blocked",
    message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
  });
expect(authHealthFromError(new Error("ordinary failure"))).toBeUndefined();
```

Add scheduler tests for progress, challenges, and claims throwing classified auth errors. Assert health changes, `auth_health_changed` is present, the session suspends, and `errorChecks`/`retryAfter` do not advance. Add a normal `SafeFetchError({ kind: "http_error", status: 503 })` case proving ordinary backoff remains.

- [ ] **Step 2: Verify classifier and scheduler tests fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- fetchError.test.ts scheduler.test.ts adapters.test.ts
```

Expected: FAIL because no classifier exists and Kick progress/challenges still swallow classified failures.

- [ ] **Step 3: Implement the sanitized classifier**

In `fetchError.ts`, return `undefined` for non-auth failures and map only authentication rejection and security-policy blocking:

```ts
export function authHealthFromError(error: unknown, checkedAt = new Date().toISOString()): PlatformAuthHealth | undefined {
  if (!isSafeFetchError(error)) return undefined;
  if (error.failure.kind === "authentication_rejected") {
    return {
      status: "invalid_credentials",
      checkedAt,
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };
  }
  if (error.failure.kind === "security_policy_blocked") {
    const reference = error.failure.reference;
    return {
      status: "blocked",
      checkedAt,
      reasonCode: "security_policy_blocked",
      message: {
        key: "authSecurityPolicyBlocked",
        ...(reference === undefined ? {} : { values: { reference } }),
      },
    };
  }
  return undefined;
}
```

At platform boundaries, preserve classified `SafeFetchError`s. In Kick `readProgress` and `claimChallenges`, rethrow when `authHealthFromError(error)` is defined; keep existing best-effort behavior for ordinary failures. Convert Twitch credential rejection into `SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "Authenticated session rejected" })` without including response bodies or tokens.

- [ ] **Step 4: Handle classified failures in the scheduler catch path**

Before ordinary backoff, apply classified health and construct the same paused/cleared auth-blocked state as Task 1. Emit the transition returned by `applyPlatformAuthHealth`. Extract a small `suspendForAuthentication(...)` helper so the preflight gate and mid-tick catch cannot drift.

- [ ] **Step 5: Run focused tests to green**

Run:

```bash
pnpm --filter @lurkloot/extension test -- fetchError.test.ts scheduler.test.ts adapters.test.ts
```

Expected: PASS, including the invalid-token, WAF-blocked, swallowed-progress, swallowed-challenge, and transient-failure cases.

- [ ] **Step 6: Commit mid-tick classification**

```bash
git add packages/core/src/core/fetchError.ts packages/core/src/core/scheduler.ts packages/core/src/platforms/kick/index.ts packages/core/src/platforms/twitch/index.ts packages/extension/tests/fetchError.test.ts packages/extension/tests/adapters.test.ts packages/extension/tests/scheduler.test.ts
git commit -m "fix(scheduler): suspend on runtime authentication failures"
```

### Task 4: Stop tabless heartbeats and preserve user-visible transitions

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/activityStorage.test.ts`

**Interfaces:**
- Consumes: `SchedulerState.authHealth[platform].status` and the `authentication_unhealthy` session reason.
- Produces: heartbeat execution that never calls `watcher.tick` unless auth is healthy; activity persistence independent of diagnostic logging.

- [ ] **Step 1: Write failing heartbeat and activity tests**

Start a tabless watcher in the controller harness, transition auth to `invalid_credentials`, then invoke the watch heartbeat. Assert `watcher.stop()` runs, `watcher.tick()` does not run again, and the session is not `watching`.

With `diagnosticLogging: false`, run an invalid-to-healthy sequence and assert both `auth_health_changed` events reach `reportEvents`/activity storage while diagnostic-only events remain filtered.

- [ ] **Step 2: Verify tests fail on the current heartbeat path**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts activityStorage.test.ts
```

Expected: FAIL if a watcher heartbeat can run after auth becomes unhealthy or an auth transition is filtered.

- [ ] **Step 3: Add the heartbeat guard and use normal reconciliation**

Before each watcher tick, require both:

```ts
if (
  nextState.authHealth[platform].status !== "healthy"
  || session.status !== "watching"
  || session.watchMode !== "tabless"
) {
  await watcher.stop();
  tablessWatchers.delete(platform);
  continue;
}
```

Keep auth transition events categorized as `activity`; do not add a diagnostic-logging condition around them.

- [ ] **Step 4: Run controller and activity tests to green**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts activityStorage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit heartbeat coordination**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/activityStorage.test.ts
git commit -m "fix(controller): stop heartbeats when authentication degrades"
```

### Task 5: Verify the complete issue

**Files:**
- Modify only if verification exposes a regression in an already-touched file.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: repository-wide evidence that issue #204 is complete.

- [ ] **Step 1: Run formatting and diff checks**

```bash
git diff --check origin/develop...HEAD
git status --short
```

Expected: no whitespace errors; only intentional files are modified.

- [ ] **Step 2: Run the full repository verification**

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, extension/CLI/site tests, and Chromium/Firefox builds all pass.

- [ ] **Step 3: Review acceptance-criteria coverage**

Confirm tests explicitly demonstrate startup logged out, logout while farming, login recovery, invalid tokens, WAF blocking, transient platform failure, no backoff increment, no account calls while unhealthy, no misleading watching/farming session, and activity events with diagnostic logging disabled.

- [ ] **Step 4: Commit any verification-only corrections**

If verification required corrections, stage only those files and commit with a focused Conventional Commit subject. If no correction was needed, do not create an empty commit.
