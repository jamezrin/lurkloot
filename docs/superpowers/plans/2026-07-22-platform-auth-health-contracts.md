# Platform Authentication Health Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #200 by adding safe, browser-neutral per-platform authentication health state, adapter boundaries, normalization, and durable transition events.

**Architecture:** Shared models define an allowlisted authentication-health document stored inside `SchedulerState`. Core defaults normalize persisted data by reconstruction, while a focused pure transition helper updates state and creates a safe activity event. Platform adapters temporarily return `checking`; later issues replace those stubs with real extension-owned probes.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest, `@lurkloot/shared`, `@lurkloot/core`, WXT extension tests.

## Global Constraints

- This plan implements issue #200 only; browser cookie observation, real Twitch/Kick probes, scheduler gating, and popup rendering remain in #201–#205.
- `@lurkloot/core` must remain browser-free and must not import WXT or browser globals.
- State and events must never contain tokens, cookie values, passwords, authorization headers, authenticated response bodies, complete request URLs, or arbitrary raw errors.
- Persisted health is normalized by allowlist reconstruction, never by spreading untrusted health records.
- Both platforms default to `{ status: "checking" }` with no timestamp.
- Follow red-green-refactor: every production change follows a focused failing test whose expected failure is observed first.

---

### Task 1: Shared authentication-health and activity-event contracts

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/events.ts`
- Test: `packages/extension/tests/eventContract.test.ts`

**Interfaces:**
- Produces: `PlatformAuthStatus`, `PlatformAuthReasonCode`, `PlatformAuthMessageKey`, `PlatformAuthMessage`, and `PlatformAuthHealth` from `@lurkloot/shared/models`.
- Produces: `auth_health_changed` as a discriminated `ActivityEvent` variant with `{ from, to, reason? }`.

- [ ] **Step 1: Write the failing contract test**

Add this test to `eventContract.test.ts` before changing production types:

```ts
import type { PlatformAuthHealth } from "@lurkloot/shared/models";

it("types safe authentication health and durable transitions", () => {
  const health: PlatformAuthHealth = {
    status: "blocked",
    checkedAt: "2026-07-22T12:00:00.000Z",
    reasonCode: "security_policy_blocked",
    message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
  };
  const event: EngineEvent = {
    category: "activity",
    code: "auth_health_changed",
    level: "error",
    platform: "kick",
    data: { from: "checking", to: health.status, reason: health.reasonCode },
  };

  expectTypeOf(health).toMatchTypeOf<PlatformAuthHealth>();
  expectTypeOf(event).toMatchTypeOf<EngineEvent>();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- eventContract.test.ts`

Expected: TypeScript transform fails because `PlatformAuthHealth` and the `auth_health_changed` event variant do not exist.

- [ ] **Step 3: Add the shared model types**

Add the exact types approved in the design to `models.ts`, immediately after `Platform`:

```ts
export type PlatformAuthStatus = "checking" | "healthy" | "missing_credentials" | "invalid_credentials" | "blocked" | "unavailable";
export type PlatformAuthReasonCode = "credentials_missing" | "credentials_rejected" | "security_policy_blocked" | "credential_lookup_failed" | "platform_unavailable" | "network_unavailable";
export type PlatformAuthMessageKey = "authChecking" | "authHealthy" | "authMissingCredentials" | "authInvalidCredentials" | "authSecurityPolicyBlocked" | "authCredentialLookupFailed" | "authPlatformUnavailable" | "authNetworkUnavailable";

export interface PlatformAuthMessage {
  key: PlatformAuthMessageKey;
  values?: Partial<Record<"reference", string | number>>;
}

export interface PlatformAuthHealth {
  status: PlatformAuthStatus;
  checkedAt?: string;
  reasonCode?: PlatformAuthReasonCode;
  message?: PlatformAuthMessage;
}
```

Add `authHealth: Record<Platform, PlatformAuthHealth>` to `SchedulerState`.

- [ ] **Step 4: Add the durable event variant**

Import `PlatformAuthReasonCode` and `PlatformAuthStatus` in `events.ts`, then add:

```ts
| {
    category: "activity";
    code: "auth_health_changed";
    level: "info" | "warn" | "error";
    platform: Platform;
    message?: never;
    data: { from: PlatformAuthStatus; to: PlatformAuthStatus; reason?: PlatformAuthReasonCode };
  }
```

- [ ] **Step 5: Run the focused test and typecheck**

Run: `pnpm --filter @lurkloot/extension test -- eventContract.test.ts && pnpm --filter @lurkloot/shared typecheck`

Expected: the contract test passes; shared typecheck may identify `SchedulerState` constructors that Task 2 must update, but no errors may remain inside shared sources.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/events.ts packages/extension/tests/eventContract.test.ts
git commit -m "feat(shared): model platform auth health"
```

### Task 2: Safe defaults and persisted-state normalization

**Files:**
- Create: `packages/extension/tests/authHealth.test.ts`
- Modify: `packages/core/src/core/defaults.ts`

**Interfaces:**
- Consumes: `PlatformAuthHealth`, `PlatformAuthStatus`, `PlatformAuthReasonCode`, and `SchedulerState.authHealth` from Task 1.
- Produces: `normalizePlatformAuthHealth(value: unknown): PlatformAuthHealth` exported from `@lurkloot/core/defaults`.
- Produces: `DEFAULT_STATE.authHealth` and canonical `mergeSchedulerState(...).authHealth`.

- [ ] **Step 1: Write failing default and migration tests**

Create `authHealth.test.ts` with fixed fixtures asserting:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_STATE, mergeSchedulerState, normalizePlatformAuthHealth } from "@lurkloot/core/defaults";

describe("authentication health normalization", () => {
  it("defaults both platforms to unchecked checking state", () => {
    expect(DEFAULT_STATE.authHealth).toEqual({
      twitch: { status: "checking" },
      kick: { status: "checking" },
    });
    expect(mergeSchedulerState(undefined).authHealth).toEqual(DEFAULT_STATE.authHealth);
  });

  it("adds defaults to legacy state without losing operational data", () => {
    const merged = mergeSchedulerState({ lastTickAt: "2026-07-22T12:00:00.000Z" });
    expect(merged.lastTickAt).toBe("2026-07-22T12:00:00.000Z");
    expect(merged.authHealth).toEqual(DEFAULT_STATE.authHealth);
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts`

Expected: FAIL because the default slice and normalizer do not exist.

- [ ] **Step 3: Implement default state and a minimal normalizer**

Add `authHealth` to `DEFAULT_STATE`. Export `normalizePlatformAuthHealth(value: unknown)` and initially accept known statuses while returning `{ status: "checking" }` for non-records and unknown statuses. Update `mergeSchedulerState` to normalize `stored?.authHealth?.twitch` and `.kick` independently rather than spreading them.

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts`

Expected: the two migration tests pass.

- [ ] **Step 5: Add failing allowlist and security cases**

Add table-driven tests for every valid status/reason pair and tests that assert:

```ts
expect(normalizePlatformAuthHealth({
  status: "blocked",
  checkedAt: "2026-07-22T12:00:00.000Z",
  reasonCode: "security_policy_blocked",
  message: { key: "authSecurityPolicyBlocked", values: { reference: "ref-123", token: "secret" } },
  token: "secret",
  cookie: "secret",
  headers: { authorization: "Bearer secret" },
  response: { account: "private" },
  url: "https://kick.com/?token=secret",
})).toEqual({
  status: "blocked",
  checkedAt: "2026-07-22T12:00:00.000Z",
  reasonCode: "security_policy_blocked",
  message: { key: "authSecurityPolicyBlocked", values: { reference: "ref-123" } },
});
```

Also cover invalid reason/status combinations, non-round-tripping timestamps, unknown message keys, incompatible message keys, nested/array/non-finite values, overlong references, and arbitrary extra fields.

- [ ] **Step 6: Run and verify RED**

Run the same focused test. Expected: FAIL because optional fields are not yet validated and allowlisted.

- [ ] **Step 7: Complete normalization**

Implement constant sets/maps for known statuses, allowed reasons per status, and compatible message keys. Reconstruct a new object field-by-field. Accept `checkedAt` only when `new Date(value).toISOString() === value`; accept `reference` only when it is a finite number or a non-empty string no longer than 128 characters. Omit invalid optional fields and never copy unknown keys.

- [ ] **Step 8: Run focused tests and extension typecheck**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts storageMigration.test.ts && pnpm --filter @lurkloot/extension typecheck`

Expected: focused tests pass. Fix only mechanical `SchedulerState` fixture omissions by basing fixtures on `DEFAULT_STATE`; do not weaken `authHealth` to optional.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/core/defaults.ts packages/extension/tests/authHealth.test.ts packages/extension/tests
git commit -m "feat(core): normalize platform auth health"
```

### Task 3: Browser-neutral adapter probe boundary

**Files:**
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/extension/tests/scheduler.test.ts`
- Test: `packages/extension/tests/authHealth.test.ts`

**Interfaces:**
- Consumes: `PlatformAuthHealth` from Task 1.
- Produces: required `PlatformAdapter.checkAuthHealth(): Promise<PlatformAuthHealth>`.
- Temporary implementation: both production adapters return `{ status: "checking" }` until #202/#203.

- [ ] **Step 1: Write the failing adapter-contract test**

Add a type/runtime fixture to `authHealth.test.ts`:

```ts
import type { PlatformAdapter } from "@lurkloot/core/adapter";

it("requires adapters to expose a browser-neutral auth probe", async () => {
  const probe: PlatformAdapter["checkAuthHealth"] = async () => ({ status: "checking" });
  expect(await probe()).toEqual({ status: "checking" });
});
```

Also instantiate Twitch and Kick adapters using the existing constructors in `adapters.test.ts` and assert `checkAuthHealth()` returns `checking`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts adapters.test.ts`

Expected: type failure because `checkAuthHealth` does not exist.

- [ ] **Step 3: Add the required adapter method and stubs**

Import `PlatformAuthHealth` into `adapter.ts` and add:

```ts
checkAuthHealth(): Promise<PlatformAuthHealth>;
```

Implement this method in `TwitchAdapter` and `KickAdapter`:

```ts
async checkAuthHealth(): Promise<PlatformAuthHealth> {
  return { status: "checking" };
}
```

- [ ] **Step 4: Update typed adapter fixtures mechanically**

Run: `pnpm typecheck`

Add `checkAuthHealth: vi.fn(async () => ({ status: "checking" as const }))` to the `adapter(...)` factories in `backgroundController.test.ts` and `scheduler.test.ts`. Re-run typecheck and update any additional explicitly typed adapter literal with the same stub. Do not change `packages/cli/src/transport/common.ts`, which only transports already-constructed Twitch/Kick adapters, and do not make the production interface optional.

- [ ] **Step 5: Verify focused and workspace checks**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts adapters.test.ts && pnpm typecheck`

Expected: PASS with no browser imports added to core.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/platforms/adapter.ts packages/core/src/platforms/twitch/index.ts packages/core/src/platforms/kick/index.ts packages/extension/tests/adapters.test.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/scheduler.test.ts
git commit -m "feat(core): add authentication probe boundary"
```

### Task 4: Pure auth-health state transitions and durable events

**Files:**
- Create: `packages/core/src/core/authHealth.ts`
- Modify: `packages/core/package.json`
- Test: `packages/extension/tests/authHealth.test.ts`

**Interfaces:**
- Consumes: normalized health contract and `SchedulerState.authHealth`.
- Produces: `applyPlatformAuthHealth(state, platform, candidate): { state: SchedulerState; event?: ActivityEvent }`.
- Semantic equality compares status, reason, and safe message metadata, but ignores `checkedAt`.

- [ ] **Step 1: Write failing transition tests**

Add tests asserting:

```ts
const changed = applyPlatformAuthHealth(DEFAULT_STATE, "kick", {
  status: "blocked",
  checkedAt: "2026-07-22T12:00:00.000Z",
  reasonCode: "security_policy_blocked",
  message: { key: "authSecurityPolicyBlocked", values: { reference: "ref-123" } },
});

expect(changed.state.authHealth.kick).toEqual(expect.objectContaining({ status: "blocked" }));
expect(changed.event).toEqual({
  category: "activity",
  code: "auth_health_changed",
  level: "error",
  platform: "kick",
  data: { from: "checking", to: "blocked", reason: "security_policy_blocked" },
});
expect(JSON.stringify(changed.event)).not.toContain("ref-123");
```

Add cases for all event levels, reason-only/message-key changes, malformed candidates being normalized, and timestamp-only refresh returning `event: undefined` while storing the newer timestamp.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts`

Expected: FAIL because `applyPlatformAuthHealth` does not exist.

- [ ] **Step 3: Implement the pure transition helper**

Create `authHealth.ts`. Normalize the candidate, compare a stable semantic tuple built from status/reason/message key/reference, update only the selected platform slice, and create the activity event without message metadata. Map levels as approved: `info` for `checking`/`healthy`, `warn` for missing/invalid/unavailable, and `error` for blocked.

Add `"./authHealth": "./src/core/authHealth.ts"` to the core export map so tests and later scheduler integration import the helper through an explicit package boundary.

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts eventContract.test.ts`

Expected: all transition and contract cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/authHealth.ts packages/core/package.json packages/extension/tests/authHealth.test.ts
git commit -m "feat(core): record auth health transitions"
```

### Task 5: Controller persistence boundary and final verification

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/coreBoundary.test.ts`

**Interfaces:**
- Consumes: `applyPlatformAuthHealth` and adapter `checkAuthHealth()`.
- Produces: `controller.checkAuthHealth(platform: Platform): Promise<void>`, a platform-only operation that persists normalized health and reports its durable transition event.
- Does not call this operation from scheduler ticks yet; #201/#204 wire triggers and gating.

- [ ] **Step 1: Write failing controller persistence tests**

Extend the background-controller harness so each adapter's probe is a mock. Add cases that call `controller.checkAuthHealth("kick")` and assert:

- only Kick's adapter probe runs;
- normalized state is saved under `authHealth.kick`;
- a semantic transition is reported exactly once through `reportEvents`;
- a second result differing only in `checkedAt` is saved without another activity event;
- a hostile adapter result containing extra secret-bearing fields is stripped before state persistence and never appears in serialized events.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "auth health"`

Expected: FAIL because the controller method does not exist.

- [ ] **Step 3: Implement the controller operation**

Inside `createBackgroundController`, implement the operation under `withStateLock` and `withEventCollector`: load settings/state, construct adapters, await only `adapters[platform].checkAuthHealth()`, apply the pure transition helper, emit its optional event, then call the existing `persistAndReport`. Return `checkAuthHealth` from the public controller object. Do not invoke it automatically from `tick`, startup, or messages in this issue.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- authHealth.test.ts backgroundController.test.ts eventContract.test.ts storageMigration.test.ts coreBoundary.test.ts`

Expected: all focused tests pass, including core boundary enforcement.

- [ ] **Step 5: Run full repository verification**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks, extension tests, site build, and Chromium/Firefox extension builds pass. Record exact test counts and any pre-existing non-failing warnings.

- [ ] **Step 6: Security diff audit**

Run:

```bash
git diff origin/develop...HEAD --check
git diff origin/develop...HEAD | rg -n "auth-token|session_token|authorization|cookie|response body|browser\.|wxt/"
```

Expected: only documentation/test fixture references explain prohibited data; no credential value flow or browser dependency exists in core production code.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): persist auth health checks"
```

- [ ] **Step 8: Review issue #200 acceptance criteria**

Confirm each #200 criterion is backed by a test or type boundary, summarize commits and verification, and stop before beginning #201.
