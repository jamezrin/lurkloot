# Twitch Progressing Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale or contradictory Twitch channel-availability negatives from blocking a campaign that can be farmed.

**Architecture:** Scope cached `AvailableDrops` snapshots to the Twitch broadcast that produced them and use a shorter TTL for negative snapshots. Separately retain short-lived, authenticated positive evidence when `DropCurrentSessionContext` proves that one exact channel is advancing one exact campaign; both batch and single selection consult the same state APIs.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, WXT-compatible browser-free core.

## Global Constraints

- Twitch core code remains browser-free and must not import WXT or browser globals.
- Diagnostic messages are English literals and are not added to locale catalogs.
- Do not log OAuth tokens, cookies, request headers, or raw authenticated responses.
- Do not accept every live stream in a campaign category.
- Do not infer campaign aliases from names, categories, artwork, or reward display text.
- Positive availability snapshots live for 120 seconds; negative snapshots live for 30 seconds.
- Progress-confirmed facts live for five minutes and share the existing 128-entry FIFO bound.
- Authenticated-user changes and generation mismatches invalidate both availability snapshots and progress-confirmed facts.

---

## File Structure

- Modify `packages/core/src/platforms/twitch/index.ts`: extend discovery-state records and APIs, propagate broadcast IDs through candidate selection, unify availability resolution, and record progress-confirmed evidence.
- Modify `packages/extension/tests/adapters.test.ts`: add deterministic regression tests for broadcast invalidation, asymmetric TTLs, exact progress overrides, identity isolation, diagnostics, and batch/single parity.

No new production file is needed: all affected behavior already belongs to the Twitch adapter's discovery state and availability paths.

### Task 1: Make availability snapshots broadcast-scoped

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts:26-38,286-350,390-545,1069-1115,1190-1660`
- Test: `packages/extension/tests/adapters.test.ts:2580-3075,3380-3665`

**Interfaces:**
- Produces: `cachedChannelAvailability(channelId: string, broadcastId: string): ChannelAvailabilityLookup`
- Produces: `rememberChannelAvailability(channelId: string, broadcastId: string, campaignIds: ReadonlySet<string>, requestIdentity: TwitchAvailabilityRequestIdentity): boolean`
- Produces: `ChannelAvailabilityLookup` status `broadcast_changed` for diagnostic accounting.
- Consumes: `ChannelCandidate.broadcastId?: string` from `@lurkloot/shared/models`.

- [ ] **Step 1: Write failing discovery-state tests for broadcast identity and TTL polarity**

Add tests beside the existing availability-cache tests. Use fake timers and direct `TwitchDiscoveryState` calls:

```ts
it("invalidates a cached channel availability snapshot when the broadcast changes", () => {
  const discoveryState = new TwitchDiscoveryState();
  const identity = discoveryState.availabilityRequestIdentity();

  discoveryState.rememberChannelAvailability(
    "channel-id",
    "broadcast-a",
    new Set<string>(),
    identity,
  );

  expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-a"))
    .toEqual({ status: "hit", campaignIds: new Set() });
  expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-b"))
    .toEqual({ status: "broadcast_changed" });
  expect(discoveryState.cachedChannelAvailability("channel-id", "broadcast-a"))
    .toEqual({ status: "miss" });
});

it("expires negative availability before positive availability", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-15T15:00:00Z"));
  const discoveryState = new TwitchDiscoveryState();
  const identity = discoveryState.availabilityRequestIdentity();

  discoveryState.rememberChannelAvailability("negative", "broadcast-n", new Set(), identity);
  discoveryState.rememberChannelAvailability("positive", "broadcast-p", new Set(["campaign"]), identity);
  vi.advanceTimersByTime(30_001);

  expect(discoveryState.cachedChannelAvailability("negative", "broadcast-n"))
    .toEqual({ status: "expired" });
  expect(discoveryState.cachedChannelAvailability("positive", "broadcast-p"))
    .toEqual({ status: "hit", campaignIds: new Set(["campaign"]) });
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "broadcast changes|negative availability before positive"
```

Expected: FAIL because the discovery-state methods do not accept `broadcastId`, no `broadcast_changed` state exists, and all snapshots currently use the same 120-second TTL.

- [ ] **Step 3: Implement broadcast-aware cache records and asymmetric TTLs**

In `packages/core/src/platforms/twitch/index.ts`, replace the single TTL with:

```ts
const POSITIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS = 2 * 60_000;
const NEGATIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS = 30_000;
```

Extend `CachedAvailableCampaigns` with `broadcastId: string`. Extend `ChannelAvailabilityLookup` with `{ status: "broadcast_changed" }`. Change `cachedChannelAvailability` to delete and return `broadcast_changed` when `cached.broadcastId !== broadcastId`. Change `rememberChannelAvailability` to store the broadcast ID and select the TTL from `campaignIds.size > 0`.

Keep the existing identity-generation guard and FIFO eviction unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Write failing adapter tests for broadcast revalidation and diagnostic accounting**

Add one single-channel test and one batch-selection test:

```ts
it("refetches single-channel availability when the channel starts a new broadcast", async () => {
  let broadcastId = "broadcast-a";
  let availabilityCalls = 0;
  const fetcher = jsonFetcher((_url, init) => {
    const op = operation(init);
    if (op === "StreamInfo") {
      return { data: { user: { id: "channel-id", stream: { id: broadcastId, game: { id: "game" } } } } };
    }
    if (op === "DropsHighlightService_AvailableDrops") {
      availabilityCalls += 1;
      return {
        data: {
          channel: {
            id: "channel-id",
            viewerDropCampaigns: availabilityCalls === 1 ? [] : [{ id: "campaign" }],
          },
        },
      };
    }
    throw new Error(`Unexpected op ${op}`);
  });
  const discoveryState = new TwitchDiscoveryState();
  const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;
  const campaign = { id: "campaign", categoryId: "game" } as DropCampaign;

  await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
    .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: false });
  broadcastId = "broadcast-b";
  await expect(twitchAdapter(fetcher, undefined, undefined, { discoveryState })
    .checkChannel(candidate, { campaign })).resolves.toMatchObject({ campaignMatches: true });

  expect(availabilityCalls).toBe(2);
});
```

For the batch case, provide two trusted directory candidates with `broadcastId`, populate a negative for the first broadcast, then select again with a changed first broadcast. Assert that the new batch request includes that channel and the selection diagnostic contains `1 availability broadcast invalidations`.

- [ ] **Step 6: Run the adapter tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "new broadcast|broadcast invalidations"
```

Expected: FAIL because batch and single paths still perform channel-only lookups and diagnostics do not count broadcast invalidations.

- [ ] **Step 7: Propagate broadcast identity through batch and single availability paths**

Change the internal candidate shape used by `batchCampaignAvailability` and `batchCampaignAvailabilityChunk` to:

```ts
type TwitchAvailabilityCandidate = {
  channelId: string;
  channelLogin: string;
  broadcastId: string;
};
```

Pass `stream.id` from both `batchStreamInfoChunk` and `checkChannel`. For trusted directory candidates, retain `edge.node.id` as `ChannelCandidate.broadcastId`; add `id` to the inline `DirectoryPage_Game` selection and the `TwitchDirectoryData` stream node type. If a caller supplies a trusted directory candidate without a broadcast ID, route it through the existing `StreamInfo` batch instead of caching a channel-only result.

Update every cache read/write to include `broadcastId`. Add `broadcastInvalidations` to the batch result and selection diagnostic. Keep failed or ambiguous responses as `undefined` and uncached.

- [ ] **Step 8: Run all adapter tests and typecheck the core changes**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts
pnpm --filter @lurkloot/core typecheck
pnpm --filter @lurkloot/extension typecheck
```

Expected: PASS. Update existing direct discovery-state tests and trusted-directory fixtures to supply stable broadcast IDs where they intentionally exercise cache hits.

- [ ] **Step 9: Commit the broadcast-scoped cache change**

```bash
git add packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "fix(twitch): scope availability cache to broadcasts"
```

### Task 2: Let material current-session progress override an exact negative

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts:340-545,930-940,1200-1660,1855-1910`
- Test: `packages/extension/tests/adapters.test.ts:2580-3075,3700-3910`

**Interfaces:**
- Produces: `hasProgressConfirmedAvailability(channelId: string, campaignId: string): boolean`
- Produces: `rememberProgressConfirmedAvailability(channelId: string, campaignId: string, requestIdentity: TwitchAvailabilityRequestIdentity): boolean`
- Consumes: the broadcast-aware cache APIs produced by Task 1.
- Consumes: `DropCurrentSessionContext.dropID` and `currentMinutesWatched` already parsed by `TwitchCurrentDropData`.

- [ ] **Step 1: Write failing state tests for exact, bounded, identity-isolated progress evidence**

Add direct `TwitchDiscoveryState` tests proving:

```ts
it("limits progress-confirmed availability to the exact channel and campaign", () => {
  const discoveryState = new TwitchDiscoveryState();
  const identity = discoveryState.availabilityRequestIdentity();

  expect(discoveryState.rememberProgressConfirmedAvailability(
    "channel-a",
    "campaign-a",
    identity,
  )).toBe(true);

  expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-a")).toBe(true);
  expect(discoveryState.hasProgressConfirmedAvailability("channel-a", "campaign-b")).toBe(false);
  expect(discoveryState.hasProgressConfirmedAvailability("channel-b", "campaign-a")).toBe(false);
});
```

Also test five-minute expiry with fake timers, FIFO eviction after 128 unique pairs, clearing on `setAuthenticatedUser`, and rejection of a write captured before an A → B → A identity round trip.

- [ ] **Step 2: Run the focused state tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "progress-confirmed availability"
```

Expected: FAIL because progress-confirmed state and methods do not exist.

- [ ] **Step 3: Implement bounded progress-confirmed state**

Add:

```ts
const PROGRESS_CONFIRMED_AVAILABILITY_TTL_MS = 5 * 60_000;

interface ProgressConfirmedAvailability {
  channelId: string;
  campaignId: string;
  expiresAt: number;
}
```

Store facts in a FIFO `Map<string, ProgressConfirmedAvailability>` keyed by `${channelId}:${campaignId}`. `hasProgressConfirmedAvailability` deletes expired entries on read. `rememberProgressConfirmedAvailability` applies the existing request-identity generation guard, enforces the 128-entry bound, refreshes the pair's expiry, and adds `campaignId` to an existing cached snapshot for `channelId` so a contradictory negative cannot survive.

Clear this map whenever `setAuthenticatedUser` increments the availability generation.

- [ ] **Step 4: Run the focused state tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Write failing refresh tests for material progress detection**

Extend the existing `merges current watched drop progress` coverage with three tests:

1. Inventory reports 10 minutes and `DropCurrentSessionContext` reports 11 for `drop`; after refresh, the exact channel/campaign fact exists.
2. Both sources report 10; no fact exists.
3. The returned `dropID` occurs in zero or two campaigns; no fact exists.

Use an injected `TwitchDiscoveryState`, make `VideoPlayerStreamInfoOverlayChannel` return both `channel-id` and `broadcast-id`, and assert through `hasProgressConfirmedAvailability` rather than private adapter state.

- [ ] **Step 6: Run the progress refresh tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "material current-session progress|unchanged current-session progress|ambiguous current-session drop"
```

Expected: FAIL because `mergeCurrentSessionProgress` merges minutes but records no availability evidence.

- [ ] **Step 7: Record progress only when the evidence is material and unambiguous**

In `mergeCurrentSessionProgress`:

```ts
const matchingCampaigns = campaigns.filter((campaign) =>
  campaign.rewards.some((reward) => reward.id === drop.dropID)
);
const matchingCampaign = matchingCampaigns.length === 1 ? matchingCampaigns[0] : undefined;
const previousReward = matchingCampaign?.rewards.find((reward) => reward.id === drop.dropID);
if (
  matchingCampaign
  && previousReward
  && currentMinutesWatched > previousReward.watchedMinutes
) {
  this.discoveryState.rememberProgressConfirmedAvailability(
    channelId,
    matchingCampaign.id,
    requestIdentity,
  );
}
```

Capture `requestIdentity` immediately before dispatching `DropCurrentSessionContext`, then pass it to the guarded write. Keep the existing campaign-progress merge unchanged after recording the evidence.

Emit one English debug diagnostic naming only the campaign ID and channel login when new material evidence overrides a contradictory negative; do not emit it for routine expiry refreshes.

- [ ] **Step 8: Run the progress refresh tests and verify GREEN**

Run the command from Step 6.

Expected: PASS.

- [ ] **Step 9: Write failing batch/single parity tests for the override**

Create a progress-confirmed fact for `channel-a/campaign-a`, then arrange `AvailableDrops` to omit `campaign-a`.

- For `checkChannel`, assert `campaignMatches: true` and zero `AvailableDrops` calls for the proven pair.
- For `selectCandidateChannel`, include `channel-a` and a genuine negative `channel-b`; assert `channel-a` wins, no availability request is made for it, and `channel-b` remains rejectable.
- Repeat the assertions for `campaign-b` on channel A and `campaign-a` on channel B; both must remain false.
- Assert the batch selection diagnostic reports `1 progress-confirmed availability overrides`.

- [ ] **Step 10: Run parity tests and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "progress-confirmed override|progress-confirmed availability overrides"
```

Expected: FAIL because batch and single paths do not consult the positive evidence.

- [ ] **Step 11: Consult progress evidence before cached or fresh snapshots in both paths**

In both `batchCampaignAvailability` and `checkCampaignAvailability`, return true before reading the broadcast-scoped snapshot when `hasProgressConfirmedAvailability(channelId, campaignId)` is true. Add `progressOverrides` to batch metrics and the final selection diagnostic.

Do not write an `AvailableDrops` snapshot for an overridden pair and do not let an unrelated fact skip the network request.

- [ ] **Step 12: Run all adapter tests and workspace typechecks**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts
pnpm typecheck
```

Expected: PASS with no TypeScript errors or changed behavior outside Twitch availability.

- [ ] **Step 13: Commit the progress-confirmed override**

```bash
git add packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "fix(twitch): trust confirmed campaign progress"
```

### Task 3: Verify the complete issue #392 behavior

**Files:**
- Verify: `packages/core/src/platforms/twitch/index.ts`
- Verify: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: broadcast-scoped cache and metrics from Task 1.
- Consumes: progress-confirmed evidence and metrics from Task 2.
- Produces: a verified implementation satisfying issue #392 acceptance criteria.

- [ ] **Step 1: Add one end-to-end contradictory-observation regression test**

Use a shared `TwitchDiscoveryState` across adapter reconstructions:

1. `checkChannel` observes `broadcast-a` and caches an explicit negative for `campaign-a`.
2. `refreshCampaigns` for that same session observes inventory at 10 minutes and current-session progress at 11 minutes.
3. A reconstructed adapter checks the same channel/campaign while `AvailableDrops` still omits it.
4. Assert the channel is accepted without another availability request.
5. Advance five minutes and one millisecond, keep the same broadcast, and assert the negative is queried again rather than preserved by the expired proof.

- [ ] **Step 2: Run the regression test and confirm GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "recovers a contradictory Twitch availability negative after material progress"
```

Expected: PASS. If it fails, fix production behavior without weakening the test's exact channel/campaign assertions.

- [ ] **Step 3: Run formatting and diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the intended Twitch adapter/test changes.

- [ ] **Step 4: Run the full repository verification appropriate to the change**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm build:firefox
```

Expected: all test suites, workspace typechecks, and both browser production builds pass.

- [ ] **Step 5: Commit any final regression-only adjustment**

If Step 1 required a new test commit after Task 2, commit it separately:

```bash
git add packages/extension/tests/adapters.test.ts packages/core/src/platforms/twitch/index.ts
git commit -m "test(twitch): cover contradictory availability recovery"
```

If no files changed after the Task 2 commit, skip this commit rather than creating an empty one.
