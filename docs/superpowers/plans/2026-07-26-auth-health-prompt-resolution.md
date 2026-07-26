# Prompt Authentication Health Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every enabled platform's authentication health resolve and persist independently within a configurable 10-second default deadline after scheduler, startup, install/update, and credential-cookie triggers.

**Architecture:** The controller owns one timeout and `AbortController` per platform probe. It starts requested probes concurrently, then each completed result acquires the existing state lock, reloads current state, applies only its platform transition, and persists before scheduler work begins. The adapter contract carries the abort signal into only the Twitch and Kick identity requests.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest fake timers/deferred promises, WXT WebExtension APIs.

## Global Constraints

- `BackgroundControllerDeps.authProbeTimeoutMs` is internal host configuration and defaults to exactly `10_000` milliseconds.
- Do not add a persisted or user-facing timeout setting.
- Do not add or translate diagnostic messages; existing auth-health message keys are reused.
- Do not apply this timeout to campaign, progress, claim, heartbeat, or other non-auth requests.
- Disabled platforms are skipped.
- Every auth result is persisted through the existing state lock using a freshly loaded state.
- Follow strict test-first development: every production behavior change must first be observed failing in its focused test.

---

## File Map

- `packages/core/src/platforms/adapter.ts`: optional abort-signal contract for auth probes.
- `packages/core/src/platforms/twitch/index.ts`: thread the signal through the CurrentUser GQL request only.
- `packages/core/src/platforms/kick/index.ts`: thread the signal through the `/api/v1/user` request only.
- `packages/core/src/background/controller.ts`: timeout, concurrent refresh orchestration, early locked persistence, scheduler/startup integration.
- `packages/extension/entrypoints/background.ts`: route credential-cookie rechecks to bounded auth refresh rather than a scheduler tick.
- `packages/extension/tests/adapters.test.ts`: observable adapter signal forwarding tests.
- `packages/extension/tests/backgroundController.test.ts`: concurrency, timeout, persistence, locking, scheduler ordering, and lifecycle tests.
- `packages/extension/tests/credentialObserver.test.ts`: retain debounce behavior; no production observer changes are expected.

### Task 1: Carry cancellation into platform identity requests

**Files:**
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: existing `PageFetcher.fetchJson<T>(url, init?, emit?)`.
- Produces: `PlatformAdapter.checkAuthHealth(signal?: AbortSignal): Promise<PlatformAuthHealth>`.
- Produces: a final optional `signal?: AbortSignal` argument on the internal `TwitchGqlTransport` call signature and `createTwitchGqlTransport` implementation.

- [ ] **Step 1: Write failing adapter tests for auth-only signal forwarding**

Add one Twitch and one Kick test beside the existing auth-health adapter tests. The production mutation each test catches is dropping the supplied signal before the identity fetch.

```ts
it("passes the auth probe signal to the Twitch CurrentUser request", async () => {
  const abort = new AbortController();
  const fetchJson = vi.fn(async () => ({ data: { currentUser: { id: "u" } } }));

  await new TwitchAdapter({ fetchJson }).checkAuthHealth(abort.signal);

  expect(fetchJson).toHaveBeenCalledWith(
    "https://gql.twitch.tv/gql",
    expect.objectContaining({ signal: abort.signal }),
    expect.any(Function),
  );
});

it("passes the auth probe signal to the Kick identity request", async () => {
  const abort = new AbortController();
  const fetchJson = vi.fn(async () => ({ id: 42 }));

  await new KickAdapter({ fetchJson }).checkAuthHealth(abort.signal);

  expect(fetchJson).toHaveBeenCalledWith(
    "https://kick.com/api/v1/user",
    { signal: abort.signal },
    expect.any(Function),
  );
});
```

Construct both adapters with an explicit `emit = vi.fn()` and assert that same
function as the third argument. This keeps the test focused on the real adapter
boundary rather than an anonymous default.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts
```

Expected: both new tests fail because `checkAuthHealth` accepts no signal and neither request contains one.

- [ ] **Step 3: Extend the adapter contract and Kick identity request**

Change the shared interface and Kick implementation:

```ts
export interface PlatformAdapter {
  platform: Platform;
  readonly compatibility?: ResolvedCompatibility[Platform];
  checkAuthHealth(signal?: AbortSignal): Promise<PlatformAuthHealth>;
  discoverCampaigns(): Promise<DropCampaign[]>;
  readProgress(campaigns: DropCampaign[], session?: WatchSession): Promise<DropCampaign[]>;
  // Retain the remaining existing PlatformAdapter methods verbatim.
}
```

```ts
async checkAuthHealth(signal?: AbortSignal): Promise<PlatformAuthHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const response = await this.fetcher.fetchJson<KickIdentityResponse>(
      "https://kick.com/api/v1/user",
      signal ? { signal } : undefined,
      this.emit,
    );
    if (hasKickIdentity(response)) return { status: "healthy", checkedAt };
    return {
      status: "unavailable",
      checkedAt,
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    };
  }
}
```

Keep `undefined` when no signal is supplied so existing request shapes and tests do not change.

- [ ] **Step 4: Thread the signal through Twitch GQL without affecting other operations**

Add an optional final signal parameter to `TwitchGqlTransport`, its factory implementation, and its request builder:

```ts
type TwitchGqlTransport = <T>(
  operationName: string,
  sha256Hash: string,
  variables: Record<string, unknown>,
  query?: string,
  credentials?: RequestCredentials,
  emit?: EventEmitter,
  signal?: AbortSignal,
) => Promise<TwitchGqlResponse<T>>;
```

```ts
const buildRequest = (queryText?: string) => ({
  method: "POST",
  headers: {
    "Accept": "*/*",
    "Accept-Language": "en-US",
    "Content-Type": "text/plain; charset=UTF-8",
    "Client-ID": clientId,
    ...(userAgent ? { "User-Agent": userAgent } : {}),
  },
  ...(credentials ? { credentials } : {}),
  ...(signal ? { signal } : {}),
  body: JSON.stringify(
    queryText
      ? { operationName, variables, query: queryText }
      : {
          operationName,
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash } },
        },
  ),
} satisfies RequestInit);
```

Pass the signal only from `TwitchAdapter.checkAuthHealth`:

```ts
async checkAuthHealth(signal?: AbortSignal): Promise<PlatformAuthHealth> {
  const response = await this.gqlTransport(
    "CurrentUser",
    "",
    {},
    CURRENT_USER_QUERY,
    undefined,
    this.emit,
    signal,
  );
  if (response.data?.currentUser) {
    return { status: "healthy", checkedAt, message: { key: "authHealthy" } };
  }
  return {
    status: "invalid_credentials",
    checkedAt,
    reasonCode: "credentials_rejected",
    message: { key: "authInvalidCredentials" },
  };
}
```

- [ ] **Step 5: Run focused adapter tests and typechecks**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts
pnpm typecheck
```

Expected: focused tests pass and every package typechecks. Existing mock adapters remain valid because the parameter is optional.

- [ ] **Step 6: Commit the adapter contract**

```bash
git add packages/core/src/platforms/adapter.ts packages/core/src/platforms/twitch/index.ts packages/core/src/platforms/kick/index.ts packages/extension/tests/adapters.test.ts
git commit -m "feat(core): cancel timed out auth requests"
```

### Task 2: Resolve and persist platform probes concurrently

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `PlatformAdapter.checkAuthHealth(signal?: AbortSignal)`.
- Produces: `BackgroundControllerDeps.authProbeTimeoutMs?: number`.
- Produces: controller method `checkAuthHealth(platform: Platform): Promise<void>` as the public bounded platform-local refresh entrypoint.
- Internal helper: `refreshAuthHealth(platforms: Platform[], settings?: S): Promise<void>`.

- [ ] **Step 1: Extend the controller test harness for deferred probes and timeout configuration**

Add `authProbeTimeoutMs?: number` to the harness overrides and pass it into controller dependencies only when defined:

```ts
overrides: {
  saveState?: (state: SchedulerState) => Promise<void>;
  reportEvents?: (events: readonly EngineEvent[]) => Promise<void>;
  stopPageContextTabs?: StopPageContextTabs;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  checkCredentialAvailability?: (platform: Platform) => Promise<CredentialAvailability>;
  authProbeTimeoutMs?: number;
} = {},
```

```ts
...(overrides.authProbeTimeoutMs === undefined
  ? {}
  : { authProbeTimeoutMs: overrides.authProbeTimeoutMs }),
```

Use a local deferred helper in the test file:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
```

- [ ] **Step 2: Write the failing concurrency and early-persistence test**

The production mutation this catches is awaiting Twitch before starting or persisting Kick.

```ts
it("starts enabled auth probes concurrently and persists each before scheduler work", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: true });
  const twitchHealth = deferred<PlatformAuthHealth>();
  const kickHealth = deferred<PlatformAuthHealth>();
  vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(twitchHealth.promise);
  vi.mocked(env.kick.checkAuthHealth).mockReturnValue(kickHealth.promise);

  const ticking = env.controller.tick();
  await vi.waitFor(() => {
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
  });

  kickHealth.resolve({
    status: "healthy",
    checkedAt: "2026-07-26T12:00:00.000Z",
  });
  await vi.waitFor(() => expect(env.state.authHealth.kick.status).toBe("healthy"));

  expect(env.state.authHealth.twitch.status).toBe("checking");
  expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  expect(env.kick.discoverCampaigns).not.toHaveBeenCalled();

  twitchHealth.resolve({
    status: "healthy",
    checkedAt: "2026-07-26T12:00:01.000Z",
  });
  await ticking;

  expect(env.twitch.discoverCampaigns).toHaveBeenCalledOnce();
  expect(env.kick.discoverCampaigns).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Run the concurrency test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "starts enabled auth probes concurrently"
```

Expected: Kick is not started or cannot persist while Twitch is pending.

- [ ] **Step 4: Add configurable timeout and terminal timeout mapping**

Add the dependency and default:

```ts
export interface BackgroundControllerDeps<S extends EngineSettings = EngineSettings> {
  loadSettings(): Promise<S>;
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  authProbeTimeoutMs?: number;
  // Retain the remaining existing host dependencies verbatim.
}

const DEFAULT_AUTH_PROBE_TIMEOUT_MS = 10_000;
```

Refactor `probeAuthHealth` to own an `AbortController`, start the full credential-plus-adapter operation, and race it against the deadline:

```ts
async function probeAuthHealth(
  platform: Platform,
  adapter: PlatformAdapter,
): Promise<PlatformAuthHealth> {
  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const terminalProbe = (async (): Promise<PlatformAuthHealth> => {
    try {
      const availability = await deps.checkCredentialAvailability?.(platform);
      if (availability?.status === "missing") {
        return {
          status: "missing_credentials",
          checkedAt: new Date().toISOString(),
          reasonCode: "credentials_missing",
          message: { key: "authMissingCredentials" },
        };
      }
      if (availability?.status === "unavailable") {
        return {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          reasonCode: "credential_lookup_failed",
          message: { key: "authCredentialLookupFailed" },
        };
      }
      return await adapter.checkAuthHealth(abort.signal);
    } catch {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        reasonCode: "credential_lookup_failed",
        message: { key: "authCredentialLookupFailed" },
      };
    }
  })();
  const timedOut = new Promise<PlatformAuthHealth>((resolve) => {
    timeout = setTimeout(() => {
      abort.abort();
      resolve({
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        reasonCode: "network_unavailable",
        message: { key: "authNetworkUnavailable" },
      });
    }, deps.authProbeTimeoutMs ?? DEFAULT_AUTH_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([terminalProbe, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
```

Keep the operation promise internally caught so a rejection arriving after timeout cannot become unhandled.

- [ ] **Step 5: Add concurrent refresh with per-result locked persistence**

Extract persistence from `checkAuthHealth`:

```ts
async function persistAuthHealth(
  platform: Platform,
  health: PlatformAuthHealth,
): Promise<void> {
  await withStateLock(() => withEventCollector(async (emit, events) => {
    const state = await deps.loadState();
    const transition = applyPlatformAuthHealth(state, platform, health);
    if (transition.event) emit(transition.event);
    await persistAndReport(transition.state, events);
  }));
}

async function refreshAuthHealth(platforms: Platform[], loadedSettings?: S): Promise<void> {
  const settings = loadedSettings ?? await deps.loadSettings();
  const enabled = platforms.filter((platform) => settings.platform[platform].enabled);
  await Promise.all(enabled.map(async (platform) => {
    const collector = withEventCollector(async (emit, events) => {
      const adapter = deps.createAdapters(emit, settings).adapters[platform];
      const health = await probeAuthHealth(platform, adapter);
      await reportBestEffort(events);
      return health;
    });
    await persistAuthHealth(platform, await collector);
  }));
}

async function checkAuthHealth(platform: Platform): Promise<void> {
  await refreshAuthHealth([platform]);
}
```

If compatibility diagnostics emitted during adapter creation must be reported atomically with the auth transition, fold adapter creation and probe events into `persistAuthHealth`'s event collector while keeping the network await outside `withStateLock`. Do not hold the state lock during credential or network work.

- [ ] **Step 6: Move scheduler auth work before the scheduler state lock**

At the beginning of `tick`, load settings and refresh only when farming is running:

```ts
async function tick(platforms?: Platform[]): Promise<ClaimedRewards> {
  const claimedRewards: ClaimedRewards = {};
  const settings = await deps.loadSettings();
  if (settings.running) {
    await refreshAuthHealth(platforms ?? PLATFORMS, settings);
  }
  await withStateLock(() => withEventCollector(async (emit, events) => {
    const settings = await deps.loadSettings();
    const state = await deps.loadState();
    const adapters = createAdapters(settings, emit);
    const result = await runSchedulerTick(state, settings, adapters, {
      ...(platforms ? { platforms } : {}),
      stopPageContextTabs: deps.stopPageContextTabs,
      waitingClaimRewardIds: nextWaitingClaimRewardIds,
      emit: claimObservingEmit,
    });
    // Retain notification, ad-focus, watcher reconciliation, rollback, and
    // final persistence logic after this call.
  }));
  return claimedRewards;
}
```

Delete `probedHealth` and its rollback reapplication. The locked scheduler phase now loads already persisted auth state, so its existing rollback baseline contains the terminal values.

- [ ] **Step 7: Run the concurrency test and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "starts enabled auth probes concurrently"
```

Expected: PASS.

- [ ] **Step 8: Write the failing timeout and cancellation tests**

The mutations these catch are ignoring the configured deadline, sharing a timer between platforms, or failing to abort the request.

```ts
it("times out and aborts a stalled auth probe at the configured deadline", async () => {
  vi.useFakeTimers();
  try {
    const env = harness(
      { ...DEFAULT_SETTINGS, running: false },
      { authProbeTimeoutMs: 25 },
    );
    let signal: AbortSignal | undefined;
    vi.mocked(env.twitch.checkAuthHealth).mockImplementation((nextSignal) => {
      signal = nextSignal;
      return new Promise(() => undefined);
    });

    const checking = env.controller.checkAuthHealth("twitch");
    await vi.advanceTimersByTimeAsync(24);
    expect(env.state.authHealth.twitch.status).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    await checking;

    expect(signal?.aborted).toBe(true);
    expect(env.state.authHealth.twitch).toMatchObject({
      status: "unavailable",
      reasonCode: "network_unavailable",
      message: { key: "authNetworkUnavailable" },
    });
  } finally {
    vi.useRealTimers();
  }
});
```

Add a second test where Kick resolves immediately and Twitch never resolves; assert Kick is persisted before advancing Twitch's deadline and that the overall refresh finishes after exactly the configured deadline.

Add a late-settlement test whose deferred adapter rejects after the timeout; attach an `unhandledRejection` spy only if Vitest exposes a deterministic repository pattern. Otherwise prove single settlement by asserting `saveState` and auth transition event counts remain unchanged after rejecting and flushing promises.

- [ ] **Step 9: Run timeout tests and verify RED, then GREEN**

Run before implementing/refining:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "times out and aborts|does not delay|settles once"
```

Expected RED: the old controller has no deadline or signal.

After completing the minimal timeout code, rerun the same command.

Expected GREEN: all new timeout tests pass without warnings or unhandled rejections.

- [ ] **Step 10: Write and pass a lock-safe merge regression test**

The mutation this catches is persisting auth from a stale state loaded before its network probe.

```ts
it("merges a completed auth probe into state written while the probe was pending", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: false });
  const health = deferred<PlatformAuthHealth>();
  vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(health.promise);

  const checking = env.controller.checkAuthHealth("twitch");
  await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce());

  env.state.sessions.kick = {
    platform: "kick",
    status: "watching",
    channel: channel("kick"),
    offlineChecks: 0,
    tabId: 20,
    tabManagedByExtension: true,
  };
  await env.controller.handleMessage({
    type: "playbackTelemetry",
    platform: "kick",
    telemetry: {
      videoCount: 1,
      mutedVideoCount: 1,
      unmutedVideoCount: 0,
      playingVideoCount: 1,
      blockedPlaybackCount: 0,
      documentHidden: true,
      readyState: 4,
      currentTime: 12,
      duration: 1200,
    },
  }, { tab: { id: 20 } });
  health.resolve({ status: "healthy", checkedAt: "2026-07-26T12:00:01.000Z" });
  await checking;

  expect(env.state.authHealth.twitch.status).toBe("healthy");
  expect(env.state.sessions.kick.playback?.videoCount).toBe(1);
});
```

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "merges a completed auth probe"
```

Expected: RED if auth uses a pre-probe snapshot, then GREEN with load-modify-save inside `withStateLock`.

- [ ] **Step 11: Run the complete controller suite**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Expected: PASS, including existing rollback, telemetry, heartbeat, settings, and authentication tests.

- [ ] **Step 12: Commit controller orchestration**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(controller): persist auth health promptly"
```

### Task 3: Refresh auth on stopped-farming lifecycle triggers

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/credentialObserver.test.ts` only if callback semantics need clarification; otherwise leave it unchanged.

**Interfaces:**
- Consumes: bounded `checkAuthHealth(platform)` and internal `refreshAuthHealth(platforms, settings?)`.
- Produces: `ensureAlarm()` and `handleStartup()` refresh enabled auth while stopped.
- Produces: credential observer `recheck` calls `controller.checkAuthHealth(platform)`.

- [ ] **Step 1: Write failing stopped-farming lifecycle tests**

The mutations these catch are retaining the old `running` guard or forgetting one lifecycle entrypoint.

```ts
it("refreshes enabled auth health from ensureAlarm while farming is stopped", async () => {
  const env = harness({
    ...DEFAULT_SETTINGS,
    running: false,
    platform: {
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
      kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
    },
  });

  await env.controller.ensureAlarm();

  expect(env.state.authHealth.twitch.status).toBe("healthy");
  expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
  expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
  expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
});

it("refreshes enabled auth health on startup without starting farming", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: false });

  await env.controller.handleStartup();

  expect(env.state.authHealth.twitch.status).toBe("healthy");
  expect(env.state.authHealth.kick.status).toBe("healthy");
  expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  expect(env.kick.discoverCampaigns).not.toHaveBeenCalled();
});
```

Add an auto-start assertion showing each adapter is probed exactly once when `ensureAlarm` or `handleStartup` delegates to `tick`.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "refreshes enabled auth health from ensureAlarm|refreshes enabled auth health on startup"
```

Expected: stopped-farming paths do not invoke adapter auth checks.

- [ ] **Step 3: Integrate refresh into `ensureAlarm` without duplicate probes**

Use these mutually exclusive branches:

```ts
async function ensureAlarm(): Promise<void> {
  const settings = await deps.loadSettings();
  await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
  await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
  if (settings.autoStartDropFarming && settings.running) {
    await tick();
  } else {
    await refreshAuthHealth(PLATFORMS, settings);
  }
}
```

- [ ] **Step 4: Integrate refresh into every `handleStartup` exit path**

Restructure `handleStartup` so startup cleanup and running-setting changes remain unchanged, but exactly one of these happens before returning:

- auto-start path: `await tick()`, which owns auth refresh;
- non-auto-start path: `await refreshAuthHealth(PLATFORMS, nextSettings)`.

Do not add refresh calls before branches that later call `tick`, and do not start campaign discovery when `running` is false.

- [ ] **Step 5: Run lifecycle tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "ensureAlarm|startup|auto-start"
```

Expected: new and existing lifecycle tests pass, and auto-start performs one probe per enabled platform.

- [ ] **Step 6: Change credential recheck wiring**

In `packages/extension/entrypoints/background.ts`:

```ts
createCredentialObserver({
  onChanged: {
    addListener: (listener) => browser.cookies.onChanged.addListener(listener),
    removeListener: (listener) => browser.cookies.onChanged.removeListener(listener),
  },
  invalidate: (platform) => controller.invalidateAuthHealth(platform),
  recheck: (platform) => controller.checkAuthHealth(platform),
});
```

Do not change `credentialObserver.ts`: it already invalidates immediately, debounces independently per platform, and contains rejected callbacks.
This is a one-line host composition change rather than new branching logic; its
behavior is covered by the observer's real debounce tests plus the controller's
bounded platform-local refresh tests.

- [ ] **Step 7: Run focused lifecycle and observer suites**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts credentialObserver.test.ts
pnpm typecheck
```

Expected: PASS with no new warnings.

- [ ] **Step 8: Commit lifecycle integration**

```bash
git add packages/core/src/background/controller.ts packages/extension/entrypoints/background.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/credentialObserver.test.ts
git commit -m "fix(extension): refresh auth health on lifecycle triggers"
```

### Task 4: Verify issue #275 end to end

**Files:**
- Modify only files needed to correct verification failures caused by Tasks 1–3.

**Interfaces:**
- Consumes: all prior task contracts.
- Produces: a clean, release-ready branch satisfying issue #275.

- [ ] **Step 1: Run formatting and diff checks**

```bash
git diff --check origin/develop...HEAD
git status --short
```

Expected: no whitespace errors and only intended tracked changes.

- [ ] **Step 2: Run all workspace tests and typechecks**

```bash
pnpm test
pnpm typecheck
```

Expected: all CLI, extension, and site tests pass; all workspace packages typecheck.

- [ ] **Step 3: Run the full repository check**

```bash
pnpm check
```

Expected: script tests, typechecks, extension tests, and Astro build all pass. The existing Astro chunk-size warning is acceptable; new warnings are not.

- [ ] **Step 4: Review acceptance coverage**

Confirm each behavior from issue #275 has a named passing test:

- concurrent Twitch/Kick start;
- per-platform early persistence;
- configured timeout and terminal `network_unavailable`;
- abort signal reaches each identity request;
- one stalled platform does not delay the other platform's visible health;
- scheduler discovery waits for terminal auth;
- startup and `ensureAlarm` refresh while stopped;
- cookie recheck uses bounded auth-only refresh;
- fresh locked state preserves telemetry and scheduler rollback state;
- late timeout settlement persists once.

- [ ] **Step 5: Commit any verification-only corrections**

If verification required source changes, first add a failing regression test, then make it pass and commit only those corrections:

```bash
git add packages/core/src/background/controller.ts packages/core/src/platforms/adapter.ts packages/core/src/platforms/twitch/index.ts packages/core/src/platforms/kick/index.ts packages/extension/entrypoints/background.ts packages/extension/tests/adapters.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "test(controller): cover auth refresh regressions"
```

If no corrections were required, do not create an empty commit.
