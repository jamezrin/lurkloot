# Twitch Dashboard Integrity Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover automatically when Twitch rejects authenticated extension requests for Client-Integrity, without requiring the user to open or reload twitch.tv.

**Architecture:** Keep Twitch's page-minted integrity acquisition behind the injected adapter callback so `@lurkloot/core` remains browser-free. Give that callback an explicit forced-refresh mode, make the browser host obtain a genuinely new token in that mode, and centralize one bounded retry for safe authenticated reads. Keep mutation recovery explicit at each mutation so a generic transport wrapper can never repeat a non-idempotent action accidentally.

**Tech Stack:** TypeScript, WXT browser APIs, Vitest, pnpm workspace

## Global Constraints

- `packages/core` must not import WXT or browser globals.
- Diagnostic messages remain English literals and are not added to locale catalogs.
- Retry only Client-Integrity rejections; authentication, network, and other platform failures retain their existing behavior.
- Make at most one integrity refresh and one dashboard retry per dashboard request.
- Preserve the existing retained-dashboard fallback if refresh or retry fails.
- Safe authenticated reads may retry once; mutations must opt in explicitly.
- Anonymous operations must remain anonymous and must never open a page context.
- Do not store new credentials or add browser permissions.

---

## Audited Twitch operation scope

| Operation | Policy |
|---|---|
| `Inventory`, `ViewerDropsDashboard`, `DropCampaignDetails`, `DirectoryPage_Game`, `DropsHighlightService_AvailableDrops`, `VideoPlayerStreamInfoOverlayChannel`, `DropCurrentSessionContext`, `ChannelPointsContext`, authenticated `CurrentUser` | Use the shared safe-read integrity recovery |
| `DropsPage_ClaimDropRewards`, `ClaimCommunityPoints` | Ensure integrity before mutation; on an integrity rejection, force refresh and retry exactly once |
| Anonymous `StreamInfo` and `SearchCategories` | Keep `credentials: \"omit\"`; never refresh integrity |
| Twitch heartbeat telemetry | Keep its existing transport; do not replay heartbeats through a generic GQL retry |
| Kick and non-web Twitch CLI identity | No behavior change |

---

### Task 1: Support a forced Twitch integrity refresh

**Files:**
- Modify: `packages/core/src/core/tabs.ts`
- Modify: `packages/extension/src/core/tabs.ts`
- Test: `packages/extension/tests/tabs.test.ts`

**Interfaces:**
- Produces: `type TwitchIntegrityRequest = { forceRefresh?: boolean }`
- Produces: `ensureTwitchIntegrityWithBrowser(browserApi, originUrl, timeoutMs, emit, request?): Promise<boolean>`
- Produces: `ensureTwitchIntegrity(emit?, request?): Promise<boolean>`

- [ ] **Step 1: Write failing tests for forced refresh**

Add focused cases under `describe("ensureTwitchIntegrityWithBrowser")` proving that `{ forceRefresh: true }` does not fast-return when an apparently unexpired token exists, obtains a token different from the rejected token, and does not close or navigate a user-owned Twitch tab. Mock the new-token capture with:

```ts
setTwitchIntegrity({
  integrity: "rejected-token",
  expiresAt: Date.now() + 60_000,
});
setTimeout(() => setTwitchIntegrity({
  integrity: "replacement-token",
  expiresAt: Date.now() + 60_000,
}, { isNew: true }), 20);
```

Assert that a fresh inactive inventory page context is created or an extension-owned context is reloaded, and that the result is `true` only after `replacement-token` is captured.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts
```

Expected: FAIL because forced refresh is not supported and the valid-token fast path returns immediately.

- [ ] **Step 3: Implement forced refresh in the browser-free tab port**

Add the request type and extend `ensureTwitchIntegrityWithBrowser`. In forced mode, remember the rejected token, wait specifically for a different valid token, and actively boot a fresh Twitch inventory page context. Never repurpose or navigate a user-owned Twitch tab. Preserve the current fast path when `forceRefresh` is absent:

```ts
export interface TwitchIntegrityRequest {
  forceRefresh?: boolean;
}

const rejectedToken = request?.forceRefresh ? twitchIntegrity?.integrity : undefined;
if (!request?.forceRefresh && hasValidTwitchIntegrity()) return true;
```

Update the waiter predicate so forced refresh succeeds only when the captured token is valid and differs from `rejectedToken`. Reuse a retained extension-owned page-context tab only if it is explicitly navigated back to `TWITCH_PAGE_CONTEXT_URL`; otherwise create a new inactive, muted tab.

- [ ] **Step 4: Bind the request through the WXT adapter**

Update the extension wrapper without moving browser APIs into `@lurkloot/core`:

```ts
export function ensureTwitchIntegrity(
  emit?: EventEmitter,
  request?: TwitchIntegrityRequest,
): Promise<boolean> {
  return ensureTwitchIntegrityWithBrowser(
    browser as BrowserTabApi,
    TWITCH_PAGE_CONTEXT_URL,
    undefined,
    emit,
    request,
  );
}
```

- [ ] **Step 5: Run the tab tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts
```

Expected: PASS, including existing no-token, reused-tab, timeout, retention, and new forced-refresh cases.

### Task 2: Add bounded recovery for safe authenticated Twitch reads

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Test: `packages/extension/tests/adapters.test.ts`
- Test: `packages/extension/tests/tablessWatch.test.ts`

**Interfaces:**
- Consumes: `TwitchIntegrityRequest`
- Changes constructor callback to: `(request?: TwitchIntegrityRequest) => Promise<boolean>`
- Produces: `TwitchAdapter.gqlWithIntegrityRetry<T>(...): Promise<TwitchGqlResponse<T>>`
- Produces: bounded recovery for authenticated reads without changing anonymous calls

- [ ] **Step 1: Write the failing dashboard adapter tests**

Add tests alongside the retained-dashboard failure cases:

```ts
it("refreshes integrity and retries a rejected dashboard once", async () => {
  let attempts = 0;
  const ensureIntegrity = vi.fn(async () => true);
  const fetcher = jsonFetcher((_url, init) => {
    const op = operation(init);
    if (op === "Inventory") return twitchInventory([]);
    if (op === "ViewerDropsDashboard") {
      attempts += 1;
      if (attempts === 1) throw new Error("failed integrity check");
      return twitchDashboard(["campaign"]);
    }
    if (op === "DropCampaignDetails") return twitchCampaignDetails("campaign");
    throw new Error(`Unexpected op ${op}`);
  });

  const campaigns = await new TwitchAdapter(fetcher, ensureIntegrity).discoverCampaigns();

  expect(campaigns.map((campaign) => campaign.id)).toEqual(["campaign"]);
  expect(ensureIntegrity).toHaveBeenCalledOnce();
  expect(ensureIntegrity).toHaveBeenCalledWith({ forceRefresh: true });
  expect(attempts).toBe(2);
});
```

Also cover refresh returning `false`, retry receiving another integrity rejection, and a generic dashboard failure. Those cases must use retained campaigns and must not loop or refresh for non-integrity errors.

- [ ] **Step 2: Write failing safe-read coverage**

Add focused adapter tests that make each authenticated read reject once with `failed integrity check`, then succeed. Use the existing `operation(init)`, `twitchInventory()`, `twitchDashboard()`, and `twitchCampaignDetails()` fixtures, and apply these assertions to every operation:

```ts
expect(ensureIntegrity).toHaveBeenCalledOnce();
expect(ensureIntegrity).toHaveBeenCalledWith({ forceRefresh: true });
expect(attemptsByOperation.get(rejectedOperation)).toBe(2);
```

Create one case for each public entry point: `discoverCampaigns()` for `Inventory`, `ViewerDropsDashboard`, and `DropCampaignDetails`; `listCandidateChannels()` for `DirectoryPage_Game`; `checkChannel()` for `DropsHighlightService_AvailableDrops`; `readProgress()` for `VideoPlayerStreamInfoOverlayChannel` and `DropCurrentSessionContext`; `claimChannelPoints()` for `ChannelPointsContext`; and `checkAuthHealth()` for authenticated `CurrentUser`. Use separate cases where an operation's existing fallback is itself part of the contract: retained campaign details, category-only channel validation, and inventory-only progress. Add a watcher case in `tablessWatch.test.ts` for user-id resolution when the scheduler has not supplied an ID.

- [ ] **Step 3: Prove anonymous calls never acquire integrity**

Extend the existing `StreamInfo` and `SearchCategories` tests with:

```ts
expect(ensureIntegrity).not.toHaveBeenCalled();
expect(init?.credentials).toBe("omit");
```

This guards against an over-broad transport-level retry that would open Twitch tabs for public requests.

- [ ] **Step 4: Run the adapter tests and verify the recovery cases fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts
```

Expected: FAIL because authenticated reads currently call `this.gql()` directly and `fetchDashboard()` immediately returns `{ ok: false }`.

- [ ] **Step 5: Add a narrow integrity-rejection predicate**

Keep the predicate local to Twitch transport behavior and case-insensitive:

```ts
function isIntegrityRejection(error: unknown): boolean {
  return error instanceof Error && /integrity/i.test(error.message);
}
```

Do not classify authentication rejection as integrity failure; the existing `authHealthFromError(error)` branch remains first.

- [ ] **Step 6: Implement the shared safe-read helper**

Add a non-recursive helper on `TwitchAdapter`:

```ts
private async gqlWithIntegrityRetry<T>(
  operationName: string,
  sha256Hash: string,
  variables: Record<string, unknown>,
  query?: string,
  credentials?: RequestCredentials,
  emit: EventEmitter = this.emit,
): Promise<TwitchGqlResponse<T>> {
  try {
    return await this.gql<T>(operationName, sha256Hash, variables, query, credentials, emit);
  } catch (error) {
    if (authHealthFromError(error) || !isIntegrityRejection(error) || credentials === "omit") throw error;
    const refreshed = await this.ensureIntegrity({ forceRefresh: true });
    if (!refreshed) throw error;
    return this.gql<T>(operationName, sha256Hash, variables, query, credentials, emit);
  }
}
```

Use this helper only for the authenticated read operations in the audit table. Preserve the special inline-query fallback in `fetchInventory()` by applying recovery to each concrete GQL attempt, and preserve the dashboard retained-campaign catch outside the helper.

- [ ] **Step 7: Implement the dashboard fallback around the shared retry**

Make `fetchDashboard()` call `gqlWithIntegrityRetry()`. Return `{ response, ok: true }` after recovery. If refresh fails or the retry throws, emit the existing retained-campaign warning once with the final reason and return `{ response: {}, ok: false }`.

- [ ] **Step 8: Pass the typed callback from the extension host and watcher**

Keep the existing dependency injection in `packages/extension/entrypoints/background.ts`, forwarding the optional request:

```ts
(request) => ensureTwitchIntegrity(emit, request)
```

The CLI remains compatible because the callback has a default implementation and its non-web identity does not require Client-Integrity.

Pass the same callback into `TwitchWatcher` for its authenticated `CurrentUser` fallback. Do not attach it to heartbeat telemetry or anonymous stream lookup.

- [ ] **Step 9: Run focused safe-read tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts tests/tabs.test.ts tests/tablessWatch.test.ts
```

Expected: PASS with exactly one retry for each safe authenticated read, no retry for anonymous reads, and no retained-dashboard warning after successful recovery.

### Task 3: Make Twitch mutation recovery explicit and genuinely fresh

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: `(request?: TwitchIntegrityRequest) => Promise<boolean>`
- Produces: one explicit forced-refresh retry for drop and channel-points claims

- [ ] **Step 1: Write a failing stale-token drop-claim test**

Model the callback contract rather than returning `true` unconditionally:

```ts
const ensureIntegrity = vi.fn(async (request?: TwitchIntegrityRequest) =>
  request?.forceRefresh === true);
```

Make the first `DropsPage_ClaimDropRewards` response reject for integrity and the second succeed. Assert the second callback call is exactly `{ forceRefresh: true }`. This replaces the current test's incorrect assumption that calling the non-forcing fast path twice produces a new token.

- [ ] **Step 2: Write failing channel-points mutation tests**

Cover both `ChannelPointsContext` safe-read recovery and `ClaimCommunityPoints` mutation recovery. For the mutation, assert integrity is ensured before the first attempt, an integrity rejection requests one forced refresh, the retry succeeds, and a second rejection propagates without a third attempt.

- [ ] **Step 3: Run the mutation tests and verify they fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts
```

Expected: FAIL because drop claims do not request forced refresh and channel-points claims have no integrity recovery.

- [ ] **Step 4: Correct drop-claim recovery**

Keep the proactive `await this.ensureIntegrity()` before the first claim. Change only the rejection path:

```ts
const refreshed = await this.ensureIntegrity({ forceRefresh: true });
```

Retry `runClaim()` once only when refresh succeeds.

- [ ] **Step 5: Add explicit channel-points mutation recovery**

Resolve `ChannelPointsContext` through the safe-read helper. Before `ClaimCommunityPoints`, call the non-forcing ensure fast path. If the mutation is rejected for integrity, force refresh and retry the same claim ID exactly once. Do not use a generic mutation retry wrapper in `createTwitchGqlTransport()`.

- [ ] **Step 6: Run focused mutation tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts
```

Expected: PASS with bounded, explicit mutation recovery.

### Task 4: Verify repository boundaries and regression coverage

**Files:**
- No additional source files

**Interfaces:**
- Consumes all behavior from Tasks 1 through 3.
- Produces a verified release-ready change.

- [ ] **Step 1: Run the core-boundary test**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/coreBoundary.test.ts
```

Expected: PASS, proving `@lurkloot/core` still has no WXT or browser-global dependency.

- [ ] **Step 2: Run the full repository verification**

Run:

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, extension tests, site build, and Chromium/Firefox extension builds all pass.

- [ ] **Step 3: Review diagnostic behavior**

Confirm a successful recovery produces one integrity-recovery warning followed by normal discovery, while a failed recovery produces one final retained-campaign warning per tick. Confirm no diagnostic localization keys, manifest permissions, or credential storage were added.

- [ ] **Step 4: Commit the focused fix**

```bash
git add packages/core/src/core/tabs.ts packages/core/src/platforms/twitch/index.ts packages/extension/src/core/tabs.ts packages/extension/entrypoints/background.ts packages/extension/tests/tabs.test.ts packages/extension/tests/adapters.test.ts packages/extension/tests/tablessWatch.test.ts
git commit -m "fix(twitch): recover rejected integrity tokens"
```
