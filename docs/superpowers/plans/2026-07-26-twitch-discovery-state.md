# Twitch Discovery Retention State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Twitch dashboard and campaign-detail discovery retention across fresh adapter constructions during one extension background or CLI transport lifetime.

**Architecture:** Extract the existing adapter-owned discovery caches into an injectable `TwitchDiscoveryState`. Each host owns one state at its process/transport boundary and supplies it to every short-lived `TwitchAdapter`, while all settings, emitters, and operation-scoped ports remain fresh.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, WXT WebExtension, Node CLI

## Global Constraints

- Retention is process-lifetime only; it does not survive extension/background, browser, or CLI restarts.
- Preserve the existing 30-minute discovery retention TTL.
- A successful empty dashboard is authoritative and replaces retained dashboard IDs with `[]`.
- Authentication failures continue to propagate.
- `@lurkloot/core` remains browser-free.
- Extension and CLI hosts must use the same `TwitchDiscoveryState` behavior.

---

## File Structure

- `packages/core/src/platforms/twitch/index.ts`: define and export `TwitchDiscoveryState`; let `TwitchAdapter` consume an injected instance.
- `packages/extension/entrypoints/background.ts`: own one extension-process discovery state and inject it into each Twitch adapter.
- `packages/cli/src/transport/http.ts`: own one state per HTTP transport and inject it into reconstructed adapters.
- `packages/cli/src/transport/impersonate.ts`: own one state per impersonate transport and inject it into reconstructed adapters.
- `packages/extension/tests/adapters.test.ts`: prove state retention and authoritative empty responses across adapter instances.
- `packages/extension/tests/backgroundController.test.ts`: prove two controller ticks reconstruct adapters while preserving a not-started Twitch campaign through a transient failure.
- `packages/extension/tests/compatibility.test.ts`: guard extension host state construction/injection.
- `packages/cli/tests/transport.test.ts`: prove the HTTP transport shares discovery state across adapter constructions.
- `packages/cli/tests/impersonate.test.ts`: prove the impersonate transport shares discovery state across adapter constructions.

### Task 1: Extract and inject Twitch discovery state

**Files:**

- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**

- Produces: `export class TwitchDiscoveryState`
- Produces: `TwitchAdapterOptions.discoveryState?: TwitchDiscoveryState`
- State methods remain internal to Twitch discovery behavior; hosts only construct and inject the object.

- [ ] **Step 1: Write cross-instance failing tests**

Import `TwitchDiscoveryState` in `adapters.test.ts`. Change the existing warm-cache tests to construct a shared state and two adapters:

```ts
const discoveryState = new TwitchDiscoveryState();
const firstAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState });

expect((await firstAdapter.discoverCampaigns()).map((campaign) => campaign.id)).toEqual(["a"]);

dashboardFails = true;
const secondAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState });
expect((await secondAdapter.discoverCampaigns()).map((campaign) => campaign.id)).toEqual(["a"]);
```

Add the equivalent reconstruction to the campaign-detail failure test. Update the successful-empty-dashboard test so the second adapter shares the same state, receives `[]`, and a third adapter facing a dashboard failure does not revive the obsolete campaign.

- [ ] **Step 2: Run the focused adapter tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts
```

Expected: TypeScript/Vitest fails because `TwitchDiscoveryState` and `discoveryState` do not exist, or the reconstructed adapter loses the retained campaign.

- [ ] **Step 3: Implement the minimal shared state**

In `packages/core/src/platforms/twitch/index.ts`, add:

```ts
export class TwitchDiscoveryState {
  private readonly campaignDetailsByDropId = new Map<string, CachedCampaignDetails>();
  private retainedDashboard?: CachedDashboardCampaigns;

  rememberDashboardCampaignIds(campaignIds: string[]): void {
    this.retainedDashboard = {
      campaignIds,
      expiresAt: Date.now() + DISCOVERY_RETENTION_TTL_MS,
    };
  }

  retainedDashboardCampaignIds(): string[] {
    if (!this.retainedDashboard) return [];
    if (this.retainedDashboard.expiresAt <= Date.now()) {
      this.retainedDashboard = undefined;
      return [];
    }
    return this.retainedDashboard.campaignIds;
  }

  rememberCampaignDetails(dropID: string, campaign: unknown): void {
    this.campaignDetailsByDropId.set(dropID, {
      campaign,
      expiresAt: Date.now() + DISCOVERY_RETENTION_TTL_MS,
    });
  }

  retainedCampaignDetails(dropID: string): unknown {
    const cached = this.campaignDetailsByDropId.get(dropID);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.campaignDetailsByDropId.delete(dropID);
      return undefined;
    }
    return cached.campaign;
  }
}
```

Extend the options:

```ts
export interface TwitchAdapterOptions {
  // existing fields
  discoveryState?: TwitchDiscoveryState;
}
```

Replace the two adapter fields with:

```ts
private readonly discoveryState: TwitchDiscoveryState;
```

Initialize it in the constructor:

```ts
this.discoveryState = options.discoveryState ?? new TwitchDiscoveryState();
```

Delegate the four existing retention call sites to `this.discoveryState`, then remove the adapter's private retention helper methods.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts
```

Expected: all adapter tests pass.

- [ ] **Step 5: Commit the core state extraction**

```bash
git add packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "fix(twitch): share discovery retention state"
```

### Task 2: Prove retention across controller ticks and wire the extension host

**Files:**

- Modify: `packages/extension/entrypoints/background.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/compatibility.test.ts`

**Interfaces:**

- Consumes: `new TwitchDiscoveryState()`
- Consumes: `TwitchAdapterOptions.discoveryState`
- Produces: one extension-background state shared by every `deps.createAdapters` invocation.

- [ ] **Step 1: Write the controller-level failing regression**

In `backgroundController.test.ts`, import `TwitchAdapter` and `TwitchDiscoveryState`. Add Twitch response helpers equivalent to the adapter test helpers. Configure the harness with Twitch enabled, Kick disabled, and no idle-watchlist channels. Override `deps.createAdapters` so it constructs a new `TwitchAdapter` on every call with one shared `TwitchDiscoveryState`.

The test sequence is:

```ts
await env.controller.tick();
expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["retained"]);

dashboardFails = true;
detailsFail = true;
await env.controller.tick();

expect(env.deps.createAdapters).toHaveBeenCalledTimes(2);
expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["retained"]);
```

The first tick returns an empty inventory, dashboard ID `retained`, and valid details. The second tick uses a newly constructed adapter while dashboard and detail requests fail.

Add a source-boundary assertion to `compatibility.test.ts`:

```ts
expect(backgroundSource).toContain("const twitchDiscoveryState = new TwitchDiscoveryState();");
expect(backgroundSource).toContain("discoveryState: twitchDiscoveryState,");
```

- [ ] **Step 2: Run controller and construction tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts tests/compatibility.test.ts
```

Expected: the source assertion fails and the second tick loses `retained` until the host injects shared state.

- [ ] **Step 3: Wire extension process state**

Update the Twitch import:

```ts
import { TwitchAdapter, TwitchDiscoveryState } from "@lurkloot/core/twitch";
```

Create one state beside the existing long-lived host state, outside `createAdapters`:

```ts
const twitchDiscoveryState = new TwitchDiscoveryState();
```

Pass it through Twitch options:

```ts
{
  compatibility: resolution.compatibility.twitch,
  discoveryState: twitchDiscoveryState,
  // existing heartbeat fields
}
```

- [ ] **Step 4: Run controller and extension construction tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts tests/compatibility.test.ts
```

Expected: both files pass, including the two-tick reconstruction regression.

- [ ] **Step 5: Commit extension wiring and regression**

```bash
git add packages/extension/entrypoints/background.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/compatibility.test.ts
git commit -m "fix(extension): retain Twitch discovery across ticks"
```

### Task 3: Wire both CLI transport lifetimes

**Files:**

- Modify: `packages/cli/src/transport/http.ts`
- Modify: `packages/cli/src/transport/impersonate.ts`
- Test: `packages/cli/tests/transport.test.ts`
- Test: `packages/cli/tests/impersonate.test.ts`

**Interfaces:**

- Consumes: `new TwitchDiscoveryState()`
- Consumes: `TwitchAdapterOptions.discoveryState`
- Produces: one state per transport handle, isolated from other handles.

- [ ] **Step 1: Write failing HTTP and impersonate transport tests**

For the HTTP test, stub global `fetch` to decode the Twitch GQL operation name and return:

- an authenticated empty inventory;
- dashboard campaign `retained` on the first construction, then throw;
- valid campaign details on the first construction, then throw.

Call `discoverCampaigns()` on Twitch adapters returned by two separate `handle.createAdapters(...)` calls and assert both results contain `retained`.

For impersonate, keep the fake CycleTLS client because Twitch discovery still uses global fetch. Add the same two-construction assertion to `impersonate.test.ts`.

- [ ] **Step 2: Run CLI transport tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/cli test -- tests/transport.test.ts tests/impersonate.test.ts
```

Expected: the second adapter construction returns no `retained` campaign.

- [ ] **Step 3: Wire state into both transports**

In both transport files, import `TwitchDiscoveryState`, then create it beside `KickClaimState`:

```ts
const twitchDiscoveryState = new TwitchDiscoveryState();
```

Pass it in each Twitch adapter options object:

```ts
{
  ...identity,
  compatibility: resolution.compatibility.twitch,
  discoveryState: twitchDiscoveryState,
  // existing heartbeat fields
}
```

- [ ] **Step 4: Run CLI transport tests and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/cli test -- tests/transport.test.ts tests/impersonate.test.ts
```

Expected: both transport suites pass and each second adapter retains `retained`.

- [ ] **Step 5: Commit CLI wiring**

```bash
git add packages/cli/src/transport/http.ts packages/cli/src/transport/impersonate.ts packages/cli/tests/transport.test.ts packages/cli/tests/impersonate.test.ts
git commit -m "fix(cli): retain Twitch discovery across ticks"
```

### Task 4: Verify boundaries and repository health

**Files:**

- Verify only; no planned source changes.

**Interfaces:**

- Confirms the core package remains browser-free and every workspace compiles against the new option.

- [ ] **Step 1: Run focused boundary and affected tests**

```bash
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts tests/backgroundController.test.ts tests/compatibility.test.ts tests/coreBoundary.test.ts
pnpm --filter @lurkloot/cli test -- tests/transport.test.ts tests/impersonate.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run workspace typechecks**

```bash
pnpm typecheck
```

Expected: all workspace typechecks pass.

- [ ] **Step 3: Run full repository verification**

```bash
pnpm verify
```

Expected: script policies, typechecks, all tests, site build, and Chromium/Firefox extension builds pass.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff origin/develop...HEAD --check
git status --short
git log --oneline origin/develop..HEAD
```

Expected: no whitespace errors; only the design, plan, Twitch state, host wiring, and regression tests are changed.
