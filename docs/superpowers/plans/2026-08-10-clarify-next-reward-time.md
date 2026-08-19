# Clarify Next Reward Remaining Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show reward-specific remaining watch time beside the next reward while retaining and clearly labeling the campaign-wide remaining total.

**Architecture:** Extend the existing `CampaignStats` view-model contract with a derived `nextRewardRemaining` field. Keep UI formatting in `drops.tsx`, and add one localized `campaignLeft` key to every catalog.

**Tech Stack:** TypeScript, React, Vitest, pnpm workspaces, JSON locale catalogs

## Global Constraints

- `remaining` remains the campaign-wide total across all watch rewards.
- `nextRewardRemaining` is the next incomplete watch reward's own remaining minutes, clamped to zero.
- The next-reward row uses `nextRewardRemaining`; the summary statistic uses `remaining`.
- The summary label uses a localized `campaignLeft` key in every locale catalog.
- Diagnostic messages remain English literals and are unaffected.
- Follow strict TypeScript, ES modules, two-space indentation, double quotes, and semicolons.

---

### Task 1: Separate next-reward and campaign remaining time

**Files:**
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/viewModels.ts`
- Modify: `packages/popup-ui/src/drops.tsx`
- Modify: `packages/locales/messages/{ar,de,en,es,fr,hi,it,pt_BR,ru,tr,zh_CN}.json`
- Test: `packages/extension/tests/subscriptionDropsView.test.ts`

**Interfaces:**
- Consumes: `CampaignView.rewards`, `RewardView.requiredMinutes`, `RewardView.progress`, and the existing `rewardComplete()` predicate.
- Produces: `CampaignStats.nextRewardRemaining?: number` and the `campaignLeft` locale message.

- [ ] **Step 1: Write failing view-model and rendering tests**

Add a test using four untouched sequential watch rewards of 30, 60, 120, and 240 minutes. Assert that `campaignStats(view)` contains `remaining: 450` and `nextRewardRemaining: 30`. Render the expanded view and assert that the next-reward row contains `30m left`, the summary contains `7h 30m`, and the localized summary label resolves to `Campaign left` rather than the raw key.

Add a second test whose next incomplete watch reward has `requiredMinutes: 60`, `watchedMinutes: 15`, and `status: "in_progress"`. Assert `nextRewardRemaining: 45`.

Add `campaignLeft: "Campaign left"`, `left: "Left"`, and `nextReward: "Next: $1"` to `testMessages` so the rendering assertions exercise translated copy.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- subscriptionDropsView.test.ts`

Expected: FAIL because `nextRewardRemaining` is absent and the rendered next-reward time still uses the 450-minute campaign total.

- [ ] **Step 3: Extend the view model and update the UI**

Add `nextRewardRemaining?: number` to `CampaignStats`. In `campaignStats()`, preserve the actual incomplete reward separately from the display fallback and calculate the value only when `nextIncompleteReward.requirement === "watch"`:

```ts
const nextRewardRemaining = nextIncompleteReward?.requirement === "watch"
  ? Math.max(nextIncompleteReward.requiredMinutes * (1 - (nextIncompleteReward.progress ?? 0) / 100), 0)
  : undefined;
```

Include `nextRewardRemaining` in the returned stats object. In `drops.tsx`, format `stats.nextRewardRemaining` beside `Next: <reward>`, while leaving `stats.remaining` as the summary value. Change the summary `MetaStat` label from `t("left")` to `t("campaignLeft")`.

- [ ] **Step 4: Add the localized summary label**

Insert `campaignLeft` next to `left` in every locale catalog with these messages:

```text
ar: المتبقي للحملة
de: Kampagne übrig
en: Campaign left
es: Restante de campaña
fr: Restant pour la campagne
hi: अभियान शेष
it: Campagna rimanente
pt_BR: Restante da campanha
ru: Осталось в кампании
tr: Kampanyada kalan
zh_CN: 活动剩余
```

- [ ] **Step 5: Verify GREEN and the repository checks**

Run the focused test until it passes:

`pnpm --filter @lurkloot/extension test -- subscriptionDropsView.test.ts`

Then run once before committing:

`pnpm check`

Expected: all tests, workspace typechecks, script checks, and the site build pass with no failures.

- [ ] **Step 6: Commit**

```bash
git add packages/popup-ui/src/types.ts packages/popup-ui/src/viewModels.ts packages/popup-ui/src/drops.tsx packages/locales/messages packages/extension/tests/subscriptionDropsView.test.ts
git commit -m "fix(popup): clarify next reward remaining time"
```

## As built

The shipped `campaignStats()` implementation uses `nextIncompleteReward` to calculate `nextRewardRemaining`, while `nextReward` retains the final-reward display fallback. This preserves `undefined` when no incomplete watch reward exists, including a completed but unclaimed reward, as covered by `subscriptionDropsView.test.ts`.
