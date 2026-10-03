# Subscription Marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user mark a Twitch subscription reward as subscribed, so Lurkloot behaves as if it had detected the qualifying subscription.

**Architecture:** The mark is a reward-level layer over the platform's report. A shared pure function, `applySubscriptionMarks`, stamps `DropReward.subscriptionMarked` from the per-platform setting `subscribedRewardMarks` and recomputes prerequisites. The engine applies it wherever adapter output enters (one helper, `reconcileRefreshedCampaigns`), and the popup applies it again for immediate feedback. Reward `status` and campaign `status`/`eligibility` are never changed by a mark.

**Tech Stack:** TypeScript (strict, ES modules), pnpm workspace, Vitest, React 19 popup rendered with linkedom in tests.

**Spec:** `docs/superpowers/specs/2026-10-03-subscription-marks-design.md`

## Global Constraints

- Work in `.worktrees/subscription-marks` on branch `feat/subscription-marks`. Never edit the main checkout.
- Platform adapters and parsers (`packages/core/src/platforms/**`) do not change and never see marks or settings.
- A mark never sets a reward's `status` (no `"claimed"`) or a campaign's `status`, `eligibility` or `eligibilityReason`.
- Mark keys are `"<campaignId>:<rewardId>"`, stored in `settings.platform[platform].subscribedRewardMarks`.
- A reward can be marked only when `requiredSubs > 0` and `status` is `"locked"` or `"in_progress"`.
- Popup copy keys: `subscriptionMarkSubscribed` = "Mark as subscribed", `subscriptionMarkedSubscribed` = "Marked as subscribed", `subscriptionMarkUndo` = "Undo", in all 11 catalogs (`ar de en es fr hi it pt_BR ru tr zh_CN`).
- Diagnostics stay English literals; no `diagnostic*` locale keys.
- Two-space indentation, double quotes, semicolons, `type` imports for types. Conventional Commits; never pass `--author`.
- Extension tests: `pnpm --dir packages/extension exec vitest run <file>`. CLI tests: `pnpm --dir packages/cli exec vitest run <file>`.
- This branch starts from `origin/develop` and does not contain the unmerged `fix/twitch-subscription-claims` (adds `DropReward.claimKey`) or `feat/popup-external-drop-details`. Whichever merges second gets trivial conflicts in `packages/shared/src/models.ts` (adjacent `DropReward` fields) and `packages/site/src/changelog.json`.

## Review Focus

1. **Twitch releases a marked reward.** The reward turns `claimable`. The mark must stop applying and Lurkloot must claim the reward normally. Tests: Task 2 "ignores a mark once the platform releases or confirms the reward", and Task 4 "claims a marked reward once Twitch releases it".
2. **Undo after a dependent watch reward started earning.** The dependent reward must be blocked again, and the scheduler must leave it. Test: Task 4 "never notifies, and undo restores the platform's view".
3. **A marked sub-plus-watch reward reaches its minutes but Twitch releases nothing.** It must stop being earnable, not be watched forever. Tests: Task 2 "makes a marked subscription plus watch reward a watch reward until its minutes are done", and Task 4 "rotates away from a marked subscription plus watch reward that stops accruing".
4. **Stale, malformed or foreign marks** (ended campaigns, typos, keys without a separator) must be inert. Campaigns with no marks of their own must come back as the same object, so stored state doesn't churn. Tests: Task 1 normalization, and Task 2 "leaves a campaign with no marks of its own untouched".
5. **A mark is never a claim.** It must never fire the "Reward earned" notification, and must never survive as a claim after Undo. Test: Task 4 "never notifies, and undo restores the platform's view".

---

### Task 1: The `subscribedRewardMarks` setting

**Files:**
- Modify: `packages/shared/src/models.ts` (`PlatformSettings`, around line 328)
- Modify: `packages/shared/src/settings.ts` (defaults around lines 44-66, `mergeEngineSettings` platform block around lines 148-170, new normalizer after `normalizeIdList` around line 365)
- Test: `packages/extension/tests/settings.test.ts`

**Interfaces:**
- Produces: `PlatformSettings.subscribedRewardMarks?: string[]` (always `[]` or a list after normalization); `normalizeSubscriptionMarks(value: string[] | undefined): string[]` exported from `@lurkloot/shared/settings` (used by the CLI in Task 5).

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `packages/extension/tests/settings.test.ts`:

```ts
import { buildSettingsExportPayload, parseSettingsImportPayload } from "@lurkloot/shared/settingsExport";
```

Append at the end of the file:

```ts
describe("subscription marks setting", () => {
  it("defaults to no marks on either platform", () => {
    const settings = mergeSettings(undefined);

    expect(settings.platform.twitch.subscribedRewardMarks).toEqual([]);
    expect(settings.platform.kick.subscribedRewardMarks).toEqual([]);
  });

  it("keeps campaign:reward keys verbatim and drops malformed entries", () => {
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: {
          ...DEFAULT_SETTINGS.platform.twitch,
          subscribedRewardMarks: [" Camp-1:Reward-A ", "Camp-1:Reward-A", "no-separator", ":reward", "campaign:", 7 as unknown as string],
        },
      },
    });

    expect(settings.platform.twitch.subscribedRewardMarks).toEqual(["Camp-1:Reward-A"]);
  });

  it("applies a platform patch and survives a settings export and import", () => {
    const patched = applySettingsPatch(DEFAULT_SETTINGS, { platform: { twitch: { subscribedRewardMarks: ["campaign:reward"] } } });

    expect(patched.platform.twitch.subscribedRewardMarks).toEqual(["campaign:reward"]);
    expect(patched.platform.kick.subscribedRewardMarks).toEqual([]);
    const file = JSON.parse(JSON.stringify(buildSettingsExportPayload(patched)));
    expect(parseSettingsImportPayload(file).settings.platform.twitch.subscribedRewardMarks).toEqual(["campaign:reward"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir packages/extension exec vitest run tests/settings.test.ts -t "subscription marks setting"`
Expected: FAIL. `subscribedRewardMarks` is `undefined`, and TypeScript accepts the literal only once the field exists, so a type error is also an acceptable red.

- [ ] **Step 3: Add the field**

In `packages/shared/src/models.ts`, inside `interface PlatformSettings`, after `blockedCategories: CategorySelection[];`:

```ts
  // "<campaignId>:<rewardId>" of subscription rewards the user marked as
  // subscribed. Lurkloot then treats that reward's subscription as detected
  // (docs/superpowers/specs/2026-10-03-subscription-marks-design.md).
  subscribedRewardMarks?: string[];
```

In `packages/shared/src/settings.ts`, add `subscribedRewardMarks: [],` after `blockedCategories: [],` in both `DEFAULT_ENGINE_SETTINGS.platform.twitch` and `DEFAULT_ENGINE_SETTINGS.platform.kick`.

In `mergeEngineSettings`, add after each platform's `blockedCategories` line:

```ts
        subscribedRewardMarks: normalizeSubscriptionMarks(platform?.twitch?.subscribedRewardMarks),
```

and, in the kick block:

```ts
        subscribedRewardMarks: normalizeSubscriptionMarks(platform?.kick?.subscribedRewardMarks),
```

After `normalizeIdList`, add:

```ts
// Subscription marks are "<campaignId>:<rewardId>". Ids are matched verbatim,
// as in normalizeIdList, and an entry missing either half is dropped.
export function normalizeSubscriptionMarks(value: string[] | undefined): string[] {
  return normalizeIdList(value).filter((item) => {
    const separator = item.indexOf(":");
    return separator > 0 && separator < item.length - 1;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir packages/extension exec vitest run tests/settings.test.ts`
Expected: PASS (the whole file, so existing settings tests still pass).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/extension/tests/settings.test.ts
git commit -m "feat(settings): store subscription reward marks per platform"
```

---

### Task 2: Mark semantics in `@lurkloot/shared/rewards`

**Files:**
- Modify: `packages/shared/src/models.ts` (`DropReward`, around line 44)
- Modify: `packages/shared/src/rewards.ts`
- Create: `packages/extension/tests/subscriptionMarks.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (marks are passed in as `readonly string[]`).
- Produces (all exported from `@lurkloot/shared/rewards`):
  - `subscriptionMarkKey(campaignId: string, rewardId: string): string` returns `"<campaignId>:<rewardId>"`.
  - `canMarkSubscription(reward: Pick<DropReward, "requiredSubs" | "status">): boolean`
  - `isRewardObtained(reward: Pick<DropReward, "status" | "subscriptionMarked" | "requiredMinutes">): boolean`
  - `applySubscriptionMarks(campaign: DropCampaign, marks: readonly string[]): DropCampaign`
  - Changed: `rewardRequirementType` (marked + minutes gives `"watch"`), `isRewardAvailableToEarn` (marked + minutes done gives `false`), `isWaitingSubscriptionReward` (marked gives `false`), `reconcileCampaignAfterClaims` (prerequisites via `isRewardObtained`, completion unchanged).
  - `DropReward.subscriptionMarked?: true`

- [ ] **Step 1: Write the failing tests**

Create `packages/extension/tests/subscriptionMarks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import {
  applySubscriptionMarks,
  canMarkSubscription,
  isRewardAvailableToEarn,
  isRewardObtained,
  isWaitingSubscriptionReward,
  isWatchReward,
  reconcileCampaignAfterClaims,
  rewardRequirementType,
  subscriptionMarkKey,
} from "@lurkloot/shared/rewards";

// Rewards as the Twitch parser reports them: a subscription reward, a watch
// reward that needs it first, and a reward that needs a subscription plus
// watch time. Their prerequisites are already reconciled, as parsed.
function subscriptionReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "sub", name: "Sub reward", requiredMinutes: 0, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function gatedWatchReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "watch", name: "Watch reward", requiredMinutes: 60, requirement: "watch", isWatchBased: true, watchedMinutes: 0, status: "locked", preconditionRewardIds: ["sub"], preconditionsMet: false, ...overrides };
}

function subscriptionPlusWatchReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "combined", name: "Watch and Subscribe", requiredMinutes: 60, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function twitchCampaign(rewards: DropReward[]): DropCampaign {
  return { id: "campaign", platform: "twitch", name: "Campaign", status: "active", eligibility: "waiting_for_subscription", endsAt: "2999-01-01T00:00:00.000Z", rewards };
}

const mark = (rewardId: string) => subscriptionMarkKey("campaign", rewardId);

describe("subscription marks", () => {
  it("keys a mark by campaign and reward", () => {
    expect(subscriptionMarkKey("campaign", "sub")).toBe("campaign:sub");
  });

  it("only offers a mark on a subscription reward the platform has not released", () => {
    expect(canMarkSubscription(subscriptionReward())).toBe(true);
    expect(canMarkSubscription(subscriptionReward({ status: "in_progress" }))).toBe(true);
    expect(canMarkSubscription(subscriptionReward({ status: "claimable" }))).toBe(false);
    expect(canMarkSubscription(subscriptionReward({ status: "claimed" }))).toBe(false);
    expect(canMarkSubscription(gatedWatchReward())).toBe(false);
  });

  it("treats a marked subscription reward as obtained and unlocks the rewards that need it", () => {
    const campaign = applySubscriptionMarks(twitchCampaign([subscriptionReward(), gatedWatchReward()]), [mark("sub")]);
    const [sub, watch] = campaign.rewards;

    expect(sub).toMatchObject({ subscriptionMarked: true, status: "locked" });
    expect(isRewardObtained(sub)).toBe(true);
    expect(isWaitingSubscriptionReward(sub)).toBe(false);
    expect(watch.preconditionsMet).toBe(true);
    expect(campaign.status).toBe("active");
    expect(campaign.eligibility).toBe("waiting_for_subscription");
  });

  it("makes a marked subscription plus watch reward a watch reward until its minutes are done", () => {
    const [reward] = applySubscriptionMarks(
      twitchCampaign([subscriptionPlusWatchReward({ watchedMinutes: 20, status: "in_progress" })]),
      [mark("combined")],
    ).rewards;

    expect(rewardRequirementType(reward)).toBe("watch");
    expect(isWatchReward(reward)).toBe(true);
    expect(isRewardObtained(reward)).toBe(false);
    expect(isRewardAvailableToEarn(reward)).toBe(true);
    // Done watching but not released by Twitch: only Twitch can move it on.
    expect(isRewardAvailableToEarn({ ...reward, watchedMinutes: 60 })).toBe(false);
  });

  it("ignores a mark once the platform releases or confirms the reward", () => {
    for (const status of ["claimable", "claimed"] as const) {
      const [reward] = applySubscriptionMarks(twitchCampaign([subscriptionReward({ status })]), [mark("sub")]).rewards;
      expect(reward.subscriptionMarked).toBeUndefined();
    }
  });

  it("restores the platform's view when the mark is removed", () => {
    const source = twitchCampaign([subscriptionReward(), gatedWatchReward()]);
    const marked = applySubscriptionMarks(source, [mark("sub")]);

    expect(applySubscriptionMarks(marked, [])).toEqual(source);
  });

  it("leaves a campaign with no marks of its own untouched", () => {
    const source = twitchCampaign([subscriptionReward(), gatedWatchReward()]);

    expect(applySubscriptionMarks(source, [])).toBe(source);
    expect(applySubscriptionMarks(source, ["another-campaign:sub", "campaign-typo"])).toBe(source);
    expect(applySubscriptionMarks(source, ["campaign:no-such-reward"])).toEqual(source);
  });

  it("lets claim reconciliation honour a mark for prerequisites but not for completion", () => {
    const campaign = applySubscriptionMarks(twitchCampaign([subscriptionReward(), gatedWatchReward()]), [mark("sub")]);
    const reconciled = reconcileCampaignAfterClaims(campaign, campaign.rewards);

    expect(reconciled.rewards[1].preconditionsMet).toBe(true);
    expect(reconciled.status).toBe("active");
    expect(reconciled.eligibility).toBe("waiting_for_subscription");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir packages/extension exec vitest run tests/subscriptionMarks.test.ts`
Expected: FAIL. `subscriptionMarkKey`, `canMarkSubscription`, `isRewardObtained` and `applySubscriptionMarks` are not exported.

- [ ] **Step 3: Add the model field**

In `packages/shared/src/models.ts`, inside `interface DropReward`, after `preconditionsMet?: boolean;`:

```ts
  // Set by applySubscriptionMarks when the user marked this subscription
  // reward as subscribed, never by a platform parser. The reward's status stays
  // the platform's report.
  subscriptionMarked?: true;
```

- [ ] **Step 4: Implement the predicates and the apply function**

In `packages/shared/src/rewards.ts`, replace the `RequirementFields` type and `rewardRequirementType` with:

```ts
type RequirementFields = Pick<DropReward, "requirement" | "requiredMinutes" | "requiredSubs" | "isWatchBased" | "subscriptionMarked">;

export function rewardRequirementType(reward: RequirementFields): RewardRequirementType {
  // A subscription the user marked as made leaves only the watch time to earn.
  if (reward.subscriptionMarked && reward.requiredMinutes > 0) return "watch";
  if (reward.requirement) return reward.requirement;
  if ((reward.requiredSubs ?? 0) > 0) return "subscription";
  if (reward.requiredMinutes > 0 && reward.isWatchBased !== false) return "watch";
  return "action";
}
```

In `isRewardAvailableToEarn`, replace its last line (`return reward.status !== "claimed" && reward.status !== "claimable";`) with:

```ts
  // A marked reward whose watch time is done but which the platform has not
  // released can only be moved on by the platform, not by more watching.
  if (reward.subscriptionMarked && reward.watchedMinutes >= reward.requiredMinutes) return false;
  return reward.status !== "claimed" && reward.status !== "claimable";
```

In `isWaitingSubscriptionReward`, add as its first line:

```ts
  if (reward.subscriptionMarked) return false;
```

Replace `reconcileCampaignAfterClaims` with the following, which adds the new exports above it:

```ts
// Subscription marks (docs/superpowers/specs/2026-10-03-subscription-marks-design.md).
// A mark is the user's word that a subscription reward's subscription was made.
// It lives on rewards only and never changes a reward's or campaign's status,
// so removing it restores the platform's view exactly.
export function subscriptionMarkKey(campaignId: string, rewardId: string): string {
  return `${campaignId}:${rewardId}`;
}

// Only a subscription reward the platform has not released or confirmed: once
// it is claimable it is claimed for real, and a mark would only hide that.
export function canMarkSubscription(reward: Pick<DropReward, "requiredSubs" | "status">): boolean {
  return (reward.requiredSubs ?? 0) > 0 && (reward.status === "locked" || reward.status === "in_progress");
}

// Done, as far as Lurkloot's decisions go: claimed on the platform, or a pure
// subscription reward the user marked. A marked reward that also needs watch
// time is a watch reward instead (rewardRequirementType).
export function isRewardObtained(reward: Pick<DropReward, "status" | "subscriptionMarked" | "requiredMinutes">): boolean {
  return reward.status === "claimed" || (reward.subscriptionMarked === true && reward.requiredMinutes === 0);
}

function reconcilePreconditions(rewards: DropReward[]): DropReward[] {
  const obtainedIds = new Set(rewards.filter(isRewardObtained).map((reward) => reward.id));
  return rewards.map((reward) => ({
    ...reward,
    preconditionsMet: (reward.preconditionRewardIds ?? []).every((id) => obtainedIds.has(id)),
  }));
}

export function applySubscriptionMarks(campaign: DropCampaign, marks: readonly string[]): DropCampaign {
  const prefix = subscriptionMarkKey(campaign.id, "");
  // No mark names this campaign and none is left to clear: the platform's view,
  // as the same object, so stored state does not change.
  if (!marks.some((mark) => mark.startsWith(prefix)) && !campaign.rewards.some((reward) => reward.subscriptionMarked)) {
    return campaign;
  }
  const marked = new Set(marks);
  const rewards = campaign.rewards.map(({ subscriptionMarked: _previous, ...reward }): DropReward =>
    canMarkSubscription(reward) && marked.has(subscriptionMarkKey(campaign.id, reward.id))
      ? { ...reward, subscriptionMarked: true }
      : reward);
  return { ...campaign, rewards: reconcilePreconditions(rewards) };
}

export function reconcileCampaignAfterClaims(campaign: DropCampaign, rewards: DropReward[]): DropCampaign {
  const reconciledRewards = reconcilePreconditions(rewards);
  // Completion stays on the platform's claims: it writes the campaign's status
  // one way, which a mark must never do.
  const completed = reconciledRewards.length > 0
    && reconciledRewards.every((reward) => reward.status === "claimed");

  return {
    ...campaign,
    rewards: reconciledRewards,
    status: completed ? "completed" : campaign.status,
    eligibility: completed ? "completed" : campaign.eligibility,
    eligibilityReason: completed ? "All rewards are claimed" : campaign.eligibilityReason,
  };
}
```

The destructured `_previous` is what removes a stale flag. TypeScript does not report a property destructured beside a rest element as unused, so it typechecks as is.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir packages/extension exec vitest run tests/subscriptionMarks.test.ts tests/rewards.test.ts tests/parsers.test.ts tests/campaignFarming.test.ts`
Expected: PASS. The last three confirm the predicate changes are a no-op for unmarked rewards.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/rewards.ts packages/extension/tests/subscriptionMarks.test.ts
git commit -m "feat(rewards): apply subscription marks as a reward-level layer"
```

---

### Task 3: "Is this reward done?" checks use `isRewardObtained`

**Files:**
- Modify: `packages/shared/src/campaignFarming.ts:98`
- Modify: `packages/shared/src/campaignFilters.ts:30`
- Test: `packages/extension/tests/subscriptionMarks.test.ts`

**Interfaces:**
- Consumes: `applySubscriptionMarks`, `isRewardObtained`, `subscriptionMarkKey` (Task 2).
- Produces: `evaluateCampaignFarming` returns `no_unclaimed_rewards` for a campaign whose rewards are all claimed or marked; `isCampaignFinished` and `campaignSection` call it finished/`"completed"`.

`isRewardFarmableNow` and `campaignEligibleClass` in `campaignFilters.ts` need no change. The first already rejects a pure subscription reward as not relevant to earn. The second has no callers outside its own file.

- [ ] **Step 1: Write the failing tests**

Append to `packages/extension/tests/subscriptionMarks.test.ts`. Add these imports at the top:

```ts
import { evaluateCampaignFarming } from "@lurkloot/shared/campaignFarming";
import { campaignSection, isCampaignFinished } from "@lurkloot/shared/campaignFilters";
import { mergeEngineSettings } from "@lurkloot/shared/settings";
```

and append:

```ts
describe("subscription marks in farmability", () => {
  const settings = mergeEngineSettings(undefined);

  it("farms a watch reward whose subscription prerequisite is marked", () => {
    const source = twitchCampaign([subscriptionReward(), gatedWatchReward()]);

    expect(evaluateCampaignFarming(source, settings).farmable).toBe(false);
    expect(evaluateCampaignFarming(applySubscriptionMarks(source, [mark("sub")]), settings)).toMatchObject({ farmable: true });
  });

  it("farms a marked subscription plus watch reward", () => {
    const source = twitchCampaign([subscriptionPlusWatchReward()]);

    expect(evaluateCampaignFarming(source, settings).farmable).toBe(false);
    expect(evaluateCampaignFarming(applySubscriptionMarks(source, [mark("combined")]), settings)).toMatchObject({ farmable: true });
  });

  it("finishes a fully marked subscription-only campaign without changing its status", () => {
    const campaign = applySubscriptionMarks(twitchCampaign([subscriptionReward()]), [mark("sub")]);

    expect(evaluateCampaignFarming(campaign, settings)).toMatchObject({ farmable: false, code: "no_unclaimed_rewards" });
    expect(isCampaignFinished(campaign)).toBe(true);
    expect(campaignSection(campaign, settings)).toBe("completed");
    expect(campaign.status).toBe("active");
    expect(campaign.eligibility).toBe("waiting_for_subscription");
  });

  it("keeps a campaign open while one of its subscription tiers is unmarked", () => {
    const campaign = applySubscriptionMarks(
      twitchCampaign([subscriptionReward(), subscriptionReward({ id: "five-gifts", requiredSubs: 5 })]),
      [mark("sub")],
    );

    expect(isCampaignFinished(campaign)).toBe(false);
    expect(campaignSection(campaign, settings)).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run the tests to verify which fail**

Run: `pnpm --dir packages/extension exec vitest run tests/subscriptionMarks.test.ts -t "farmability"`
Expected: "finishes a fully marked subscription-only campaign" FAILS. The code is still `subscription_required` and `isCampaignFinished` is still `false`. The two "farms" tests already PASS, because Task 2 recomputes prerequisites and requirement types. They stay as guards.

- [ ] **Step 3: Implement**

In `packages/shared/src/campaignFarming.ts`, change line 98 to:

```ts
  const unclaimed = campaign.rewards.filter((reward) => !isRewardObtained(reward));
```

and add `isRewardObtained` to its existing `./rewards` import.

In `packages/shared/src/campaignFilters.ts`, change the last line of `isCampaignFinished` to:

```ts
  return campaign.rewards.length > 0 && campaign.rewards.every(isRewardObtained);
```

and add `isRewardObtained` to its `./rewards` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir packages/extension exec vitest run tests/subscriptionMarks.test.ts tests/campaignFarming.test.ts tests/campaignFilters.test.ts tests/queueView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/campaignFarming.ts packages/shared/src/campaignFilters.ts packages/extension/tests/subscriptionMarks.test.ts
git commit -m "feat(farming): count marked subscription rewards as done"
```

---

### Task 4: Engine intake, accrual and waiting status

**Files:**
- Modify: `packages/core/src/core/scheduler.ts` (new `reconcileRefreshedCampaigns` next to `preserveClaimedRewards` around line 1760; the tick commit around line 1347; `onlyWaitingSubscriptionCampaigns` around line 410; `watchProgress` around line 1977; the `@lurkloot/shared/rewards` import at lines 24-31)
- Modify: `packages/core/src/background/discovery.ts:142`
- Modify: `packages/core/src/background/claimService.ts:566`
- Create: `packages/extension/tests/backgroundController/subscriptionMarks.test.ts`
- Test: `packages/extension/tests/scheduler.test.ts` (the "stalled progress rotation" describe, around line 2795)

**Interfaces:**
- Consumes: `applySubscriptionMarks`, `isRewardObtained`, `isWatchReward`, `subscriptionMarkKey` (Task 2); `settings.platform[platform].subscribedRewardMarks` (Task 1).
- Produces: `reconcileRefreshedCampaigns(campaigns: DropCampaign[], previousCampaigns: readonly DropCampaign[], marks: readonly string[]): DropCampaign[]` exported from `@lurkloot/core/scheduler`.

- [ ] **Step 1: Write the failing controller tests**

Create `packages/extension/tests/backgroundController/subscriptionMarks.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { DropCampaign, DropReward, ExtensionSettings } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { subscriptionMarkKey } from "@lurkloot/shared/rewards";
import { farming, harness } from "../helpers/backgroundController";

// Subscription marks enter the engine wherever adapter output does: the
// discovery snapshot, the tick commit and the claim service's refresh
// (docs/superpowers/specs/2026-10-03-subscription-marks-design.md).

const CAMPAIGN = "twitch-campaign";

function subscriptionReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "sub", name: "Sub reward", requiredMinutes: 0, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function gatedWatchReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "watch", name: "Watch reward", requiredMinutes: 60, requirement: "watch", isWatchBased: true, watchedMinutes: 0, status: "locked", preconditionRewardIds: ["sub"], preconditionsMet: false, ...overrides };
}

function twitchCampaign(rewards: DropReward[]): DropCampaign {
  return { id: CAMPAIGN, platform: "twitch", name: "Twitch campaign", status: "active", eligibility: "waiting_for_subscription", endsAt: "2999-01-01T00:00:00.000Z", rewards };
}

function withMarks(settings: ExtensionSettings, ...rewardIds: string[]): ExtensionSettings {
  return {
    ...settings,
    platform: {
      ...settings.platform,
      twitch: { ...settings.platform.twitch, subscribedRewardMarks: rewardIds.map((id) => subscriptionMarkKey(CAMPAIGN, id)) },
    },
  };
}

describe("subscription marks in the engine", () => {
  it("farms a watch reward once its subscription prerequisite is marked", async () => {
    const unmarked = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(unmarked.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward(), gatedWatchReward()])]);
    await unmarked.controller.tick();
    expect(unmarked.state.sessions.twitch.rewardId).not.toBe("watch");

    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward(), gatedWatchReward()])]);
    await env.controller.tick();

    expect(env.state.sessions.twitch).toMatchObject({ campaignId: CAMPAIGN, rewardId: "watch" });
    expect(env.state.campaigns.twitch[0].rewards[0]).toMatchObject({ status: "locked", subscriptionMarked: true });
  });

  it("never notifies, and undo restores the platform's view", async () => {
    const env = harness(withMarks(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: true }), "sub"));
    const source = () => [twitchCampaign([subscriptionReward(), gatedWatchReward()])];
    env.state.campaigns.twitch = source();
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => source());

    await env.controller.tick();
    expect(env.state.sessions.twitch.rewardId).toBe("watch");

    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { subscribedRewardMarks: [] } } } });
    await env.controller.tick();

    const [sub, watch] = env.state.campaigns.twitch[0].rewards;
    expect(sub.subscriptionMarked).toBeUndefined();
    expect(sub.status).toBe("locked");
    expect(watch.preconditionsMet).toBe(false);
    expect(env.state.sessions.twitch.rewardId).not.toBe("watch");
    expect(env.deps.createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Reward earned" }));
  });

  it("claims a marked reward once Twitch releases it", async () => {
    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([
      twitchCampaign([subscriptionReward({ status: "claimable", claimId: "viewer#twitch-campaign#sub" })]),
    ]);

    await env.controller.tick();

    expect(env.twitch.claimReward).toHaveBeenCalledWith(
      expect.objectContaining({ id: CAMPAIGN }),
      expect.objectContaining({ id: "sub", status: "claimable" }),
      expect.anything(),
    );
  });

  it("does not report a fully marked campaign as waiting for a subscription", async () => {
    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward()])]);

    await env.controller.tick();

    expect(env.state.sessions.twitch.reason ?? "").not.toContain("Waiting for a qualifying subscription");
  });

  it("keeps marks through the claim service's refresh", async () => {
    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    env.state.authHealth = { ...env.state.authHealth, twitch: { status: "healthy", checkedAt: new Date().toISOString() } };
    env.state.sessions.twitch = { platform: "twitch", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
    env.state.manualWatch = { twitch: { platform: "twitch", tabId: 91, checkedAt: new Date().toISOString(), active: true } };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward(), gatedWatchReward()])]);

    await env.controller.runDropClaims("twitch");

    const [sub, watch] = env.state.campaigns.twitch[0].rewards;
    expect(sub.subscriptionMarked).toBe(true);
    expect(watch.preconditionsMet).toBe(true);
  });
});
```

The automatic claim passes `{ signal }` as the third argument (`packages/core/src/core/rewardClaims.ts:93`), hence `expect.anything()`. Manual claims use the two-argument form (`claims.test.ts:398`).

- [ ] **Step 2: Write the failing accrual test**

In `packages/extension/tests/scheduler.test.ts`, inside `describe("stalled progress rotation", ...)` (around line 2795), after the `it("rotates away once a healthy channel stalls for the retry limit", ...)` test, add:

```ts
    it("rotates away from a marked subscription plus watch reward that stops accruing", async () => {
      const combined: DropReward = {
        id: "combined",
        name: "Watch and Subscribe",
        requiredMinutes: 60,
        requiredSubs: 1,
        requirement: "subscription",
        isWatchBased: false,
        watchedMinutes: 20,
        status: "in_progress",
      };
      const twitch = adapter("twitch", [campaign("drops", { rewards: [combined] })], [channel("old"), channel("fresh")]);

      const result = await runSchedulerTick(
        {
          authHealth: HEALTHY_AUTH,
          sessions: {
            twitch: watching({ rewardId: "combined", noProgressChecks: 2, lastWatchedMinutes: 20 }),
            kick: { platform: "kick", status: "idle", offlineChecks: 0 },
          },
          campaigns: { twitch: [], kick: [] },
        },
        settings({
          offlineRetryLimit: 3,
          platform: {
            twitch: { enabled: true, idleWatchlistChannels: [], subscribedRewardMarks: ["drops:combined"] },
            kick: { enabled: false, idleWatchlistChannels: [] },
          },
        }),
        { twitch, kick: adapter("kick", [], []) },
      );

      expect(result.state.campaigns.twitch[0].rewards[0].subscriptionMarked).toBe(true);
      expect(result.state.sessions.twitch.reasonCode).toBe("no_progress");
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --dir packages/extension exec vitest run tests/backgroundController/subscriptionMarks.test.ts tests/scheduler.test.ts -t "subscription"`
Expected: FAIL. No mark reaches the engine, so the watch reward is not farmed, flags are missing, and the stalled marked reward is kept.

- [ ] **Step 4: Add the intake helper and use it at the tick commit**

In `packages/core/src/core/scheduler.ts`, add `applySubscriptionMarks`, `isRewardObtained` and `isWatchReward` to the `@lurkloot/shared/rewards` import (lines 24-31). Directly after `preserveClaimedRewards`, add:

```ts
// Where refreshed campaigns enter the engine: the claims an earlier check
// recorded are kept, then the user's subscription marks are applied, so every
// reader of the stored campaigns agrees on them
// (docs/superpowers/specs/2026-10-03-subscription-marks-design.md).
export function reconcileRefreshedCampaigns(
  campaigns: DropCampaign[],
  previousCampaigns: readonly DropCampaign[],
  marks: readonly string[],
): DropCampaign[] {
  return preserveClaimedRewards(campaigns, previousCampaigns)
    .map((campaign) => applySubscriptionMarks(campaign, marks));
}
```

At the tick commit (around line 1347), replace

```ts
    let campaigns = preserveClaimedRewards(committedDiscovery.campaigns, state.campaigns[platform]);
```

with

```ts
    let campaigns = reconcileRefreshedCampaigns(
      committedDiscovery.campaigns,
      state.campaigns[platform],
      settings.platform[platform].subscribedRewardMarks ?? [],
    );
```

- [ ] **Step 5: Track accrual through the shared predicate**

In `watchProgress` (around line 1977), replace

```ts
  const watchedMinutes = reward?.isWatchBased === false ? undefined : reward?.watchedMinutes;
```

with

```ts
  // Through isWatchReward, so a marked subscription plus watch reward is
  // tracked like any watch reward and a stall still rotates it away.
  const watchedMinutes = reward && isWatchReward(reward) ? reward.watchedMinutes : undefined;
```

- [ ] **Step 6: Stop calling a marked campaign "waiting"**

In `onlyWaitingSubscriptionCampaigns` (around line 410), change the `every` callback so that it reads:

```ts
  return notExcluded.length > 0 && notExcluded.every((campaign) =>
    campaign.eligibility === "waiting_for_subscription"
    && campaign.rewards.length > 0
    && campaign.rewards.every(isSubscriptionReward)
    // A subscription the user marked is not waited for.
    && campaign.rewards.some((reward) => !isRewardObtained(reward) && !reward.subscriptionMarked));
```

Keep every existing line of that function, adding only the final condition.

- [ ] **Step 7: Apply the marks in discovery and the claim service**

In `packages/core/src/background/discovery.ts`, add `reconcileRefreshedCampaigns` to the existing import from `../core/scheduler` (it already imports `preserveClaimedRewards` from there; replace that import if it becomes unused). Then change the last argument of `collectDiscoverySnapshot` (line 142) to:

```ts
              (campaigns) => reconcileRefreshedCampaigns(
                campaigns,
                state.campaigns[platform],
                settings.platform[platform].subscribedRewardMarks ?? [],
              ),
```

In `packages/core/src/background/claimService.ts`, add `reconcileRefreshedCampaigns` to the `../core/scheduler` import on line 5, and change line 566 to:

```ts
          const campaigns = claimCampaigns = reconcileRefreshedCampaigns(
            refreshed,
            state.campaigns[platform],
            settings.platform[platform].subscribedRewardMarks ?? [],
          );
```

Leave the commit's `preserveClaimedRewards(claimResult.campaigns, latest.campaigns[platform])` (around line 605) as it is. `claimResult.campaigns` already carries the flags, and that call spreads them along.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --dir packages/extension exec vitest run tests/backgroundController/subscriptionMarks.test.ts tests/scheduler.test.ts tests/backgroundController tests/discoverySnapshot.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/core/scheduler.ts packages/core/src/background/discovery.ts packages/core/src/background/claimService.ts packages/extension/tests/backgroundController/subscriptionMarks.test.ts packages/extension/tests/scheduler.test.ts
git commit -m "feat(core): apply subscription marks where campaigns enter the engine"
```

---

### Task 5: CLI settings and status

**Files:**
- Modify: `packages/cli/src/settings.ts` (`CLI_PLATFORM_KEYS` line 137-138; `common()` base around line 413; the `@lurkloot/shared/settings` import)
- Modify: `packages/cli/src/config.ts` (template, after each platform's `blockedCategories` line, around lines 132 and 157)
- Modify: `packages/cli/src/runtime/status.ts`
- Test: `packages/cli/tests/settings.test.ts`, `packages/cli/tests/runtime.test.ts`

**Interfaces:**
- Consumes: `normalizeSubscriptionMarks` (Task 1); `isRewardObtained` and `isWaitingSubscriptionReward` (Task 2).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/tests/settings.test.ts`. It already imports `parseCliSettings`; add `defaultConfigJsonc` from `../src/config` and `parse as parseJsonc` from `jsonc-parser` if they are not imported yet.

```ts
describe("subscription marks in the CLI config", () => {
  it("accepts and normalizes subscribedRewardMarks on both platforms", () => {
    const settings = parseCliSettings({
      platform: {
        twitch: { subscribedRewardMarks: ["campaign:sub", "campaign:sub", "broken"] },
        kick: { subscribedRewardMarks: [] },
      },
    });

    expect(settings.platform.twitch.subscribedRewardMarks).toEqual(["campaign:sub"]);
    expect(settings.platform.kick.subscribedRewardMarks).toEqual([]);
  });

  it("lists subscribedRewardMarks in the generated config", () => {
    const config = parseJsonc(defaultConfigJsonc());

    expect(config.settings.platform.twitch.subscribedRewardMarks).toEqual([]);
    expect(config.settings.platform.kick.subscribedRewardMarks).toEqual([]);
  });
});
```

In `packages/cli/tests/runtime.test.ts`, inside `describe("CLI campaign status reporting", ...)`, add:

```ts
  it("shows a marked subscription reward and stops calling its campaign waiting", () => {
    const campaign = dropCampaign({
      eligibility: "waiting_for_subscription",
      rewards: [
        dropReward({ id: "duffel", name: "Purple Duffel Bag", requirement: "subscription", requiredSubs: 1, subscriptionMarked: true }),
        dropReward({ id: "combo", name: "Combo Crate", requirement: "subscription", requiredSubs: 1, requiredMinutes: 60, watchedMinutes: 15, status: "in_progress", subscriptionMarked: true }),
      ],
    });

    expect(formatDiscoveredCampaign(campaign)).toEqual([
      "• ARC Raiders Summer Drops",
      "  ◦ Purple Duffel Bag — subscription marked",
      "  ◦ Combo Crate — requires 60 minutes watched (subscription marked); progress 15/60 minutes",
    ]);
    expect([...subscriptionWaitKeys([campaign])]).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir packages/cli exec vitest run tests/settings.test.ts tests/runtime.test.ts -t "subscription"`
Expected: FAIL. `unknown setting "subscribedRewardMarks" under platform.twitch`, and the status lines still say "progress unavailable" and "waiting for subscription".

- [ ] **Step 3: Implement the settings**

In `packages/cli/src/settings.ts`, add `"subscribedRewardMarks"` to both sets in `CLI_PLATFORM_KEYS`. In `common()`'s `base`, after `blockedCategories`:

```ts
        subscribedRewardMarks: normalizeSubscriptionMarks(ps.subscribedRewardMarks),
```

and add `normalizeSubscriptionMarks` to the file's `@lurkloot/shared/settings` import.

In `packages/cli/src/config.ts`, after each platform's `"blockedCategories"` line (twitch around line 132, kick around line 157), add:

```
        // Subscription rewards you have subscribed for, as "<campaignId>:<rewardId>".
        // Lurkloot treats their subscription as made, like the popup's
        // "Mark as subscribed".
        "subscribedRewardMarks": ${json(twitch.subscribedRewardMarks ?? [])},
```

Use `kick.subscribedRewardMarks ?? []` in the kick block.

- [ ] **Step 4: Implement the status output**

In `packages/cli/src/runtime/status.ts`, change the import to:

```ts
import { campaignHasWatchRewards, isRewardObtained, isWaitingSubscriptionReward, rewardRequirementType } from "@lurkloot/shared/rewards";
```

Replace `formatReward` with:

```ts
function formatReward(reward: DropReward): string {
  if (reward.status === "claimed") return `  ◦ ${reward.name} — earned`;
  if (isRewardObtained(reward)) return `  ◦ ${reward.name} — subscription marked`;

  switch (rewardRequirementType(reward)) {
    case "subscription": {
      const required = reward.requiredSubs ?? 1;
      return `  ◦ ${reward.name} — requires ${subscriptionRequirement(required)}; progress unavailable`;
    }
    case "watch": {
      const marked = reward.subscriptionMarked ? " (subscription marked)" : "";
      return `  ◦ ${reward.name} — requires ${reward.requiredMinutes} minutes watched${marked}; progress ${reward.watchedMinutes}/${reward.requiredMinutes} minutes`;
    }
    case "action":
      return `  ◦ ${reward.name} — action required; progress unavailable`;
  }
}
```

and in `formatDiscoveredCampaign`, replace the `waiting` line with:

```ts
  // From the rewards, not eligibility alone: a campaign whose subscriptions the
  // user marked is no longer waiting.
  const waiting = campaign.eligibility === "waiting_for_subscription"
    && campaign.rewards.some((reward) => isWaitingSubscriptionReward(reward))
    ? " — waiting for subscription"
    : "";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir packages/cli exec vitest run`
Expected: PASS (whole CLI suite: config template, settings and runtime).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/settings.ts packages/cli/src/config.ts packages/cli/src/runtime/status.ts packages/cli/tests/settings.test.ts packages/cli/tests/runtime.test.ts
git commit -m "feat(cli): accept subscription marks and report them in status"
```

---

### Task 6: Popup control, view model and locales

**Files:**
- Modify: `packages/popup-ui/src/context.tsx`
- Modify: `packages/popup-ui/src/types.ts` (`RewardView`, line 50)
- Modify: `packages/popup-ui/src/viewModels.ts` (`campaignViewFromCampaign`, line 161; reward mapping around lines 196-225)
- Modify: `packages/popup-ui/src/drops.tsx` (`CampaignCard` line 96 and its `RewardCarousel` call around line 384; `RewardCarousel` line 781; `RewardTile` line 882)
- Modify: `packages/popup-ui/src/Popup.tsx` (refs before `if (!snapshot)` at line 688; handler after `const settings = mergeSettings(snapshot.settings)`; provider in the main return around line 850)
- Modify: `packages/locales/messages/*.json` (11 catalogs)
- Create: `packages/extension/tests/subscriptionMarkView.test.tsx`

**Interfaces:**
- Consumes: `applySubscriptionMarks`, `canMarkSubscription`, `isRewardObtained`, `subscriptionMarkKey` (Task 2); `subscribedRewardMarks` (Task 1).
- Produces:
  - `SubscriptionMarkContext = React.createContext<((campaignId: string, rewardId: string) => void) | null>(null)`, exported from `context.tsx`.
  - `RewardView.subscriptionMarked?: boolean` and `RewardView.canMarkSubscription?: boolean`.
  - DOM hooks: `[data-subscription-mark]` (mark button), `[data-subscription-marked]` (marked line), `[data-subscription-mark-undo]` (undo button).

- [ ] **Step 1: Write the failing tests**

Create `packages/extension/tests/subscriptionMarkView.test.tsx`:

```tsx
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, DropReward, ExtensionSettings, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext, SubscriptionMarkContext } from "../../popup-ui/src/context";
import { QueuePanel } from "../../popup-ui/src/queue";
import { CompletedPanel } from "../../popup-ui/src/completed";
import type { CampaignView, PopupAdapter } from "../../popup-ui/src/types";
import { campaignViewFromCampaign } from "../../popup-ui/src/viewModels";

const idleSession: WatchSession = { platform: "twitch", offlineChecks: 0, status: "idle" };

function subscriptionReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "sub", name: "Sub reward", requiredMinutes: 0, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function twitchCampaign(rewards: DropReward[]): DropCampaign {
  return { id: "campaign", platform: "twitch", name: "Sub campaign", status: "active", eligibility: "waiting_for_subscription", endsAt: "2999-01-01T00:00:00.000Z", rewards };
}

function settingsWithMarks(marks: string[]): ExtensionSettings {
  const settings = mergeSettings(undefined);
  settings.platform.twitch.subscribedRewardMarks = marks;
  return settings;
}

function view(campaign: DropCampaign, marks: string[] = []): CampaignView {
  const settings = settingsWithMarks(marks);
  return campaignViewFromCampaign(campaign, 0, idleSession, false, {
    skipUnfinishableRewards: settings.skipUnfinishableRewards,
    deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
    settings,
  });
}

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function mount(element: (body: React.ReactElement) => React.ReactElement, body: React.ReactElement) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t: (key) => key, dir: "ltr", locale: "en" }}>
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          {element(body)}
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  });
  return container;
}

function queue(campaigns: CampaignView[]): React.ReactElement {
  return (
    <QueuePanel
      campaigns={campaigns}
      gameMap={{}}
      refreshing={false}
      strategy="ending_soonest"
      pinnedCount={0}
      farmPinnedOnly={false}
      onStrategyChange={() => undefined}
      onUnpinAll={() => undefined}
      onFarmPinnedOnlyChange={() => undefined}
      onRefreshCampaign={() => undefined}
      onPinChange={() => undefined}
      onToggleExclude={() => undefined}
      onOpenGames={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
}

function expandFirstCard(container: HTMLElement): void {
  act(() => container.querySelector<HTMLButtonElement>("article button[aria-expanded]")?.click());
}

describe("subscription mark view model", () => {
  it("applies the settings' marks before building the view", () => {
    const [reward] = view(twitchCampaign([subscriptionReward()]), ["campaign:sub"]).rewards;

    expect(reward).toMatchObject({ subscriptionMarked: true, canMarkSubscription: true, obtained: true, requirement: "subscription" });
  });

  it("shows a marked subscription plus watch reward as a watch reward that keeps its mark", () => {
    const [reward] = view(twitchCampaign([subscriptionReward({ id: "combined", requiredMinutes: 60, watchedMinutes: 30, status: "in_progress" })]), ["campaign:combined"]).rewards;

    expect(reward).toMatchObject({ requirement: "watch", subscriptionMarked: true, obtained: false, progress: 50 });
  });
});

describe("subscription mark control", () => {
  it("offers Mark as subscribed and reports the reward it marks", () => {
    const toggle = vi.fn();
    const container = mount(
      (body) => <SubscriptionMarkContext.Provider value={toggle}>{body}</SubscriptionMarkContext.Provider>,
      queue([view(twitchCampaign([subscriptionReward()]))]),
    );
    act(() => container.querySelector<HTMLButtonElement>('[data-queue-disclosure="action-required"]')?.click());
    expandFirstCard(container);

    act(() => container.querySelector<HTMLButtonElement>("[data-subscription-mark]")?.click());

    expect(toggle).toHaveBeenCalledWith("campaign", "sub");
  });

  it("shows no control without a mark handler", () => {
    const container = mount((body) => body, queue([view(twitchCampaign([subscriptionReward()]))]));
    act(() => container.querySelector<HTMLButtonElement>('[data-queue-disclosure="action-required"]')?.click());
    expandFirstCard(container);

    expect(container.querySelector("[data-subscription-mark]")).toBeNull();
  });

  it("keeps Undo reachable for a fully marked campaign in Completed", () => {
    const toggle = vi.fn();
    const container = mount(
      (body) => <SubscriptionMarkContext.Provider value={toggle}>{body}</SubscriptionMarkContext.Provider>,
      <CompletedPanel campaigns={[view(twitchCampaign([subscriptionReward()]), ["campaign:sub"])]} gameMap={{}} refreshing={false} onRefreshCampaign={() => undefined} />,
    );
    expandFirstCard(container);

    expect(container.querySelector("[data-subscription-marked]")?.textContent).toContain("subscriptionMarkedSubscribed");
    act(() => container.querySelector<HTMLButtonElement>("[data-subscription-mark-undo]")?.click());
    expect(toggle).toHaveBeenCalledWith("campaign", "sub");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir packages/extension exec vitest run tests/subscriptionMarkView.test.tsx`
Expected: FAIL. `SubscriptionMarkContext` is not exported, and the view has no `subscriptionMarked`.

- [ ] **Step 3: Add the context and view fields**

In `packages/popup-ui/src/context.tsx`, after `PopupRuntimeContext`:

```tsx
// Marks or unmarks a subscription reward as subscribed. Provided once by the
// popup and read by each campaign card; without it no mark control is shown.
export const SubscriptionMarkContext = React.createContext<((campaignId: string, rewardId: string) => void) | null>(null);
```

In `packages/popup-ui/src/types.ts`, inside `RewardView`, after `obtained: boolean;`:

```ts
  // The user marked this subscription reward as subscribed.
  subscriptionMarked?: boolean;
  // The reward can be marked (or unmarked): a subscription reward the platform
  // has not released.
  canMarkSubscription?: boolean;
```

- [ ] **Step 4: Apply marks in the view model**

In `packages/popup-ui/src/viewModels.ts`, add `applySubscriptionMarks`, `canMarkSubscription` and `isRewardObtained` to the `@lurkloot/shared/rewards` import. Rename the first parameter of `campaignViewFromCampaign` from `campaign` to `source`, and make the start of the body:

```ts
  const settings = feasibility?.settings;
  // The engine applies the same marks on its next check; applying them here too
  // shows a toggle at once.
  const campaign = settings
    ? applySubscriptionMarks(source, settings.platform[source.platform].subscribedRewardMarks ?? [])
    : source;
  const farmingBlockers = feasibility?.settings
    ? campaignFarmingBlockers(campaign, feasibility.settings, { includePinnedOnly: true, now: feasibility.now })
    : [];
```

Delete the later `const settings = feasibility?.settings;` line, which is now declared at the top. In the reward mapping, change the progress fallback `: reward.status === "claimed" ? 100 : undefined;` to `: isRewardObtained(reward) ? 100 : undefined;`, and replace `obtained: reward.status === "claimed",` with:

```ts
        obtained: isRewardObtained(reward),
        subscriptionMarked: reward.subscriptionMarked === true,
        canMarkSubscription: canMarkSubscription(reward),
```

- [ ] **Step 5: Render the control**

In `packages/popup-ui/src/drops.tsx`, add `SubscriptionMarkContext` to the `./context` import.

In `CampaignCard`, after `const runtime = React.useContext(PopupRuntimeContext);`:

```tsx
  const toggleSubscriptionMark = React.useContext(SubscriptionMarkContext);
```

and change the carousel call (around line 384) to:

```tsx
                <RewardCarousel
                  rewards={campaign.rewards}
                  missed={expired}
                  onToggleSubscriptionMark={toggleSubscriptionMark ? (rewardId) => toggleSubscriptionMark(campaign.id, rewardId) : undefined}
                />
```

Change `RewardCarousel` to accept and pass the callback:

```tsx
function RewardCarousel({ rewards, missed = false, onToggleSubscriptionMark }: { rewards: RewardView[]; missed?: boolean; onToggleSubscriptionMark?: (rewardId: string) => void }) {
```

```tsx
        {rewards.map((reward) => <RewardTile key={reward.id} reward={reward} missed={missed} onToggleSubscriptionMark={onToggleSubscriptionMark} />)}
```

Before `RewardTile`, add:

```tsx
function SubscriptionMarkControl({ marked, onToggle }: { marked: boolean; onToggle(): void }) {
  const t = useT();
  return marked ? (
    <div data-subscription-marked className="flex items-center justify-between gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
      <span>{t("subscriptionMarkedSubscribed")}</span>
      <button type="button" data-subscription-mark-undo onClick={onToggle} className="shrink-0 font-semibold text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:decoration-current dark:text-zinc-300 dark:decoration-zinc-600">
        {t("subscriptionMarkUndo")}
      </button>
    </div>
  ) : (
    <button type="button" data-subscription-mark onClick={onToggle} className="w-full rounded-md border border-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
      {t("subscriptionMarkSubscribed")}
    </button>
  );
}
```

Change `RewardTile`'s signature and add the control:

```tsx
function RewardTile({ reward, missed = false, onToggleSubscriptionMark }: { reward: RewardView; missed?: boolean; onToggleSubscriptionMark?: (rewardId: string) => void }) {
  const t = useT();
  const done = reward.obtained || (reward.progress ?? 0) >= 100;
  // An expired campaign's unearned rewards are gone, not pending.
  const lost = missed && !reward.obtained;
  // Never on an expired campaign: marking cannot bring a reward back.
  const markControl = onToggleSubscriptionMark && reward.canMarkSubscription && !missed
    ? <SubscriptionMarkControl marked={reward.subscriptionMarked === true} onToggle={() => onToggleSubscriptionMark(reward.id)} />
    : null;
```

In the watch branch, after the `lost ? ... : reward.ineligibilityReason === ... : null}` expression and before the fragment closes, add:

```tsx
          {reward.subscriptionMarked ? markControl : null}
```

Replace the subscription branch with:

```tsx
      ) : reward.requirement === "subscription" ? (
        <div className="space-y-1 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
          <div className="font-semibold text-zinc-700 dark:text-zinc-200">{t("subscriptionRequired")}</div>
          <div>{t("qualifyingSubscriptionsRequired", String(reward.requiredSubs ?? 1))}</div>
          {reward.subscriptionMarked ? null : (
            <div className={cn("font-medium", reward.obtained && "text-emerald-600 dark:text-emerald-400")}>{reward.obtained ? t("earned") : t("subscriptionProgressUnknown")}</div>
          )}
          {markControl}
        </div>
```

- [ ] **Step 6: Provide the toggle from the popup**

In `packages/popup-ui/src/Popup.tsx`, add `SubscriptionMarkContext` to the `./context` import, and `subscriptionMarkKey` from `@lurkloot/shared/rewards` (add the import line).

Directly before `if (!snapshot) {` (line 688), after the `derived` ref:

```tsx
  // The mark toggle every campaign card reads from context. Its identity never
  // changes, so marking one reward does not re-render every memoised card; it
  // calls the latest render's handler through the ref.
  const subscriptionMarkHandler = useRef<(campaignId: string, rewardId: string) => void>(() => undefined);
  const toggleSubscriptionMark = useMemo(
    () => (campaignId: string, rewardId: string) => subscriptionMarkHandler.current(campaignId, rewardId),
    [],
  );
```

After `const settings = mergeSettings(snapshot.settings);`:

```tsx
  subscriptionMarkHandler.current = (campaignId, rewardId) => {
    const key = subscriptionMarkKey(campaignId, rewardId);
    const next = new Set(settings.platform[platform].subscribedRewardMarks ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    void updateSettings(
      { platform: { [platform]: { subscribedRewardMarks: [...next] } } },
      { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
    );
  };
```

In the main `return` (the one after the `!snapshot` early return, around line 850), wrap the `<main ...>...</main>` element in the provider, inside `<I18nContext.Provider value={i18nValue}>`:

```tsx
      <SubscriptionMarkContext.Provider value={toggleSubscriptionMark}>
    <main
      ...
    </main>
      </SubscriptionMarkContext.Provider>
```

Close the provider immediately before the existing `</I18nContext.Provider>` that ends that return.

- [ ] **Step 7: Add the locale keys**

Run this from the worktree root. It inserts the three keys after `subscribedRefresh` in every catalog:

```bash
python3 - <<'EOF'
import json
from pathlib import Path

copy = {
    "en": ("Mark as subscribed", "Marked as subscribed", "Undo"),
    "es": ("Marcar como suscrito", "Marcado como suscrito", "Deshacer"),
    "de": ("Als abonniert markieren", "Als abonniert markiert", "Rückgängig"),
    "fr": ("Marquer comme abonné", "Marqué comme abonné", "Annuler"),
    "it": ("Segna come abbonato", "Segnato come abbonato", "Annulla"),
    "pt_BR": ("Marcar como assinado", "Marcado como assinado", "Desfazer"),
    "ru": ("Отметить подписку", "Подписка отмечена", "Отменить"),
    "tr": ("Abone oldum olarak işaretle", "Abone olarak işaretlendi", "Geri al"),
    "zh_CN": ("标记为已订阅", "已标记为已订阅", "撤销"),
    "ar": ("تحديد كمشترك", "تم التحديد كمشترك", "تراجع"),
    "hi": ("सदस्यता ली गई के रूप में चिह्नित करें", "सदस्यता ली गई के रूप में चिह्नित", "पूर्ववत करें"),
}
keys = ("subscriptionMarkSubscribed", "subscriptionMarkedSubscribed", "subscriptionMarkUndo")
for locale, messages in copy.items():
    path = Path(f"packages/locales/messages/{locale}.json")
    catalog = json.loads(path.read_text(encoding="utf-8"))
    updated = {}
    for key, value in catalog.items():
        updated[key] = value
        if key == "subscribedRefresh":
            for new_key, message in zip(keys, messages):
                updated[new_key] = {"message": message}
    assert all(key in updated for key in keys), locale
    path.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
EOF
git diff --stat packages/locales/messages
pnpm locales:check
```

Expected: each catalog shows `3 insertions`, and only those. If a file shows more changes, the catalog's formatting differs from `json.dumps(indent=2)`. Revert that file and insert the three entries by hand after `subscribedRefresh`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --dir packages/extension exec vitest run tests/subscriptionMarkView.test.tsx tests/dropsView.test.tsx tests/subscriptionDropsView.test.ts tests/queueView.test.tsx tests/i18n.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/popup-ui/src packages/locales/messages packages/extension/tests/subscriptionMarkView.test.tsx
git commit -m "feat(popup): mark a subscription reward as subscribed"
```

---

### Task 7: Changelog, full verification and screenshot

**Files:**
- Modify: `packages/site/src/changelog.json` (1.15.0 `changes`, after the first `"new"` entry)

- [ ] **Step 1: Add the changelog entry**

Insert as the second item of the 1.15.0 `changes` array:

```json
      {
        "kind": "new",
        "text": "Each Twitch reward that needs a subscription now has Mark as subscribed. If you subscribed or gifted a sub and Lurkloot did not notice, mark it and Lurkloot treats the subscription as made: the reward counts as earned, drops that need it first are farmed, and a reward that needs a subscription plus watch time is farmed for its watch time. Lurkloot still only claims what Twitch releases, and Undo removes the mark."
      },
```

Run: `python3 -c "import json;json.load(open('packages/site/src/changelog.json'))"`
Expected: no output.

- [ ] **Step 2: Run the full check**

Run: `pnpm check`
Expected: exit 0. Script tests, typechecks, extension and CLI suites, and the site build all pass. Report any failure by name.

- [ ] **Step 3: Capture a screenshot for the PR**

Temporarily give a Twitch demo campaign a subscription reward in `packages/popup-ui/src/demo.ts`. For example, add `{ id: "tw-starfall-sub", name: "Subscriber Banner", requiredMinutes: 0, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked" }` to `tw-starfall`'s rewards. Run the site dev server (`pnpm --dir packages/site exec astro dev`), expand the card, and screenshot the tile both unmarked and marked into `.playwright-mcp/subscription-mark.png` in the main checkout. Then revert `demo.ts` with `git checkout -- packages/popup-ui/src/demo.ts` and confirm `git status` shows it clean.

- [ ] **Step 4: Commit**

```bash
git add packages/site/src/changelog.json
git commit -m "docs(changelog): mention subscription marks"
```
