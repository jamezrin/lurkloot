# Platform Session Credential Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add credential-safe Twitch/Kick cookie preflights and a filtered, debounced cookie observer that invalidates platform authentication health and triggers a platform-only scheduler cycle.

**Architecture:** The browser-free controller receives an optional value-only credential-availability callback and owns safe health transitions. Extension modules perform cookie lookup and cookie-change filtering without returning values, while `background.ts` wires those modules to the controller. Cookie presence advances to the adapter probe but never marks authentication healthy.

**Tech Stack:** TypeScript 7, WXT WebExtension APIs, Vitest 4, pnpm workspace scripts.

## Global Constraints

- Work only in `.worktrees/observe-platform-session-credentials` on `feat/observe-platform-session-credentials`.
- Twitch requires `auth-token`; `unique_id` is supporting metadata and must not prove login.
- Kick requires `session_token`.
- Cookie lookup failures must map to `unavailable` / `credential_lookup_failed`, not missing credentials.
- Cookie values must never enter core state, snapshots, activity history, diagnostics, logs, errors, hashes, or callback arguments.
- Cookie presence is only a preflight; only #202/#203 may mark an authenticated platform `healthy`.
- Cookie changes invalidate health immediately and debounce a platform-only `tickAndHandOff([platform])` call.
- `@lurkloot/core` must not import WXT or browser globals, and no new extension permission is needed.

---

## File Map

- Modify `packages/core/src/background/controller.ts`: define the browser-neutral availability contract, preflight adapter health checks, and expose safe cached-health invalidation.
- Modify `packages/extension/tests/backgroundController.test.ts`: verify preflight mapping, adapter short-circuiting, state isolation, transition safety, and omitted-dependency compatibility.
- Create `packages/extension/src/core/credentialAvailability.ts`: read only the required browser cookie and return a value-free availability result.
- Create `packages/extension/tests/credentialAvailability.test.ts`: cover presence, absence, empty values, lookup failure, and secret non-disclosure.
- Create `packages/extension/src/core/credentialObserver.ts`: filter credential-cookie events, invalidate immediately, debounce per platform, and dispose cleanly.
- Create `packages/extension/tests/credentialObserver.test.ts`: cover login/logout/replacement metadata, filtering, coalescing, platform independence, rejection containment, and disposal.
- Modify `packages/extension/entrypoints/background.ts`: inject the provider, register the observer, and dispose it with the WXT background lifecycle.
- Modify `packages/extension/tests/coreBoundary.test.ts`: retain the explicit browser-free core import guard for the new contract.

---

### Task 1: Controller Credential Preflight and Invalidation

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Produces: `export type CredentialAvailability = { status: "available" } | { status: "missing" } | { status: "unavailable" }`.
- Produces: optional `BackgroundControllerDeps.checkCredentialAvailability(platform: Platform): Promise<CredentialAvailability>`.
- Produces: `controller.invalidateAuthHealth(platform: Platform): Promise<void>`.
- Changes: `controller.checkAuthHealth(platform)` short-circuits the adapter for `missing` and `unavailable`.

- [ ] **Step 1: Add failing controller preflight tests**

Extend the test harness override type and dependency construction:

```ts
import type { CredentialAvailability } from "@lurkloot/core/controller";

// In harness overrides:
checkCredentialAvailability?: (platform: Platform) => Promise<CredentialAvailability>;

// In deps, only when supplied:
...(overrides.checkCredentialAvailability
  ? { checkCredentialAvailability: vi.fn(overrides.checkCredentialAvailability) }
  : {}),
```

Add focused tests asserting:

```ts
it("reports missing credentials without calling the platform probe", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: false }, {
    checkCredentialAvailability: async () => ({ status: "missing" }),
  });

  await env.controller.checkAuthHealth("twitch");

  expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
  expect(env.state.authHealth.twitch).toEqual(expect.objectContaining({
    status: "missing_credentials",
    reasonCode: "credentials_missing",
  }));
});

it("reports credential lookup failure without calling the platform probe", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: false }, {
    checkCredentialAvailability: async () => ({ status: "unavailable" }),
  });

  await env.controller.checkAuthHealth("kick");

  expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
  expect(env.state.authHealth.kick).toEqual(expect.objectContaining({
    status: "unavailable",
    reasonCode: "credential_lookup_failed",
  }));
});

it("continues to the authenticated probe when credentials are available", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: false }, {
    checkCredentialAvailability: async () => ({ status: "available" }),
  });
  vi.mocked(env.twitch.checkAuthHealth).mockResolvedValueOnce({ status: "checking" });

  await env.controller.checkAuthHealth("twitch");

  expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
  expect(env.state.authHealth.twitch.status).toBe("checking");
});
```

Also preserve the existing test as coverage that omitting the dependency calls the adapter directly.

- [ ] **Step 2: Add failing invalidation tests**

Add tests that seed both platforms with non-checking health, call `invalidateAuthHealth("twitch")`, and assert Twitch becomes exactly `{ status: "checking" }`, Kick and unrelated state remain unchanged, a safe transition is reported once, and a second invalidation creates no repeated event.

```ts
await env.controller.invalidateAuthHealth("twitch");
expect(env.state.authHealth.twitch).toEqual({ status: "checking" });
expect(env.state.authHealth.kick).toEqual(previousKickHealth);
expect(JSON.stringify(env.reportEvents.mock.calls)).not.toContain("secret");
```

- [ ] **Step 3: Run the focused tests and verify the new API is missing**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts`

Expected: FAIL because `CredentialAvailability`, `checkCredentialAvailability`, and `invalidateAuthHealth` do not exist.

- [ ] **Step 4: Implement the minimal controller contract**

Add near `BackgroundControllerDeps`:

```ts
export type CredentialAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unavailable" };
```

Add the optional dependency:

```ts
checkCredentialAvailability?(platform: Platform): Promise<CredentialAvailability>;
```

Refactor `checkAuthHealth` to choose a safe health result before the existing transition call:

```ts
const availability = await deps.checkCredentialAvailability?.(platform);
const health = availability?.status === "missing"
  ? {
      status: "missing_credentials" as const,
      checkedAt: new Date().toISOString(),
      reasonCode: "credentials_missing" as const,
      message: { key: "authMissingCredentials" as const },
    }
  : availability?.status === "unavailable"
    ? {
        status: "unavailable" as const,
        checkedAt: new Date().toISOString(),
        reasonCode: "credential_lookup_failed" as const,
        message: { key: "authCredentialLookupFailed" as const },
      }
    : await adapter.checkAuthHealth();
const transition = applyPlatformAuthHealth(state, platform, health);
```

Add an invalidation method under the state lock:

```ts
async function invalidateAuthHealth(platform: Platform): Promise<void> {
  await withStateLock(() => withEventCollector(async (emit, events) => {
    const state = await deps.loadState();
    const transition = applyPlatformAuthHealth(state, platform, { status: "checking" });
    if (transition.event) emit(transition.event);
    await persistAndReport(transition.state, events);
  }));
}
```

Return `invalidateAuthHealth` from the controller.

- [ ] **Step 5: Run controller tests and typechecking**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts && pnpm --filter @lurkloot/core typecheck`

Expected: all focused tests pass and core typechecking exits 0.

- [ ] **Step 6: Commit the controller boundary**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): preflight platform credential availability"
```

---

### Task 2: Extension Credential Availability Provider

**Files:**
- Create: `packages/extension/src/core/credentialAvailability.ts`
- Create: `packages/extension/tests/credentialAvailability.test.ts`

**Interfaces:**
- Consumes: `CredentialAvailability` from `@lurkloot/core/controller`.
- Produces: `createCredentialAvailabilityProvider(cookieApi): (platform: Platform) => Promise<CredentialAvailability>`.
- Cookie API input: `{ get(details: { url: string; name: string }): Promise<{ value?: string } | null> }`.

- [ ] **Step 1: Write failing provider tests**

Create table-driven Vitest coverage with a mocked `get` function:

```ts
it.each([
  ["twitch", "https://www.twitch.tv", "auth-token"],
  ["kick", "https://kick.com", "session_token"],
] as const)("reports %s credentials without returning their value", async (platform, url, name) => {
  const get = vi.fn(async () => ({ value: "credential-secret" }));
  const check = createCredentialAvailabilityProvider({ get });

  const result = await check(platform);

  expect(get).toHaveBeenCalledWith({ url, name });
  expect(result).toEqual({ status: "available" });
  expect(JSON.stringify(result)).not.toContain("credential-secret");
});
```

Add cases for `null`, `{ value: "" }`, and rejected lookup. Assert Twitch makes only the `auth-token` lookup and never requests `unique_id`. Assert serialized results and rejection handling do not contain a sentinel secret.

- [ ] **Step 2: Run provider tests and verify the module is missing**

Run: `pnpm --filter @lurkloot/extension test -- credentialAvailability.test.ts`

Expected: FAIL because `credentialAvailability.ts` does not exist.

- [ ] **Step 3: Implement the provider**

Create the focused module:

```ts
import type { CredentialAvailability } from "@lurkloot/core/controller";
import type { Platform } from "@lurkloot/shared/models";

export interface CredentialCookieApi {
  get(details: { url: string; name: string }): Promise<{ value?: string } | null>;
}

const REQUIRED_COOKIE: Record<Platform, { url: string; name: string }> = {
  twitch: { url: "https://www.twitch.tv", name: "auth-token" },
  kick: { url: "https://kick.com", name: "session_token" },
};

export function createCredentialAvailabilityProvider(api: CredentialCookieApi) {
  return async (platform: Platform): Promise<CredentialAvailability> => {
    try {
      const cookie = await api.get(REQUIRED_COOKIE[platform]);
      return cookie?.value ? { status: "available" } : { status: "missing" };
    } catch {
      return { status: "unavailable" };
    }
  };
}
```

- [ ] **Step 4: Run provider tests and extension typechecking**

Run: `pnpm --filter @lurkloot/extension test -- credentialAvailability.test.ts && pnpm --filter @lurkloot/extension typecheck`

Expected: provider tests pass and extension typechecking exits 0.

- [ ] **Step 5: Commit the extension provider**

```bash
git add packages/extension/src/core/credentialAvailability.ts packages/extension/tests/credentialAvailability.test.ts
git commit -m "feat(extension): detect required session credentials"
```

---

### Task 3: Filtered Per-Platform Cookie Observer

**Files:**
- Create: `packages/extension/src/core/credentialObserver.ts`
- Create: `packages/extension/tests/credentialObserver.test.ts`

**Interfaces:**
- Produces: `createCredentialObserver(deps): () => void`.
- Consumes callbacks: `invalidate(platform): Promise<void>` and `recheck(platform): Promise<void>`.
- Uses only cookie `name` and `domain`; it must never inspect `value`.

- [ ] **Step 1: Write failing filtering and event tests**

Build a fake event with captured listener and tests for added (login), removed (logout), and changed/replaced credential events. Use these representative inputs:

```ts
listener({ cookie: { name: "auth-token", domain: ".twitch.tv", value: "secret" }, removed: false });
listener({ cookie: { name: "session_token", domain: "kick.com", value: "replacement" }, removed: true });
```

Assert the invalidation callback receives only `"twitch"` or `"kick"`, never the event or its value. Add negative cases for `unique_id`, unrelated names, `auth-token` on `example.com`, and `session_token` on `notkick.com`.

- [ ] **Step 2: Write failing debounce, rejection, and disposal tests**

Use `vi.useFakeTimers()` and assert:

```ts
listener(twitchChange);
listener(twitchChange);
listener(twitchChange);
expect(invalidate).toHaveBeenCalledTimes(3);
await vi.advanceTimersByTimeAsync(249);
expect(recheck).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1);
expect(recheck).toHaveBeenCalledOnce();
expect(recheck).toHaveBeenCalledWith("twitch");
```

Trigger Twitch and Kick within the same window and assert one scoped recheck for each. Mock rejected invalidate/recheck promises and confirm no unhandled rejection escapes. Call the disposer, assert `removeListener` receives the registered listener, advance timers, and assert no pending recheck runs.

- [ ] **Step 3: Run observer tests and verify the module is missing**

Run: `pnpm --filter @lurkloot/extension test -- credentialObserver.test.ts`

Expected: FAIL because `credentialObserver.ts` does not exist.

- [ ] **Step 4: Implement exact cookie classification**

Create types that intentionally omit cookie values from the coordinator's needs:

```ts
import type { Platform } from "@lurkloot/shared/models";

interface ObservedCookie { name: string; domain: string }
interface CookieChangeInfo { cookie: ObservedCookie; removed: boolean }
interface CookieChangeEvent {
  addListener(listener: (change: CookieChangeInfo) => void): void;
  removeListener(listener: (change: CookieChangeInfo) => void): void;
}

function normalizedDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

function isDomainOrSubdomain(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

export function credentialPlatform(change: CookieChangeInfo): Platform | undefined {
  const domain = normalizedDomain(change.cookie.domain);
  if (change.cookie.name === "auth-token" && isDomainOrSubdomain(domain, "twitch.tv")) return "twitch";
  if (change.cookie.name === "session_token" && isDomainOrSubdomain(domain, "kick.com")) return "kick";
  return undefined;
}
```

- [ ] **Step 5: Implement per-platform debounce and disposal**

Use a default `250` ms delay, one timer per platform, immediate best-effort invalidation, and best-effort recheck:

```ts
const timers = new Map<Platform, ReturnType<typeof setTimeout>>();
const listener = (change: CookieChangeInfo) => {
  const platform = credentialPlatform(change);
  if (!platform) return;
  void deps.invalidate(platform).catch(() => undefined);
  const current = timers.get(platform);
  if (current) deps.clearTimeout(current);
  timers.set(platform, deps.setTimeout(() => {
    timers.delete(platform);
    void deps.recheck(platform).catch(() => undefined);
  }, deps.debounceMs ?? 250));
};
```

Return a disposer that removes `listener`, clears every timer, and clears the map. Inject `setTimeout` and `clearTimeout` with defaults so tests remain deterministic.

- [ ] **Step 6: Run observer tests and extension typechecking**

Run: `pnpm --filter @lurkloot/extension test -- credentialObserver.test.ts && pnpm --filter @lurkloot/extension typecheck`

Expected: observer tests pass and extension typechecking exits 0.

- [ ] **Step 7: Commit the observer**

```bash
git add packages/extension/src/core/credentialObserver.ts packages/extension/tests/credentialObserver.test.ts
git commit -m "feat(extension): observe session credential changes"
```

---

### Task 4: Background Wiring and Boundary Regression

**Files:**
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/tests/coreBoundary.test.ts`

**Interfaces:**
- Consumes: `createCredentialAvailabilityProvider(browser.cookies)`.
- Consumes: `createCredentialObserver({ onChanged, invalidate, recheck })`.
- Consumes: `controller.invalidateAuthHealth(platform)` and `controller.tickAndHandOff([platform])`.

- [ ] **Step 1: Strengthen the core-boundary test before wiring**

Extend `coreBoundary.test.ts` so its scan continues to reject imports of `wxt`, `wxt/browser`, `browser`, or extension modules from all `packages/core/src/**/*.ts` files. Add an assertion that `controller.ts` contains the value-only `CredentialAvailability` vocabulary but none of `auth-token`, `session_token`, or `browser.cookies`.

- [ ] **Step 2: Run the boundary test**

Run: `pnpm --filter @lurkloot/extension test -- coreBoundary.test.ts`

Expected: PASS before wiring; this locks the architectural boundary.

- [ ] **Step 3: Inject the credential provider into the controller**

Add imports to `background.ts`:

```ts
import { createCredentialAvailabilityProvider } from "../src/core/credentialAvailability";
import { createCredentialObserver } from "../src/core/credentialObserver";
```

Create the provider once before controller construction:

```ts
const checkCredentialAvailability = createCredentialAvailabilityProvider(browser.cookies);
```

Pass it into `createBackgroundController` as `checkCredentialAvailability`.

- [ ] **Step 4: Register and dispose the cookie observer**

Accept the WXT background context and wire only safe platform callbacks:

```ts
export default defineBackground((ctx) => {
  const disposeCredentialObserver = createCredentialObserver({
    onChanged: browser.cookies.onChanged,
    invalidate: (platform) => controller.invalidateAuthHealth(platform),
    recheck: (platform) => controller.tickAndHandOff([platform]),
  });
  ctx.onInvalidated(disposeCredentialObserver);

  // Existing listeners remain unchanged below.
});
```

If WXT's generated type requires an adapter for `browser.cookies.onChanged`, pass `{ addListener, removeListener }` closures rather than widening the observer's value-free event interface.

- [ ] **Step 5: Run focused tests, typechecks, and secret scans**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts credentialAvailability.test.ts credentialObserver.test.ts coreBoundary.test.ts
pnpm typecheck
git diff origin/develop...HEAD | rg -n "cookie\.value|authToken|sessionToken|authorization|Bearer"
```

Expected: focused tests and all workspace typechecks pass. Secret scan output is limited to the existing confirm-gated export and the provider's local truthiness check; no new state, event, diagnostic, log, or callback payload contains a credential.

- [ ] **Step 6: Commit background integration**

```bash
git add packages/extension/entrypoints/background.ts packages/extension/tests/coreBoundary.test.ts
git commit -m "feat(extension): recheck auth after credential changes"
```

---

### Task 5: Full Verification and Acceptance Audit

**Files:**
- Review: all files changed since `origin/develop`

**Interfaces:**
- Verifies all earlier tasks as one extension-to-core flow.

- [ ] **Step 1: Run formatting and patch-integrity checks**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intentional branch changes are present.

- [ ] **Step 2: Run the repository verification suite**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks, Vitest suites, Astro build, and Chromium/Firefox extension builds pass.

- [ ] **Step 3: Audit every issue #201 acceptance criterion**

Run:

```bash
git diff --stat origin/develop...HEAD
git log --oneline origin/develop..HEAD
rg -n "auth-token|session_token|unique_id|credential_lookup_failed|invalidateAuthHealth|tickAndHandOff" packages/core packages/extension
```

Confirm explicitly:

- required-cookie absence short-circuits authenticated probes as `missing_credentials`;
- lookup rejection is `credential_lookup_failed`;
- provider/observer interfaces expose no values;
- relevant events invalidate and debounce only their platform;
- unrelated events do nothing;
- repeated events coalesce;
- tests cover login, logout, replacement, lookup failure, filtering, and debounce.

- [ ] **Step 4: Commit any verification-only correction**

If verification required a correction, stage only those corrected files and commit with a focused Conventional Commit subject. If no correction was needed, do not create an empty commit.

- [ ] **Step 5: Prepare completion handoff**

Report the implementation commits, files changed, exact verification commands and results, and any intentional deferrals to #202–#205. Do not push or open a pull request unless the user separately requests publication.
