# AvailableDrops Cache TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Twitch strict-availability cache expiry relative to the campaign being checked so omitted campaigns expire after 30 seconds while listed campaigns remain cached for two minutes.

**Architecture:** Keep one complete `viewerDropCampaigns` snapshot per channel and broadcast, but record when the snapshot was fetched and evaluate its lifetime against membership of the requested campaign. A negative lookup may expire while the same snapshot remains reusable for a listed campaign; only delete the whole snapshot once no positive lookup can still be valid.

**Tech Stack:** TypeScript, Vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-18-available-drops-cache-ttl.md`

## Global Constraints

- `packages/core` remains browser-free and must not import WXT or browser globals.
- Diagnostic messages remain English literals; add no locale keys.
- Do not log OAuth tokens, cookies, authorization headers, integrity tokens, or raw authenticated responses.
- `strictCampaignAvailability` remains off by default.
- Preserve fail-open handling for malformed, mismatched, and errored `AvailableDrops` responses.
- Preserve broadcast invalidation, authenticated-identity generation guards, the 128-entry bound, and progress-confirmed overrides.
- Follow strict TDD: add the regression test and observe the expected failure before changing production code.
- Use pnpm for all commands and Conventional Commits for the final commit.

---

### Task 1: Make channel-availability expiry campaign-relative

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: `TwitchDiscoveryState.rememberChannelAvailability(channelId, broadcastId, campaignIds, requestIdentity)` and both strict `AvailableDrops` callers.
- Produces: a campaign-aware cache lookup used identically by batch and single-channel availability checks.

- [ ] **Step 1: Add the failing regression coverage**

Add deterministic fake-timer coverage around the real `TwitchDiscoveryState`/`TwitchAdapter` behavior. Use a valid `AvailableDrops` snapshot containing `campaign-b` while strict selection asks for `campaign-a`. Prove all of the following with literal expectations:

1. Before 30 seconds, campaign A's omission is a cached negative.
2. After 30,001 ms, campaign A's negative is expired and the next strict lookup refetches.
3. At that same boundary, campaign B from the original snapshot remains a positive cache hit and does not refetch.
4. A listed campaign expires at the two-minute boundary.
5. An empty valid snapshot still behaves as a 30-second negative.

The tests must exercise observable cache/adapter behavior, not inspect private fields or source text.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/adapters.test.ts
```

Expected: the non-empty snapshot test fails because campaign A remains cached after 30,001 ms. Record the relevant failure in the task report before editing production code.

- [ ] **Step 3: Implement the minimal membership-relative expiry**

Update the cached snapshot representation to retain its fetch time rather than committing the entire set to one TTL. Make `cachedChannelAvailability` accept the requested campaign ID and choose the effective TTL from `campaignIds.has(campaignId)`:

```ts
const isPositive = cached.campaignIds.has(campaignId);
const ttl = isPositive
  ? POSITIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS
  : NEGATIVE_CHANNEL_CAMPAIGN_CACHE_TTL_MS;
```

When a negative lookup expires before the positive lifetime of the snapshot, return `expired` without deleting the snapshot. Delete it only once the positive lifetime has also elapsed. Update every production caller and direct state test to pass the campaign ID. When progress confirmation promotes a campaign into a cached snapshot, reset the snapshot fetch time so the promoted positive receives the full positive TTL.

- [ ] **Step 4: Verify GREEN and regression safety**

Run the focused test again and confirm it passes, then run:

```bash
pnpm typecheck
pnpm test
```

Confirm workspace typechecks and all package tests pass. Report exact commands and counts.

- [ ] **Step 5: Self-review and commit**

Review the diff for unnecessary API churn, duplicated expiry logic, loss of existing cache guards, and tests that assert mocks instead of behavior. Commit only the plan/spec, implementation, and regression tests:

```bash
git add docs/superpowers/specs/2026-08-18-available-drops-cache-ttl.md docs/superpowers/plans/2026-08-18-available-drops-cache-ttl.md packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "fix(twitch): apply availability ttl per campaign"
```
