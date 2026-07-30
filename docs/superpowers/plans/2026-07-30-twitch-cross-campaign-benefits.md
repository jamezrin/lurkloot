# Twitch Cross-Campaign Benefit Claim-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent rewards claimed in an earlier Twitch campaign from marking partially watched rewards with reused benefit IDs claimed in the current campaign.

**Architecture:** When inventory v2 provides `earnedDropRewards`, treat a matching `dropCampaignsInProgress` entry as authoritative and suppress the campaign-agnostic `gameEventDrops` fallback. Preserve legacy v1 behavior and the ownership fallback for campaigns absent from the progress payload.

**Tech Stack:** TypeScript, Vitest, pnpm workspace

## Global Constraints

- Keep the change confined to the Twitch parser and its deterministic parser tests.
- Do not change shared models, storage, scheduler behavior, UI, permissions, or localization.
- Preserve the ownership fallback for inventory v1 and when a campaign is absent from `dropCampaignsInProgress`.
- Use strict TypeScript, explicit imports, two-space indentation, double quotes, and semicolons.

---

### Task 1: Make Current Twitch Progress Authoritative

**Files:**
- Modify: `packages/extension/tests/parsers.test.ts`
- Modify: `packages/core/src/platforms/twitch/parser.ts`

**Interfaces:**
- Consumes: `parseTwitchInventory(input): DropCampaign[]` and `mergeTwitchCampaignProgress(campaigns, inventory): DropCampaign[]`
- Produces: unchanged public interfaces; only claim-state precedence changes

- [ ] **Step 1: Add failing direct-parse and merge regression tests**

Add two tests under `describe("Twitch parsers")`. Both use a v2 response with
an empty `earnedDropRewards.edges` array and one reward with
`requiredMinutesWatched: 420`, `currentMinutesWatched: 210`,
`isClaimed: false`, and benefit ID `"reused-lootbox"`, while
`gameEventDrops` contains `"reused-lootbox"`.

The direct test calls `parseTwitchInventory` with the campaign under
`dropCampaignsInProgress` and asserts:

```ts
expect(campaigns[0].rewards[0]).toMatchObject({
  watchedMinutes: 210,
  status: "in_progress",
});
```

The merge test creates campaign details through `parseTwitchCampaigns`, merges
the same in-progress inventory, and asserts the identical literal result.

- [ ] **Step 2: Run the focused tests and verify the regression fails**

Run:

```bash
pnpm --filter @lurkloot/extension test -- parsers.test.ts
```

Expected: both new tests fail because the reward is reported with
`watchedMinutes: 420` and `status: "claimed"`.

- [ ] **Step 3: Suppress ownership inference while per-tier progress exists**

In `parseTwitchCampaignSource`, suppress ownership-eligible benefit IDs when
`source.hasPerTierProgress` is true and `source.earnedCounts` is defined. Pass
that empty set through the existing `parseTwitchReward` path for v2
`dropCampaignsInProgress`; retain the existing shared-benefit filtering for v1.

In `mergeTwitchCampaignProgress`, require either no matching progress campaign
or no v2 earned counts before applying the `gameEventDrops` fallback:

```ts
if (
  (!progress || !earnedCounts)
  && merged.status !== "claimed"
  && isWatchReward(merged)
  && ownsRewardBenefit(...)
) {
```

Do not alter the campaign-scoped `claimedByEarned` branch. Use an explicit
`earnedCounts !== undefined` check in production if it reads more clearly than
the abbreviated plan expression.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
pnpm --filter @lurkloot/extension test -- parsers.test.ts
```

Expected: all parser tests pass.

- [ ] **Step 5: Verify historical fallback coverage**

Run the existing parser tests that cover both legacy v1 in-progress ownership
and an owned reward whose campaign is absent from `dropCampaignsInProgress`.
Confirm their claimed/completed assertions remain green. If the direct parsing
test no longer clearly exercises a bare campaign source, add a literal
regression using `dropCampaigns` rather than `dropCampaignsInProgress` and
assert:

```ts
expect(campaigns[0].rewards[0]).toMatchObject({
  watchedMinutes: 420,
  status: "claimed",
});
```

- [ ] **Step 6: Run repository verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm check
git diff --check
```

Expected: every command exits zero with no test, type, build, or whitespace
failures.

- [ ] **Step 7: Commit the fix**

```bash
git add packages/core/src/platforms/twitch/parser.ts packages/extension/tests/parsers.test.ts
git commit -m "fix(twitch): trust current campaign reward progress"
```
