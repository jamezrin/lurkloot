# Unified Campaign Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scheduler's sequential discovery/progress pipeline with one adapter-owned refresh operation that avoids Twitch's duplicate inventory request and runs Kick's independent campaign/progress requests concurrently.

**Architecture:** Each `PlatformAdapter` will expose `refreshCampaigns(session?, options?)`, returning a fully reconciled `DropCampaign[]`. Twitch will carry its discovery inventory through reconciliation and perform only active-session-specific follow-up work; Kick will fetch campaign definitions and account progress concurrently while preserving its existing progress soft-failure behavior.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, WXT WebExtension, browser-free `@lurkloot/core`.

## Global Constraints

- Core must not import WXT or browser globals.
- Platform request planning and parsing must remain behind `PlatformAdapter`.
- Diagnostics are English literals and must not be added to locale catalogs.
- Authentication failures and abort signals must retain their current propagation semantics.
- No settings, persisted-state schemas, permissions, or locale catalogs change.
- Use two-space indentation, double quotes, semicolons, explicit imports, and type-only imports where applicable.

---

### Task 1: Twitch Single-Inventory Refresh

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Produces: `TwitchAdapter.refreshCampaigns(session?: WatchSession, options?: AdapterOperationOptions): Promise<DropCampaign[]>`
- Internal helper: `discoverCampaignSnapshot(options?): Promise<DropCampaign[]>`
- Preserves temporarily: existing `discoverCampaigns` and `readProgress` methods until Task 3 migrates the shared interface.

- [ ] **Step 1: Write a failing test proving a non-watching refresh fetches inventory once**

Add a focused adapter test whose fetcher counts `Inventory` operations while returning valid inventory, dashboard, and detail responses:

```ts
it("refreshes Twitch campaigns with one inventory request", async () => {
  let inventoryCalls = 0;
  const adapter = new TwitchAdapter(jsonFetcher((_url, init) => {
    const body = JSON.parse(String(init?.body)) as
      | Record<string, unknown>
      | Array<Record<string, unknown>>;
    if (Array.isArray(body)) {
      return body.map((entry) =>
        twitchCampaignDetails(String((entry.variables as { dropID?: string }).dropID)));
    }
    if (body.operationName === "Inventory") {
      inventoryCalls += 1;
      return twitchInventory(["campaign"]);
    }
    return twitchDashboard(["campaign"]);
  }));

  await adapter.refreshCampaigns();

  expect(inventoryCalls).toBe(1);
});
```

- [ ] **Step 2: Run the test and verify the missing method fails**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/adapters.test.ts -t "refreshes Twitch campaigns with one inventory request"
```

Expected: FAIL because `refreshCampaigns` does not exist.

- [ ] **Step 3: Refactor Twitch discovery to return its inventory snapshot**

Extract the current `discoverCampaigns` body into:

```ts
private async discoverCampaignSnapshot(
  { signal }: AdapterOperationOptions = {},
): Promise<DropCampaign[]> {
  // Existing discovery logic already merges the fetched inventory into the
  // returned campaigns.
}
```

Keep the temporary compatibility wrapper:

```ts
async discoverCampaigns(options: AdapterOperationOptions = {}): Promise<DropCampaign[]> {
  return this.discoverCampaignSnapshot(options);
}
```

- [ ] **Step 4: Implement Twitch `refreshCampaigns` without a second inventory read**

```ts
async refreshCampaigns(
  session?: WatchSession,
  options: AdapterOperationOptions = {},
): Promise<DropCampaign[]> {
  const campaigns = await this.discoverCampaignSnapshot(options);
  if (!session?.channel || session.status !== "watching") return campaigns;
  return this.mergeCurrentSessionProgress(campaigns, session.channel, options.signal);
}
```

Keep `readProgress` unchanged until Task 3 so existing callers remain valid during this independently testable commit.

- [ ] **Step 5: Add and run an active-session regression test**

Add a test that supplies a watching session, verifies one `Inventory` request, and verifies the current-session operation still runs:

```ts
expect(inventoryCalls).toBe(1);
expect(currentDropCalls).toBe(1);
```

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/adapters.test.ts
pnpm --filter @lurkloot/core --filter @lurkloot/extension typecheck
```

Expected: all adapter tests and both typechecks pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "perf(twitch): reuse discovery inventory during refresh"
```

---

### Task 2: Concurrent Kick Refresh

**Files:**
- Modify: `packages/core/src/platforms/kick/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Produces: `KickAdapter.refreshCampaigns(session?: WatchSession, options?: AdapterOperationOptions): Promise<DropCampaign[]>`
- Internal helpers:
  - `fetchCampaignData(signal?: AbortSignal): Promise<unknown>`
  - `fetchProgressData(signal?: AbortSignal): Promise<unknown>`
  - `mergeProgress(campaigns: DropCampaign[], data: unknown): DropCampaign[]`
  - `reportProgressFallback(error: unknown): void`
- Preserves temporarily: existing `discoverCampaigns` and `readProgress` methods until Task 3.

- [ ] **Step 1: Write a failing concurrency test**

Use two deferred promises so neither endpoint can finish before both have started:

```ts
it("starts Kick campaign and progress requests concurrently", async () => {
  let campaignStarted = false;
  let progressStarted = false;
  const adapter = new KickAdapter(jsonFetcher(async (url) => {
    if (url.endsWith("/drops/campaigns")) {
      campaignStarted = true;
      await vi.waitFor(() => expect(progressStarted).toBe(true));
      return {
        data: [{
          id: 1,
          name: "Kick Campaign",
          status: "active",
          category: { id: 99, name: "Game" },
          rewards: [{ id: 10, name: "Reward", required_minutes: 60 }],
        }],
      };
    }
    progressStarted = true;
    await vi.waitFor(() => expect(campaignStarted).toBe(true));
    return {
      data: [{
        id: 1,
        status: "in progress",
        rewards: [{ id: 10, progress: 0.5, required_units: 60 }],
      }],
    };
  }));

  await adapter.refreshCampaigns();
});
```

- [ ] **Step 2: Run the test and verify the missing method fails**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/adapters.test.ts -t "starts Kick campaign and progress requests concurrently"
```

Expected: FAIL because `refreshCampaigns` does not exist.

- [ ] **Step 3: Implement concurrent Kick refresh with asymmetric failure handling**

Start both requests immediately, but convert only the progress promise into a settled result:

```ts
async refreshCampaigns(
  _session?: WatchSession,
  { signal }: AdapterOperationOptions = {},
): Promise<DropCampaign[]> {
  const progressPromise = this.fetchProgressData(signal).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  );
  const [campaignData, progressResult] = await Promise.all([
    this.fetchCampaignData(signal),
    progressPromise,
  ]);
  const campaigns = parseKickCampaigns(campaignData);
  if (progressResult.status === "fulfilled") {
    return this.mergeProgress(campaigns, progressResult.value);
  }
  signal?.throwIfAborted();
  if (authHealthFromError(progressResult.reason)) throw progressResult.reason;
  this.reportProgressFallback(progressResult.reason);
  return campaigns;
}
```

Extract private request/merge/report helpers from the existing two public methods; do not duplicate endpoint headers or warning text.

- [ ] **Step 4: Add failure-semantics tests**

Add tests proving:

```ts
await expect(adapterWithProgressNetworkFailure.refreshCampaigns())
  .resolves.toEqual(parsedCampaigns);
await expect(adapterWithProgressAuthFailure.refreshCampaigns())
  .rejects.toMatchObject({ kind: "credentials" });
await expect(adapterWithCampaignFailure.refreshCampaigns())
  .rejects.toThrow();
```

Also assert the existing warning is emitted for a non-authentication progress failure.

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/adapters.test.ts
pnpm --filter @lurkloot/core --filter @lurkloot/extension typecheck
```

Expected: all adapter tests and both typechecks pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/platforms/kick/index.ts packages/extension/tests/adapters.test.ts
git commit -m "perf(kick): refresh campaigns and progress concurrently"
```

---

### Task 3: Migrate the Scheduler Contract

**Files:**
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/extension/tests/scheduler.test.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/cli/tests/run.test.ts`
- Test: `packages/extension/tests/scheduler.test.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/cli/tests/run.test.ts`

**Interfaces:**
- Consumes: both concrete adapters' `refreshCampaigns` methods from Tasks 1 and 2.
- Produces:

```ts
interface PlatformAdapter {
  refreshCampaigns(
    session?: WatchSession,
    options?: AdapterOperationOptions,
  ): Promise<DropCampaign[]>;
}
```

- Removes: `PlatformAdapter.discoverCampaigns` and `PlatformAdapter.readProgress`.

- [ ] **Step 1: Write a failing scheduler test for the unified call**

Change the scheduler test adapter to expose a `refreshCampaigns` spy and assert:

```ts
expect(adapter.refreshCampaigns).toHaveBeenCalledOnce();
expect(adapter.refreshCampaigns).toHaveBeenCalledWith(
  previousSession,
  expect.objectContaining({ signal: expect.any(AbortSignal) }),
);
```

Assert the event batch contains:

```ts
expect.objectContaining({
  category: "diagnostic",
  message: expect.stringMatching(/^Campaign refresh finished in \d+ms \(1 campaign\)$/),
});
```

and does not contain the old discovery/progress timing messages.

- [ ] **Step 2: Run the scheduler test and verify it fails against the old contract**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/scheduler.test.ts -t "refresh"
```

Expected: FAIL because the scheduler still calls `discoverCampaigns` and `readProgress`.

- [ ] **Step 3: Replace the shared adapter contract and scheduler pipeline**

In `adapter.ts`, replace the two methods with the exact `refreshCampaigns` signature above.

In `scheduler.ts`, replace the two timed calls with:

```ts
const refreshStartedAt = Date.now();
campaigns = await adapter.refreshCampaigns(previous, { signal: options.signal });
emitDiagnostic(
  emit,
  platform,
  "debug",
  `Campaign refresh finished in ${Date.now() - refreshStartedAt}ms (${countLabel(campaigns.length, "campaign")})`,
);
campaigns = preserveClaimedRewards(campaigns, state.campaigns[platform]);
```

Keep the existing error fallback, state update, health observation, claim, and selection blocks unchanged.

- [ ] **Step 4: Remove the obsolete public methods and migrate deterministic adapters**

Delete public `discoverCampaigns` and `readProgress` from Twitch and Kick after their private helpers have no callers.

Replace test/CLI adapter stubs:

```ts
refreshCampaigns: vi.fn(async () => campaigns),
```

or:

```ts
refreshCampaigns: async () => [],
```

Remove old spy assertions and update diagnostic expectations to the single refresh message.

- [ ] **Step 5: Run contract and scheduler verification**

Run:

```bash
pnpm --dir packages/extension exec vitest run \
  tests/scheduler.test.ts \
  tests/backgroundController.test.ts \
  tests/adapters.test.ts
pnpm --dir packages/cli exec vitest run tests/run.test.ts
pnpm typecheck
```

Expected: all selected tests and workspace typechecks pass.

- [ ] **Step 6: Commit**

```bash
git add \
  packages/core/src/platforms/adapter.ts \
  packages/core/src/core/scheduler.ts \
  packages/core/src/platforms/twitch/index.ts \
  packages/core/src/platforms/kick/index.ts \
  packages/extension/tests/scheduler.test.ts \
  packages/extension/tests/backgroundController.test.ts \
  packages/cli/tests/run.test.ts
git commit -m "refactor(core): unify campaign refresh"
```

---

### Task 4: Full Regression Verification and Delivery

**Files:**
- Verify only unless a regression requires a focused correction.

**Interfaces:**
- Consumes: unified `PlatformAdapter.refreshCampaigns` contract.
- Produces: verified Chromium and Firefox extension builds on the existing PR branch.

- [ ] **Step 1: Confirm removed APIs are gone**

Run:

```bash
rg -n "discoverCampaigns|readProgress|Campaign discovery finished|Campaign progress refresh finished" \
  packages/core packages/extension packages/cli
```

Expected: no production or stale test-adapter references; fixture prose is acceptable only if it describes external platform concepts.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, CLI/extension/site tests, site build, Chromium build, and Firefox build all exit successfully.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff origin/develop...HEAD --check
git status --short
```

Expected: no whitespace errors and a clean worktree after commits.

- [ ] **Step 4: Push the existing branch**

```bash
git push origin perf/scheduler-platform-concurrency
```

Expected: the existing draft PR updates without creating another branch or PR.
