# Rewards to farm: one menu, one setting per platform

Replaces the Queue's "Rewards to farm" tabs from #839, which has not been released yet, and the cross-platform "Farm campaigns that require a subscription" toggle. Refs #731.

Mockup: [2026-10-17-rewards-to-farm-menu-mockup.html](2026-10-17-rewards-to-farm-menu-mockup.html). The maintainer approved it as the target look.

## Problem

Today five controls in three places decide what gets farmed, on two levels:

| Where | Control | Applies to | Level |
|---|---|---|---|
| Queue toolbar | Rewards to farm tabs: All / No subscription / Requires subscription / Badges | One platform | Each reward |
| Queue toolbar | Farm pinned only | Both platforms | Each campaign |
| Settings → Drops | Farm campaigns that require a subscription | Both platforms | Each campaign |
| Settings → Drops | Farm campaigns without a linked account | Both platforms | Each campaign |
| Settings → Twitch/Kick | Category filter | One platform | Each campaign |

- **Subscriptions are controlled in two places, and they can conflict.** Picking "Requires subscription" in the Queue while the Settings toggle is off farms nothing.
- **The tabs mix two questions in one set.** Badges is a reward type. The two subscription tabs are about what a reward needs. With any-of matching, "free badges only" can't be expressed, and both subscription tabs on just means All. The maintainer needs combinations like free badges only.
- **The tabs look like view filters but are settings.** They also take a full toolbar row.

## Goals

- One place per platform that answers "what am I farming?". It's editable from a compact Queue dropdown and from that platform's Settings section, and both edit the same value.
- Two independent questions:
  - **Reward types:** multi-select.
  - **Subscription rewards:** a single choice.
- Any combination can be expressed, including free badges only, sub-only emotes, and items plus badges.
- **The maintainer's hard rule: if something is farmed, the user can see it, and if they can't see it, it isn't farmed.** Every campaign the filter excludes stays visible under Skipped with its reason and a fix.

## Non-goals

- Changing claiming. A reward that is already claimable is still claimed whatever the filter says, as #839 does today. This isn't farming, and it is visible in the activity log and inventory.
- Changing the category filter, the Games view, or how campaigns are ranked.
- Detecting reward types from names. Only the platform's typed data decides, as in #839.

## Anti-goals

- Any reward that gets farmed without showing in the Queue, and any campaign the filter excludes that disappears instead of showing under Skipped.
- Two controls that can contradict each other about the same thing.
- A dropdown label that hides what is actually narrowed, such as a bare "Custom".

## The setting

Per platform, replacing `platform.<name>.farmRewardTypes`:

```ts
type RewardKind = "item" | "badge" | "emote";
type SubscriptionRewardMode = "include" | "skip" | "only";

platform.<name>.rewardFilter: {
  kinds: RewardKind[];                     // default: every kind the platform has
  subscriptions: SubscriptionRewardMode;   // default: "include"
}
```

- `kinds` is the list of selected kinds. It's normalized to the kinds the platform supports, so Twitch keeps item, badge and emote and Kick keeps item. If the list ends up empty, it becomes every supported kind. Storing what's selected rather than what's excluded means a kind added later starts out unselected. *(builder's call: either works if it's documented; storing selected kinds is the suggestion)*
- **What each kind means.** The kind comes from Twitch's `distributionType` on each benefit: `BADGE` → badge, `EMOTE` → emote. `DIRECT_ENTITLEMENT`, any unknown type, and no type all count as item, so a reward is never dropped for lacking a type. A campaign stored before `benefits` existed uses `benefitType`, as `rewardBadgeBenefit` does today. Kick rewards are always item.
- **When a reward matches.** It matches when **both** hold:
  - at least one of its kinds is selected (a reward with an item and a badge matches if either is checked);
  - it passes the subscription mode, which looks at `rewardRequiresSubscription`. `include` lets everything through, `skip` only rewards with no subscription, and `only` only rewards that need one. A subscription the user marked as made still counts as needing one, as in #839.
- **Scope.** The rewards farmed are the ones that match, plus any reward they wait on (`rewardsInFarmingScope`, unchanged).
- **Default.** Everything selected with `include` means "All rewards" and behaves exactly as `farmRewardTypes: []` does today.
- **The UI won't let the user uncheck the last kind.** Normalization is the safety net behind that.

## Settings that move or go away

- `farmingEligibility.farmSubscriptionCampaigns` **is removed.** On migration, `false` sets `subscriptions: "skip"` on both platforms, and `true` changes nothing.
  - Behaviour change: the old toggle skipped a whole campaign if *any* of its rewards needed a subscription. `skip` drops only those rewards, so a mixed campaign now farms its free rewards. That farms more, but it stays visible. *(my call; the maintainer may override)*
  - The `subscription_campaigns_disabled` rejection code goes away with the toggle.
- `farmingEligibility.farmUnlinkedCampaigns` **becomes per platform:** `platform.<name>.farmUnlinkedCampaigns`, copied from the old value on both platforms. It moves from Settings → Drops into each platform's "Rewards to farm" group. It isn't in the Queue menu. *(my call)*
- `farmPinnedOnly` **moves into the Queue menu.** **Open: global or per platform** (see Open questions).
- **Migrating #839's `farmRewardTypes`** (develop builds only, since #839 is unreleased), best effort *(my call)*:
  - `[]` → default;
  - containing `badge` → `kinds: ["badge"]`;
  - only `no_subscription` → `skip`;
  - only `subscription` → `only`;
  - both subscription values → `include`.
  - The old key is then dropped.
- **Settings export/import** accepts the old keys on import and migrates them.

## Engine

- `evaluateCampaignFarming` replaces the `farmSubscriptionCampaigns` check and `campaignMatchesFarmTypes` with one `rewardFilter` check, at the point where the type check runs today.
- A campaign with no matching reward is rejected as `reward_type_filtered`. The rejection carries **which question excluded it**, so the UI can explain:
  - `kind`: no reward of a selected kind;
  - `subscription`: there are rewards of a selected kind, but every one fails the subscription mode.
- `reward_types_obtained` is kept, now based on the new filter.
- The scheduler's diagnostics label map is updated to match. Activity events keep their structured codes, and diagnostics stay English literals (CLAUDE.md).

## UI

### Queue toolbar

- **The tab row is removed.** One row holds the campaign search and the filter button. "Farm pinned only" leaves the toolbar.
- **The button's label names only what's narrowed:**
  - "All rewards" when nothing is narrowed (neutral style);
  - otherwise kinds, then subscription: "Badges", "Badges, emotes · no sub", "All · no sub", "Items · sub only".
  - A narrowed filter uses the accent style from the mockup. Exact wording and short forms are the builder's call.
- **The menu is a popover** with these sections, top to bottom:
  1. **Reward types:** checkboxes for In-game items, Badges and Emotes. Each shows how many campaigns would be queued if that kind alone were selected, with the current subscription mode (replaces `farmRewardTypeCounts`). The section is hidden on platforms with a single kind (Kick).
  2. **Subscription rewards:** a segmented Include / Skip / Only control, with a one-line hint for the current choice.
  3. **Farm pinned campaigns only:** a checkbox.
  4. **Reset to all rewards:** shown only when the filter is narrowed.
- **The popover has to be accessible:** a labelled checkbox group and a radio group, keyboard reachable, and Escape closes it. Check whether `primitives.tsx` already has a popover or menu primitive before adding one.
- **Every change saves at once and triggers a tick,** as the tabs do today.

### Skipped section

- **The header names how many campaigns the filter excludes,** e.g. "Skipped · 7 — 6 outside your reward filter". The count is the `reward_type_filtered` campaigns.
- **Each excluded card says why, using the kind/subscription detail:**
  - "Only in-game items; you're farming badges and emotes."
  - "Needs a subscription; you're skipping those."
  - "No subscription rewards; you're farming only those."
- **Each excluded card keeps the Farm all fix,** which resets the filter to the default for that platform.

### Settings → Twitch / Kick

- **There's a new "Rewards to farm" group,** placed before Categories, with:
  - **Reward types** as pills, hidden when the platform has one kind;
  - **Subscription rewards** as the segmented control;
  - **Farm campaigns without a linked account,** moved here.
- **The group is the same setting as the Queue menu.** Its description says so.
- **Settings → Drops loses the two eligibility rows.** Settings search and the deep-link focus ids are updated, and the Queue's fix buttons that pointed at `general.drops.*` now point at the platform group.

### Site demo and store screenshots

- **Update the demo's settings to the new shape.** The landing page renders the real Queue, so its toolbar changes with this work.
- **Check that the store screenshot pipeline still renders.**

## CLI

- **The config template writes `rewardFilter` and per-platform `farmUnlinkedCampaigns`.**
- **Old keys are accepted and migrated with one deprecation warning per command,** following the existing `campaignVisibility` pattern. The old keys are `farmRewardTypes` and `farmingEligibility.*`.
- **The README section on these keys is rewritten.**

## Locales

- **Add new keys and remove the dead ones:** `queueFacet*`, `farmSubscription*`, `farmUnlinked*` (re-added under platform wording if needed), and `campaignRejectionSubscriptionDisabled`.
- **Every catalog gets real translations,** following the existing parity test. As CLAUDE.md says, each locale's translation goes to an inexpensive subagent.

## Testing

Use focused Vitest files, extending the existing ones:

- **Matching:** each kind alone and combined, multi-benefit rewards, unknown and missing types, legacy `benefitType`.
- **All three subscription modes,** with marked subscriptions.
- **Precondition scope.**
- **Rejection detail:** `kind` vs `subscription`, and Farm all clearing it.
- **Migration:** `farmSubscriptionCampaigns: false`, the global unlinked toggle, and every `farmRewardTypes` shape.
- **Normalization:** Kick drops badge and emote, and an empty list becomes all kinds.
- **Settings export/import round-trip, and CLI parsing with the deprecation warnings.**
- **Queue view:**
  - the button label;
  - the menu's sections per platform;
  - the last kind can't be unchecked;
  - the Skipped header count and per-card reasons.
- **Browser QA:** the site demo in light and dark, at full and narrow widths, with reduced motion on (the maintainer's browser has it on).

## Open questions

- **Kick's menu.** Kick has no typed rewards and, per the subscription-marks design, no subscription rewards today. Following "hide a section with only one possible answer" would leave only "Farm pinned only" in Kick's menu. The approved mockup showed Kick with the subscription section.
- **Farm pinned only, global or per platform.** It's global today. A per-platform menu that changes the other platform too would surprise users.

## Left to the builder

- Component structure and file split.
- Popover positioning.
- The final English copy and short label forms.
- Animation, if any.
- How counts are computed efficiently.
