# Twitch Subscription Drops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Represent Twitch subscription-based Drops as first-class rewards across the shared engine, popup, and CLI while keeping Twitch authoritative and never opening a stream solely for a subscription requirement.

**Architecture:** Add a backward-compatible reward-requirement classifier in `@lurkloot/shared`, populate it from Twitch campaign data, and use it at every scheduling and presentation boundary. The scheduler continues to claim any Twitch-confirmed reward but selects only watch requirements; the popup renders mixed or subscription-only campaigns explicitly and reuses `tickNow` for its in-card refresh; the CLI reports the same waiting state from shared campaign data.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest 4, React 19, WXT, yargs, JSON locale catalogs.

## Global Constraints

- Twitch is the sole authority for whether a subscription requirement has been earned; no local completion override is permitted.
- A qualifying subscription is purchased or gifted during the campaign on an eligible channel, not an existing channel subscription.
- Unknown partial subscription progress must be displayed as unknown, never inferred as zero.
- Subscription-only campaigns must never start or retain a watch session.
- Campaign visibility is a popup-only setting; it must not affect discovery, polling, claiming, or CLI behavior.
- Existing persisted rewards without a requirement discriminator must remain readable through inference from `requiredSubs`, `requiredMinutes`, and `isWatchBased`.
- Do not add credentials, payment handling, subscription purchasing, or new browser permissions.
- Add every new popup string to all ten locale catalogs.

---

## File Map

- Create `packages/shared/src/rewards.ts`: canonical requirement inference and campaign predicates shared by core, popup, and CLI.
- Modify `packages/shared/src/models.ts`: reward requirement and subscription-waiting eligibility contracts; subscription visibility filter.
- Modify `packages/shared/src/settings.ts`: default-on normalization for the subscription campaign filter.
- Modify `packages/shared/package.json`: export `@lurkloot/shared/rewards`.
- Modify `packages/core/src/platforms/twitch/parser.ts`: classify Twitch rewards and compute eligibility/completion from all supported reward types.
- Modify `packages/core/src/platforms/kick/parser.ts`: annotate known watch/action requirements consistently.
- Modify `packages/core/src/core/scheduler.ts`: use shared predicates for selection, status, and post-claim prerequisite recomputation.
- Modify `packages/core/src/background/controller.ts`: use shared predicates for notifications and manual-claim campaign completion.
- Modify `packages/popup-ui/src/types.ts`, `viewModels.ts`, `drops.tsx`, `Popup.tsx`, and `constants.ts`: preserve every reward in view data, render requirement-aware summaries/cards, wire refresh, and add the filter.
- Modify `packages/locales/messages/*.json`: localized labels and explanatory copy.
- Modify `packages/cli/src/index.ts` and `packages/cli/src/runtime/run.ts`: discovery and run-loop subscription status reporting; `run --once` remains the explicit non-interactive refresh operation.
- Modify extension and CLI tests listed in each task; no production dependency changes are required.

---

### Task 1: Shared reward requirements and default-on visibility filter

**Files:**
- Create: `packages/shared/src/rewards.ts`
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Modify: `packages/shared/package.json`
- Test: `packages/extension/tests/settings.test.ts`
- Test: `packages/extension/tests/rewards.test.ts`

**Interfaces:**
- Produces: `RewardRequirementType`, `rewardRequirementType(reward)`, `isWatchReward(reward)`, `isSubscriptionReward(reward)`, `campaignHasWatchRewards(campaign)`, and `campaignHasSubscriptionRewards(campaign)`.
- Produces: `DropCampaign["eligibility"]` value `waiting_for_subscription` and `CampaignFilterKey` value `subscription`.
- Consumes: legacy `DropReward.isWatchBased` only as a persisted-state fallback.

- [ ] **Step 1: Write failing shared-classification tests**

Create `packages/extension/tests/rewards.test.ts` with cases proving that an explicit requirement wins, `requiredSubs > 0` infers subscription, positive minutes infer watch, a legacy `isWatchBased: false` reward infers action, and campaign predicates recognize mixed campaigns:

```ts
import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import {
  campaignHasSubscriptionRewards,
  campaignHasWatchRewards,
  rewardRequirementType,
} from "@lurkloot/shared/rewards";

const reward = (patch: Partial<DropReward>): DropReward => ({
  id: "reward",
  name: "Reward",
  requiredMinutes: 0,
  watchedMinutes: 0,
  status: "locked",
  ...patch,
});

describe("reward requirements", () => {
  it("classifies explicit and legacy rewards", () => {
    expect(rewardRequirementType(reward({ requirement: "subscription", requiredMinutes: 60 }))).toBe("subscription");
    expect(rewardRequirementType(reward({ requiredSubs: 1 }))).toBe("subscription");
    expect(rewardRequirementType(reward({ requiredMinutes: 30 }))).toBe("watch");
    expect(rewardRequirementType(reward({ isWatchBased: false }))).toBe("action");
  });

  it("detects both requirement types in a mixed campaign", () => {
    const campaign = {
      rewards: [reward({ requirement: "subscription", requiredSubs: 1 }), reward({ requirement: "watch", requiredMinutes: 30 })],
    } as DropCampaign;
    expect(campaignHasSubscriptionRewards(campaign)).toBe(true);
    expect(campaignHasWatchRewards(campaign)).toBe(true);
  });
});
```

- [ ] **Step 2: Extend the settings test with migration/default assertions**

In `packages/extension/tests/settings.test.ts`, assert that `DEFAULT_SETTINGS.campaignVisibility.subscription` is `true`, a persisted `false` remains false, and an older object missing the key migrates to true:

```ts
expect(DEFAULT_SETTINGS.campaignVisibility.subscription).toBe(true);
expect(mergeSettings({ campaignVisibility: { subscription: false } }).campaignVisibility.subscription).toBe(false);
expect(mergeSettings({ campaignVisibility: { expired: true } }).campaignVisibility.subscription).toBe(true);
```

- [ ] **Step 3: Run the new tests and confirm the contracts are missing**

Run: `pnpm --filter @lurkloot/extension test -- rewards.test.ts settings.test.ts`

Expected: FAIL because `@lurkloot/shared/rewards`, `requirement`, `waiting_for_subscription`, and the `subscription` filter key do not exist.

- [ ] **Step 4: Add the shared contracts and classifier**

Add to `packages/shared/src/models.ts`:

```ts
export type RewardRequirementType = "watch" | "subscription" | "action";

export interface DropReward {
  // Existing fields remain unchanged.
  requirement?: RewardRequirementType;
}
```

Extend campaign eligibility with `"waiting_for_subscription"` and extend `CampaignFilterKey` with `"subscription"`. Create `packages/shared/src/rewards.ts`:

```ts
import type { DropCampaign, DropReward, RewardRequirementType } from "./models";

type RequirementFields = Pick<DropReward, "requirement" | "requiredMinutes" | "requiredSubs" | "isWatchBased">;

export function rewardRequirementType(reward: RequirementFields): RewardRequirementType {
  if (reward.requirement) return reward.requirement;
  if ((reward.requiredSubs ?? 0) > 0) return "subscription";
  if (reward.requiredMinutes > 0 && reward.isWatchBased !== false) return "watch";
  return "action";
}

export const isWatchReward = (reward: RequirementFields): boolean => rewardRequirementType(reward) === "watch";
export const isSubscriptionReward = (reward: RequirementFields): boolean => rewardRequirementType(reward) === "subscription";
export const campaignHasWatchRewards = (campaign: Pick<DropCampaign, "rewards">): boolean => campaign.rewards.some(isWatchReward);
export const campaignHasSubscriptionRewards = (campaign: Pick<DropCampaign, "rewards">): boolean => campaign.rewards.some(isSubscriptionReward);
```

Export `./rewards` from `packages/shared/package.json`.

- [ ] **Step 5: Normalize the new popup filter**

Add `"subscription"` to `CAMPAIGN_FILTER_KEYS` and set `campaignVisibility.subscription: true` in `DEFAULT_SETTINGS`. Do not add it to `EngineSettings`; it remains part of `ExtensionSettings` only.

- [ ] **Step 6: Run focused tests**

Run: `pnpm --filter @lurkloot/extension test -- rewards.test.ts settings.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/extension/tests/rewards.test.ts packages/extension/tests/settings.test.ts
git commit -m "feat(shared): model subscription drop requirements"
```

### Task 2: Twitch parsing, eligibility, and progress merging

**Files:**
- Modify: `packages/core/src/platforms/twitch/parser.ts`
- Modify: `packages/core/src/platforms/kick/parser.ts`
- Test: `packages/extension/tests/parsers.test.ts`

**Interfaces:**
- Consumes: `rewardRequirementType`, `isWatchReward`, and `isSubscriptionReward` from Task 1.
- Produces: Twitch rewards with explicit `requirement`; subscription-only campaigns with `eligibility: "waiting_for_subscription"`; claimed subscription campaigns with `status: "completed"`.

- [ ] **Step 1: Replace the existing subscription parser assertions with requirement-aware failing cases**

In `packages/extension/tests/parsers.test.ts`, cover subscription-only, mixed, claimed, and unknown action campaigns. The subscription-only assertion must include:

```ts
expect(campaigns[0]).toMatchObject({
  eligibility: "waiting_for_subscription",
  eligibilityReason: "Waiting for a qualifying subscription",
});
expect(campaigns[0].rewards[0]).toMatchObject({
  requirement: "subscription",
  requiredSubs: 1,
  isWatchBased: false,
});
```

Add a claimed-subscription case where `self.isClaimed` is true and assert `status: "completed"`. Keep a zero-minute/no-sub case and assert `requirement: "action"` with `eligibility: "no_rewards"`. Add a Kick assertion that positive-duration rewards are `watch` and zero-duration rewards are `action`.

- [ ] **Step 2: Run parser tests and verify the old `no_rewards` behavior fails**

Run: `pnpm --filter @lurkloot/extension test -- parsers.test.ts`

Expected: FAIL because subscription-only campaigns still use `no_rewards` and parsed rewards have no explicit requirement.

- [ ] **Step 3: Classify parsed rewards at the source**

In `parseTwitchReward`, compute and return:

```ts
const requirement = requiredSubs > 0
  ? "subscription" as const
  : requiredMinutes > 0
    ? "watch" as const
    : "action" as const;
const isWatchBased = requirement === "watch";
```

Keep real `dropInstanceID` handling unchanged: subscription rewards become claimable only when Twitch supplies the instance, and synthetic claim IDs remain watch-only. In the Kick parser, set `requirement` to `watch` only for positive required minutes and `action` otherwise.

- [ ] **Step 4: Make campaign eligibility requirement-aware**

Change the parser eligibility helpers to accept `DropReward[]`. Apply lifecycle/account-link checks first, then:

```ts
if (rewards.some(isWatchReward)) return "eligible";
if (rewards.some((reward) => isSubscriptionReward(reward) && reward.status !== "claimed")) return "waiting_for_subscription";
if (rewards.length > 0 && rewards.every((reward) => reward.status === "claimed")) return "completed";
return "no_rewards";
```

Return `Waiting for a qualifying subscription` for the waiting reason. Compute campaign completion from every tracked reward being claimed, not only watch rewards, so a mixed campaign remains active while an unclaimed subscription reward is still available. Apply the same logic in `mergeTwitchCampaignProgress` and `withCampaignStatus`.

- [ ] **Step 5: Run parser and adapter tests**

Run: `pnpm --filter @lurkloot/extension test -- parsers.test.ts adapters.test.ts`

Expected: PASS, including existing claim-instance reconstruction tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/platforms/twitch/parser.ts packages/core/src/platforms/kick/parser.ts packages/extension/tests/parsers.test.ts
git commit -m "feat(twitch): classify subscription drops"
```

### Task 3: Scheduler safety, auto-claim, and prerequisite unlocking

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/scheduler.test.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: Task 1 requirement predicates and Task 2 eligibility.
- Produces: watch decisions that ignore subscription requirements, auto-claim transitions that recompute prerequisites, and consistent campaign completion after manual/automatic claims.

- [ ] **Step 1: Add failing scheduler tests for subscription-only and chained campaigns**

Extend the existing non-watch claim test in `packages/extension/tests/scheduler.test.ts` to use `requirement: "subscription"`, `requiredSubs: 1`, and `eligibility: "waiting_for_subscription"`. Add a locked subscription-only case and assert:

```ts
expect(twitch.listCandidateChannels).not.toHaveBeenCalled();
expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
expect(result.state.sessions.twitch.status).toBe("idle");
expect(result.state.sessions.twitch.reasonCode).toBe("campaign_ineligible");
```

Add a chained case with a claimable subscription prerequisite and a locked watch reward whose `preconditionRewardIds` references it. After auto-claim, assert the subscription is claimed, the watch reward has `preconditionsMet: true`, and the resulting session targets the watch reward in the same tick.

- [ ] **Step 2: Add a failing controller test for manual claim consistency**

In `packages/extension/tests/backgroundController.test.ts`, manually claim the last subscription reward via `claimReward` and assert the stored campaign becomes completed only when all rewards are claimed. In a mixed campaign with an unclaimed watch reward, assert the campaign remains active.

- [ ] **Step 3: Run focused tests**

Run: `pnpm --filter @lurkloot/extension test -- scheduler.test.ts backgroundController.test.ts`

Expected: FAIL because the scheduler does not recompute prerequisites after auto-claim and completion still filters by `isWatchBased` in several paths.

- [ ] **Step 4: Replace direct watch-flag checks with the shared predicate**

Import `isWatchReward` in scheduler/controller code. Use it in active reward selection, earnability checks, completion calculations, and `hasEarnableReward`. Preserve claimability as requirement-agnostic so Twitch-confirmed subscription rewards still auto-claim.

- [ ] **Step 5: Recompute prerequisites after an automatic claim**

At the end of each campaign iteration in `claimReadyRewards`, recompute reward prerequisites from the updated reward list before calculating status:

```ts
const claimedIds = new Set(rewards.filter((reward) => reward.status === "claimed").map((reward) => reward.id));
const unlockedRewards = rewards.map((reward) => ({
  ...reward,
  preconditionsMet: (reward.preconditionRewardIds ?? []).every((id) => claimedIds.has(id)),
}));
const completed = unlockedRewards.length > 0 && unlockedRewards.every((reward) => reward.status === "claimed");
```

Store `unlockedRewards`, and set completed only from the all-reward condition. Apply that same completion rule to `claimRewardNow` in the controller.

- [ ] **Step 6: Improve the idle reason without making waiting campaigns eligible**

In `idleReason`, before the generic `no_rewards` check, recognize an all-subscription waiting set and return `Waiting for a qualifying subscription`. Do not admit `waiting_for_subscription` through `isEligible`; mixed campaigns remain `eligible` from the parser because they contain watch rewards, while reward-level prerequisite checks determine whether a watch target exists.

- [ ] **Step 7: Run scheduler/controller tests**

Run: `pnpm --filter @lurkloot/extension test -- scheduler.test.ts backgroundController.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts packages/extension/tests/scheduler.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(scheduler): wait safely for subscription drops"
```

### Task 4: Popup view model and campaign visibility

**Files:**
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/viewModels.ts`
- Modify: `packages/popup-ui/src/constants.ts`
- Test: `packages/extension/tests/subscriptionDropsView.test.ts`

**Interfaces:**
- Consumes: shared requirement predicates and `campaignVisibility.subscription`.
- Produces: requirement-aware `RewardView`, `CampaignView.hasWatchRewards`, `CampaignView.hasSubscriptionRewards`, and discriminated `CampaignStats` for watch/mixed/subscription-only summaries.

- [ ] **Step 1: Write failing view-model tests**

Create `packages/extension/tests/subscriptionDropsView.test.ts`. Build one subscription-only and one mixed `DropCampaign`, then assert:

```ts
expect(view.rewards).toHaveLength(2);
expect(view.rewards[0]).toMatchObject({ requirement: "subscription", requiredSubs: 1, progress: undefined });
expect(view.hasSubscriptionRewards).toBe(true);
expect(view.hasWatchRewards).toBe(false);
expect(campaignStats(view)).toMatchObject({ kind: "subscription", completed: 0, totalRewards: 2 });
```

For the mixed campaign, assert `kind: "mixed"`, totals include both reward types, and watch minutes are calculated from watch rewards only. Assert `campaignFilterCategories` returns `subscription`, `isCampaignVisible` defaults to true, and becomes false only when `campaignVisibility.subscription` is false and no other active visibility category applies.

- [ ] **Step 2: Run the new view tests**

Run: `pnpm --filter @lurkloot/extension test -- subscriptionDropsView.test.ts`

Expected: FAIL because subscription rewards are filtered out and the filter/category contracts are absent.

- [ ] **Step 3: Extend popup types without fabricating progress**

Change `RewardView` so `progress` is optional and add `requirement` plus `requiredSubs`. Add `hasWatchRewards` and `hasSubscriptionRewards` to `CampaignView`. Define:

```ts
export type CampaignStats = {
  kind: "watch" | "subscription" | "mixed" | "action";
  totalRequired: number;
  totalFarmed: number;
  remaining: number;
  progress?: number;
  completed: number;
  totalRewards: number;
  nextReward?: RewardView;
  complete: boolean;
};
```

- [ ] **Step 4: Preserve all rewards in the campaign view**

Remove the `.filter((reward) => reward.isWatchBased !== false)` in `campaignViewFromCampaign`. For watch rewards, calculate percentage from minutes. For claimed non-watch rewards, use `100`; otherwise leave `progress` undefined. Populate `requirement`, `requiredSubs`, and the two campaign predicates.

Update `campaignStats` so minute totals only include watch rewards, reward counts include every reward, subscription/action rewards never contribute fake minutes, and `kind` reflects the campaign mixture. A campaign is complete when it has rewards and every reward is obtained.

- [ ] **Step 5: Add subscription campaign filtering**

Push `subscription` from `campaignFilterCategories` when `campaignHasSubscriptionRewards(campaign)` is true. Add `{ key: "subscription", label: "subscriptionCampaigns" }` to `CAMPAIGN_FILTERS`. Preserve the existing rule that claimable campaigns are visible regardless of filter settings.

- [ ] **Step 6: Run view/settings tests**

Run: `pnpm --filter @lurkloot/extension test -- subscriptionDropsView.test.ts settings.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/popup-ui/src/types.ts packages/popup-ui/src/viewModels.ts packages/popup-ui/src/constants.ts packages/extension/tests/subscriptionDropsView.test.ts
git commit -m "feat(popup): model subscription campaign views"
```

### Task 5: Popup rendering and in-card authoritative refresh

**Files:**
- Modify: `packages/popup-ui/src/drops.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Test: `packages/extension/tests/subscriptionDropsView.test.ts`

**Interfaces:**
- Consumes: Task 4 view types and the existing `refreshNow(): Promise<void>` function.
- Produces: `DropsPanel.onRefreshCampaign(id)` and requirement-aware card/reward rendering.

- [ ] **Step 1: Add failing static-render tests**

Render an expanded subscription-only card through `DropsPanel` and assert the markup contains translation keys or English test messages for `Subscription required`, `Requires 3 qualifying subscriptions`, `Progress unavailable`, and `Not earnable by watching`. Assert it does not contain `0/0`, `<1m`, or `Exclude from farming`. For a mixed campaign, assert the exclusion action remains present and both watch and subscription reward names render.

- [ ] **Step 2: Run the render test**

Run: `pnpm --filter @lurkloot/extension test -- subscriptionDropsView.test.ts`

Expected: FAIL because the card always renders watch-time statistics and exclusion controls.

- [ ] **Step 3: Thread refresh through the existing component boundary**

Add `onRefreshCampaign(id: string): void | Promise<void>` and `refreshing: boolean` to `DropsPanel`, `SortableCampaign`, and `CampaignCard`. In `Popup.tsx`, pass:

```tsx
onRefreshCampaign={() => refreshNow()}
refreshing={refreshing}
```

The campaign id is retained in the callback signature for future targeted refresh support, but the first implementation intentionally reuses the authoritative full `tickNow` operation.

- [ ] **Step 4: Render summary content by `stats.kind`**

For `subscription`, replace progress percentage/bar and the watch summary grid with subscription copy and reward counts. For `mixed`, retain watch progress while adding a visible subscription-required pill and ensuring `nextReward` can name either type without assigning subscription minutes. For `action`, use `Action required` and omit watch statistics.

Inside the expanded subscription section, add a button:

```tsx
<button type="button" onClick={() => void onRefreshCampaign?.(campaign.id)} disabled={refreshing}>
  <RotateCcw size={12} className={cn(refreshing && "animate-spin")} />
  {t("subscribedRefresh")}
</button>
```

Show the exclusion button only when `campaign.hasWatchRewards` is true.

- [ ] **Step 5: Make reward tiles requirement-aware**

Watch tiles keep percentage and duration. Subscription tiles show `Subscription required`, `Requires $1 qualifying subscriptions`, and either `Earned` when obtained or `Progress unavailable` when not. Action tiles show `Action required`. Never render `0%` for an unknown subscription state.

- [ ] **Step 6: Run the popup view tests**

Run: `pnpm --filter @lurkloot/extension test -- subscriptionDropsView.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/popup-ui/src/drops.tsx packages/popup-ui/src/Popup.tsx packages/extension/tests/subscriptionDropsView.test.ts
git commit -m "feat(popup): render subscription drop campaigns"
```

### Task 6: Localized subscription-drop copy

**Files:**
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/zh_CN.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ar.json`
- Test: `packages/extension/tests/i18n.test.ts`

**Interfaces:**
- Produces keys consumed by Tasks 4–5: `subscriptionCampaigns`, `subscriptionRequired`, `subscriptionRewards`, `qualifyingSubscriptionsRequired`, `subscriptionProgressUnknown`, `notEarnableByWatching`, `subscribedRefresh`, `waitingForSubscription`, `actionRequired`, and `earned`.

- [ ] **Step 1: Add the English source messages**

Use these exact English messages and `$1` substitution semantics:

```json
"subscriptionCampaigns": { "message": "Subscription" },
"subscriptionRequired": { "message": "Subscription required" },
"subscriptionRewards": { "message": "Subscription rewards" },
"qualifyingSubscriptionsRequired": { "message": "$1 qualifying subscriptions required" },
"subscriptionProgressUnknown": { "message": "Progress unavailable" },
"notEarnableByWatching": { "message": "Not earnable by watching" },
"subscribedRefresh": { "message": "I've subscribed — refresh status" },
"waitingForSubscription": { "message": "Waiting for a qualifying subscription" },
"actionRequired": { "message": "Action required" },
"earned": { "message": "Earned" }
```

- [ ] **Step 2: Add equivalent native translations to every other catalog**

Keep the same keys and placeholders in all catalogs. Do not copy English values into non-English catalogs; preserve Arabic RTL-friendly wording and the existing JSON formatting.

- [ ] **Step 3: Run catalog parity tests**

Run: `pnpm --filter @lurkloot/extension test -- i18n.test.ts`

Expected: PASS with identical key sets and no disallowed untranslated English values.

- [ ] **Step 4: Commit**

```bash
git add packages/locales/messages packages/extension/tests/i18n.test.ts
git commit -m "feat(locales): translate subscription drop states"
```

### Task 7: CLI discovery and waiting-state reporting

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/runtime/run.ts`
- Modify: `packages/cli/README.md`
- Test: `packages/cli/tests/runtime.test.ts`

**Interfaces:**
- Consumes: shared requirement predicates and campaign/reward state.
- Produces: `formatDiscoveredCampaign(campaign): string[]` and `subscriptionWaitKeys(campaigns): Map<string, string>` pure helpers for deterministic testing.
- Keeps: `lurkloot run --once` as the explicit non-interactive refresh command; it performs discovery, authoritative progress refresh, claim, state persistence, and exit.

- [ ] **Step 1: Add failing CLI formatter tests**

In `packages/cli/tests/runtime.test.ts`, assert a subscription-only campaign formats as:

```text
• ARC Raiders Summer Drops — waiting for subscription
  ◦ Purple Duffel Bag — requires 1 qualifying subscription; progress unavailable
  ◦ Bastion Mace — requires 3 qualifying subscriptions; progress unavailable
```

Assert claimed rewards say `earned`, mixed campaigns include both watch and subscription lines, and `subscriptionWaitKeys` returns one stable key per unclaimed subscription reward.

- [ ] **Step 2: Run the CLI test**

Run: `pnpm --filter @lurkloot/cli test -- runtime.test.ts`

Expected: FAIL because discovery logs names only and the helpers do not exist.

- [ ] **Step 3: Implement pure CLI status formatting**

Export formatting helpers from `packages/cli/src/runtime/run.ts` or a focused `packages/cli/src/runtime/status.ts` if `run.ts` would exceed its current single-loop responsibility. Format subscription progress as unavailable unless Twitch supplied an authoritative state; never print `0/N`. Use singular `subscription` for one and plural otherwise.

- [ ] **Step 4: Use the formatter in `discover`**

Change `discoverPlatform` to accept `DropCampaign[]` and log every line from the first twenty formatted campaigns. Keep the existing WAF error behavior unchanged.

- [ ] **Step 5: Report waiting transitions once per run-loop process**

Maintain a `Set<string>` in `runLoop`. After each successful tick, load the saved state, compute waiting subscription keys, and log only newly observed entries:

```ts
logger.info(`Waiting for ${required} qualifying ${required === 1 ? "subscription" : "subscriptions"}: ${reward.name} from ${campaign.name}`, campaign.platform);
```

Remove keys that disappear so a future reappearance can be reported. Existing `reward_claimed` engine events continue to report Twitch-confirmed claims.

- [ ] **Step 6: Document CLI refresh and status behavior**

In `packages/cli/README.md`, document that `pnpm cli run --once` is the explicit refresh operation, subscription requirements are never farmed by opening streams, partial counts may be unavailable, and the normal loop detects/claims Twitch-confirmed rewards on its next poll.

- [ ] **Step 7: Run CLI tests and typecheck**

Run: `pnpm --filter @lurkloot/cli test && pnpm --filter @lurkloot/cli typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src packages/cli/tests/runtime.test.ts packages/cli/README.md
git commit -m "feat(cli): report subscription drop requirements"
```

### Task 8: Cross-package regression verification

**Files:**
- Modify only files required to correct failures directly caused by Tasks 1–7.

**Interfaces:**
- Validates the public shared model, extension host, CLI host, site demo, and browser builds together.

- [ ] **Step 1: Run all workspace tests**

Run: `pnpm test`

Expected: all extension and CLI Vitest suites PASS.

- [ ] **Step 2: Run all workspace typechecks**

Run: `pnpm typecheck`

Expected: every workspace typecheck PASS.

- [ ] **Step 3: Run repository checks**

Run: `pnpm check`

Expected: script tests, typechecks, unit tests, and the Astro site build PASS.

- [ ] **Step 4: Build both extension targets**

Run: `pnpm build && pnpm build:firefox`

Expected: Chromium and Firefox WXT production builds complete successfully with no new permissions.

- [ ] **Step 5: Manually inspect representative popup states**

Using the existing popup demo/preview data, inspect one watch-only, one subscription-only, and one mixed campaign at 400×600. Verify no horizontal overflow, subscription-only cards contain no watch-minute artifacts, mixed cards retain exclusion controls, reward carousel navigation still works, and the in-card refresh spinner cannot submit concurrently.

- [ ] **Step 6: Commit any verification-only corrections**

```bash
git add packages
git commit -m "test(twitch): cover subscription drop workflows"
```

Skip this commit when verification required no corrections.

---

## Completion Checklist

- [ ] Subscription campaigns are shown by default and can be hidden with the popup-only Subscription filter.
- [ ] Twitch parser state, not local user input, controls earned/claimable status.
- [ ] Unknown partial counts remain unknown in popup and CLI.
- [ ] Subscription-only campaigns never create watch sessions.
- [ ] Confirmed subscription rewards auto-claim and unlock chained watch rewards.
- [ ] Popup refresh reuses `tickNow` and does not mutate eligibility locally.
- [ ] CLI discovery and run-loop output expose waiting status; `run --once` provides explicit refresh.
- [ ] All catalogs, tests, typechecks, site build, and both browser builds pass.
