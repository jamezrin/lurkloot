# Rewards to Farm Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Queue's "Rewards to farm" tabs and the cross-platform subscription toggle with one per-platform reward filter. The filter has reward kinds (multi-select) and a subscription mode (Include / Skip / Only), and it's edited from a Queue dropdown or from the platform's Settings group.

**Architecture:**
- **Shared model.** A new `@lurkloot/shared` module (`rewardFilter.ts`) owns the filter type, which kinds each platform supports, normalization and matching.
- **Engine.** Settings schema v8 migrates every old key. `evaluateCampaignFarming` judges each campaign by the filter, and a rejection records which question excluded it.
- **Popup.** One component, `RewardFilterFields`, is rendered both inside a Base UI popover in the Queue toolbar and in a new "Rewards to farm" group in each platform's Settings.

**Tech Stack:** TypeScript, React 19, Base UI (`@base-ui/react`), Tailwind, Vitest (happy-dom for UI tests), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-17-rewards-to-farm-menu-design.md`. The mockup, `2026-10-17-rewards-to-farm-menu-mockup.html`, is next to it. Read both.

## Global Constraints

- Work in `.worktrees/rewards-to-farm-menu` on branch `feat/rewards-to-farm-menu`. Run `pnpm install --frozen-lockfile` there first.
- **No `platform === "kick"` or `platform === "twitch"` branch** may choose behaviour for the filter. Platform differences come from `PLATFORM_REWARD_KINDS` (CLAUDE.md Architecture Rules).
- **Anything farmed is visible, and anything not visible is not farmed.** A campaign the filter excludes is in the Skipped section with a reason and a Farm all fix. Never filter it out of the list.
- **Claiming is not narrowed.** A claimable reward is claimed whatever the filter says.
- **Diagnostics stay English literals.** Never add `diagnostic*` locale keys.
- **Locale bodies are translated by an inexpensive subagent** (Haiku), one per locale. Preserve `$1`/`$2`, brand names and "farm".
- **Commits follow Conventional Commits.** Never pass `--author`.
- **No tests that assert on `.github/workflows` contents.**

## Review Focus

1. **A reward with an item and a badge, with only Badges checked.** It must be farmed: any-of across its benefits. Test in Task 1.
2. **A Twitch reward with no `distributionType`, or a legacy `benefitType`-only reward, with only Items checked.** It must be farmed as an item. Test in Task 1.
3. **A stored `{ kinds: [] }`, or kinds containing `"badge"` on Kick.** It must normalize to every supported kind, never to "farm nothing". Test in Task 1.
4. **An already-migrated v7 document from a develop build** with `farmRewardTypes: ["badge", "no_subscription"]` plus `farmingEligibility.farmSubscriptionCampaigns: false`. It must produce `{ kinds: ["badge"], subscriptions: "skip" }`. Test in Task 2.
5. **Kick with `subscriptions: "only"` left over from an old setting.** The Subscription section must still appear so the user can undo it, and every Kick campaign shows under Skipped with the subscription reason. Test in Task 3 (visibility) and Task 4 (reason).

---

### Task 1: Reward filter model and matching

**Files:**
- Create: `packages/shared/src/rewardFilter.ts`
- Modify: `packages/shared/src/models.ts`. Add the types and keep the old ones until Task 2.
- Test: `packages/extension/tests/rewardFilter.test.ts`

**Interfaces:**
- Produces, in `models.ts`:
  ```ts
  export type RewardKind = "item" | "badge" | "emote";
  export type SubscriptionRewardMode = "include" | "skip" | "only";
  export interface RewardFilter { kinds: RewardKind[]; subscriptions: SubscriptionRewardMode; }
  export type RewardFilterMiss = "kind" | "subscription";
  ```
- Produces, in `rewardFilter.ts`:
  - `REWARD_KINDS: readonly RewardKind[]` = `["item", "badge", "emote"]` (display order).
  - `PLATFORM_REWARD_KINDS: Record<Platform, readonly RewardKind[]>` = `{ twitch: ["item", "badge", "emote"], kick: ["item"] }`.
  - `SUBSCRIPTION_REWARD_MODES: readonly SubscriptionRewardMode[]` = `["include", "skip", "only"]`.
  - `defaultRewardFilter(platform: Platform): RewardFilter` returns every supported kind with `"include"`.
  - `normalizeRewardFilter(value: unknown, platform: Platform): RewardFilter`. It keeps only the supported kinds, in `REWARD_KINDS` order. An empty or invalid list becomes every supported kind. An invalid mode becomes `"include"`.
  - `isRewardFilterNarrowed(filter: RewardFilter, platform: Platform): boolean`.
  - `rewardKinds(reward: Pick<DropReward, "benefits" | "benefitType">): RewardKind[]`. `BADGE` → badge and `EMOTE` → emote. Anything else, unknown, or missing → item. With no `benefits`, use `benefitType`. The result is never empty.
  - `rewardMatchesFilter(reward: DropReward, filter: RewardFilter): boolean`.
  - `campaignFilterMiss(campaign: Pick<DropCampaign, "rewards">, filter: RewardFilter): RewardFilterMiss | undefined`. It returns `undefined` when some reward matches. It returns `"kind"` when no reward has a selected kind. Otherwise it returns `"subscription"`.

- [ ] **Step 1: Write the failing tests** in `rewardFilter.test.ts`. Build rewards with a small `reward(patch)` helper. Use the same shape as `campaign()` in `queueView.test.tsx`.
  - `it("reads kinds from every benefit")`: `rewardKinds({ benefits: [{ distributionType: "DIRECT_ENTITLEMENT" }, { distributionType: "BADGE" }] })` → `["item", "badge"]` (deduplicated).
  - `it("counts untyped and unknown benefits as items")`:
    - `rewardKinds({ benefits: [{}] })` → `["item"]`;
    - `rewardKinds({ benefits: [{ distributionType: "UNKNOWN" }] })` → `["item"]`;
    - `rewardKinds({})` → `["item"]`.
  - `it("falls back to the legacy first-benefit type")`: `rewardKinds({ benefitType: "EMOTE" })` → `["emote"]`.
  - `it("matches a mixed reward on any of its kinds")`: an item+badge reward matches `{ kinds: ["badge"], subscriptions: "include" }`.
  - `it("applies the subscription mode")`. Use a reward with `requiredSubs: 1` and one without:
    - `skip` rejects the sub reward and keeps the free one;
    - `only` does the opposite;
    - `include` keeps both.
  - `it("lets a marked subscription through skip but still counts it under only")`. Use `{ requiredSubs: 1, subscriptionMarked: true }`: it matches `skip` and it matches `only`.
  - `it("says which question excluded a campaign")`:
    - a campaign with only free item rewards and filter `{ kinds: ["badge"], subscriptions: "include" }` → `"kind"`;
    - a campaign with one sub badge and filter `{ kinds: ["badge"], subscriptions: "skip" }` → `"subscription"`;
    - a matching campaign → `undefined`.
  - `it("normalizes to what the platform supports")`:
    - `normalizeRewardFilter({ kinds: ["badge"] }, "kick")` → `{ kinds: ["item"], subscriptions: "include" }`;
    - `normalizeRewardFilter({ kinds: [] }, "twitch")` → the Twitch default;
    - `normalizeRewardFilter("junk", "twitch")` → the Twitch default;
    - `normalizeRewardFilter({ kinds: ["emote", "badge"], subscriptions: "only" }, "twitch")` → `{ kinds: ["badge", "emote"], subscriptions: "only" }`.
  - `it("knows when a filter is narrowed")`: the default → false; `{ ...default, subscriptions: "skip" }` → true; `{ kinds: ["item"], subscriptions: "include" }` → true on Twitch and false on Kick.

- [ ] **Step 2: Run the tests and check they fail.** Run `pnpm --filter @lurkloot/extension exec vitest run tests/rewardFilter.test.ts`. Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement `rewardFilter.ts` and the model types.**
  - In `rewardMatchesFilter`, the subscription test is `rewardRequiresSubscription(reward)`. Under `skip`, a reward with `subscriptionMarked === true` passes as well.
  - Import helpers from `./rewards`.

- [ ] **Step 4: Run the tests and check they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add packages/shared/src/rewardFilter.ts packages/shared/src/models.ts packages/extension/tests/rewardFilter.test.ts
  git commit -m "feat(shared): add the per-platform reward filter model"
  ```

---

### Task 2: Switch settings, migration and engine to the reward filter

This task removes the old fields, so it has to leave every package compiling. The popup only gets mechanical fixes here. Its new controls come in Task 3.

**Files:**
- Modify:
  - `packages/shared/src/models.ts`
    - `PlatformSettings`: remove `farmRewardTypes`; add `rewardFilter: RewardFilter`, `farmPinnedOnly: boolean` and `farmUnlinkedCampaigns: boolean`.
    - `EngineSettings`: remove `farmPinnedOnly` and `farmingEligibility`.
    - Delete `RewardFarmType`.
  - `packages/shared/src/settings.ts`. Update the defaults (both platforms: `rewardFilter: defaultRewardFilter(p)`, `farmPinnedOnly: false`, `farmUnlinkedCampaigns: true`), normalization, `mergeSettings` and `SettingsPatch`. Delete `REWARD_FARM_TYPES`, `normalizeFarmRewardTypes` and `normalizeFarmingEligibility`.
  - `packages/shared/src/settingsSchema.ts`: add `migrateToV8` and set `CURRENT_SETTINGS_SCHEMA_VERSION = 8`.
  - `packages/shared/src/campaignFarming.ts`
  - `packages/shared/src/campaignFilters.ts`
  - `packages/shared/src/failureReport.ts`
  - `packages/core/src/core/scheduler.ts`
  - `packages/core/src/background/stateTransaction.ts`
  - `packages/cli/src/settings.ts` and `packages/cli/src/config.ts`
  - `packages/popup-ui/src/Popup.tsx`, `queue.tsx`, `viewModels.ts`, `settingsRegistry.tsx` and `demo.ts` (mechanical only; see Step 7)
- Test:
  - `packages/extension/tests/settingsMigrations.test.ts`
  - `campaignFarming.test.ts`
  - `campaignFilters.test.ts`
  - `scheduler.test.ts`
  - `stateTransaction.test.ts`
  - `settingsExportImport.test.ts`
  - `packages/cli/tests/settings.test.ts`
  - Every other test file listed by `git grep -l "farmRewardTypes\|farmingEligibility\|farmPinnedOnly" packages/extension/tests packages/cli/tests`. Update their fixtures to the new shape.

**Interfaces:**
- Consumes everything Task 1 produced.
- Produces:
  - `CampaignFarmingEvaluation`'s rejection branch gains `filteredBy?: RewardFilterMiss`, set only for `reward_type_filtered`.
  - `CampaignFarmingRejectionCode` loses `subscription_campaigns_disabled`.
  - `rewardsInFarmingScope(campaign, filter: RewardFilter): DropReward[]` (the parameter type changes).
  - `campaignPassesFarmingEligibility(campaign: DropCampaign, platformSettings: Pick<PlatformSettings, "farmUnlinkedCampaigns">): boolean`.
  - `isRankingOnlyPatch` and `settingsPatchEffects` take `current: Pick<EngineSettings, "platform">`.
  - `withBlockerLifted` maps:
    - `reward_type_filtered` and `reward_types_obtained` → `{ rewardFilter: defaultRewardFilter(platform) }`;
    - `unlinked_campaigns_disabled` → `{ farmUnlinkedCampaigns: true }`;
    - both on the campaign's platform.

- [ ] **Step 1: Write the failing migration tests** in `settingsMigrations.test.ts`. Each one starts from `withSchemaVersion(doc, 7)` and checks `migrateSettings(...).settings`:
  - `it("v8 turns the subscription toggle off into skip on both platforms")`: `farmingEligibility: { farmSubscriptionCampaigns: false }` gives both platforms `rewardFilter: { subscriptions: "skip" }`. `farmingEligibility` is gone, and a `moved_property` diagnostic names `farmingEligibility.farmSubscriptionCampaigns`.
  - `it("v8 copies the unlinked toggle and farm pinned only to both platforms")`: `farmingEligibility: { farmUnlinkedCampaigns: false }, farmPinnedOnly: true` gives `platform.twitch.farmUnlinkedCampaigns === false`, `platform.kick.farmPinnedOnly === true`, and so on, with no top-level keys left.
  - `it("v8 maps the Queue tab types")`. Use `platform.twitch.farmRewardTypes`:
    - `[]` → no `kinds`, no `subscriptions`;
    - `["badge"]` → `kinds: ["badge"]`;
    - `["no_subscription"]` → `subscriptions: "skip"`;
    - `["subscription"]` → `subscriptions: "only"`;
    - `["no_subscription", "subscription"]` → no `subscriptions`.
    - In every case `farmRewardTypes` is deleted.
  - `it("v8 lets the tab subscription choice win over the old toggle")`: `farmRewardTypes: ["badge", "subscription"]` with `farmSubscriptionCampaigns: false` → `{ kinds: ["badge"], subscriptions: "only" }`. Also, `["badge", "no_subscription"]` with the toggle off → `{ kinds: ["badge"], subscriptions: "skip" }` (Review Focus 4).
  - `it("v8 keeps a current rewardFilter")`: an existing `platform.kick.rewardFilter` is left untouched.

- [ ] **Step 2: Write the failing engine tests.**
  - In `campaignFarming.test.ts`, replace the `farmRewardTypes` cases:
    - `it("rejects a campaign with no reward of a selected kind, saying it was the kind")`: expect `{ code: "reward_type_filtered", filteredBy: "kind" }`.
    - `it("rejects a campaign whose kinds match but every one needs a skipped subscription")`: expect `filteredBy: "subscription"`.
    - `it("farms the free rewards of a mixed campaign under skip")`: the campaign is farmable, and `rewardsInFarmingScope` returns only the free reward plus its precondition.
    - `it("lifting a reward-filter rejection restores the platform default")`.
  - In `scheduler.test.ts`, update the "farm pinned only" cases so `platform.twitch.farmPinnedOnly: true` leaves Kick unaffected.
  - In `stateTransaction.test.ts`: a `campaignPins` patch isn't ranking-only while either platform has `farmPinnedOnly`.

- [ ] **Step 3: Run the tests and check they fail.** Run `pnpm --filter @lurkloot/extension exec vitest run tests/settingsMigrations.test.ts tests/campaignFarming.test.ts tests/scheduler.test.ts tests/stateTransaction.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement `migrateToV8`.** Follow `migrateToV7`'s style (`platformBlock`, `ensurePlatformBlock`, and a `diagnose` with `code: "moved_property"` on every key). Steps, per platform:
  1. If `farmRewardTypes` is an array, derive the parts: `kinds` is `["badge"]` if it contains `"badge"`. `subscriptions` is `"skip"` if the only subscription value is `"no_subscription"`, and `"only"` if the only one is `"subscription"`.
  2. If `farmingEligibility.farmSubscriptionCampaigns === false` and step 1 set no `subscriptions`, set `"skip"`.
  3. If `rewardFilter` is absent and anything was derived, write `rewardFilter` with just the derived parts. Normalization fills the rest.
  4. Copy `farmingEligibility.farmUnlinkedCampaigns` and the top-level `farmPinnedOnly` into the block when the block lacks them.

  Then delete `farmRewardTypes`, `farmingEligibility` and the top-level `farmPinnedOnly`.

- [ ] **Step 5: Implement the settings, engine and CLI changes.**
  - **`settings.ts` normalization:** `rewardFilter: normalizeRewardFilter(platform?.x?.rewardFilter, "x")`, and `booleanOr` for the two new booleans. `mergeSettings` keeps its shallow per-platform spread, so callers always send a whole `rewardFilter`.
  - **`campaignFarming.ts`:**
    - drop the subscription-toggle check;
    - the unlinked check reads `settings.platform[campaign.platform].farmUnlinkedCampaigns`;
    - the pinned check reads `settings.platform[campaign.platform].farmPinnedOnly`;
    - replace `campaignMatchesFarmTypes` with `campaignFilterMiss` → `{ farmable: false, code: "reward_type_filtered", filteredBy }`;
    - `reward_types_obtained` fires when the filter `isRewardFilterNarrowed` and an unobtained reward exists outside the scope.
    - Delete `rewardMatchesFarmTypes` and `campaignMatchesFarmTypes`.
  - **`campaignFilters.ts`:** `campaignPassesFarmingEligibility` takes the platform settings and checks only unlinked. `campaignEligibleClass` passes `settings.platform[campaign.platform]`.
  - **`scheduler.ts`:**
    - `activeReward` passes `rewardFilter`;
    - `isEligible` reads the platform's `farmPinnedOnly`;
    - the no-campaigns reasons use `campaignFilterMiss(...) !== undefined` with text `"No campaigns have rewards your reward filter allows"`, and the platform's `farmPinnedOnly`;
    - remove the `subscription_campaigns_disabled` label;
    - `campaignSearchFingerprint` drops `farmPinnedOnly` and `farmingEligibility`, since `platform.twitch` already carries them.
  - **`stateTransaction.ts`:** pins count while any platform's `farmPinnedOnly` is on.
  - **`failureReport.ts`:** report `rewardFilter` as `"<kinds joined by ', '> · <subscriptions>"`.
  - **CLI:**
    - remove `farmingEligibility` and top-level `farmPinnedOnly` from `CliSettings`, the defaults, `CLI_SETTING_KEYS` and `FARMING_ELIGIBILITY_KEYS`;
    - `CLI_PLATFORM_KEYS` swaps `farmRewardTypes` for `rewardFilter`, `farmPinnedOnly` and `farmUnlinkedCampaigns`;
    - `config.ts` writes them per platform.
    - Old keys reach the CLI already migrated by `migrateSettings`, which turns its diagnostics into the deprecation warnings.

- [ ] **Step 6: Run the engine and CLI tests and check they pass.** Run `pnpm --filter @lurkloot/extension exec vitest run tests/settingsMigrations.test.ts tests/campaignFarming.test.ts tests/campaignFilters.test.ts tests/scheduler.test.ts tests/stateTransaction.test.ts tests/settingsExportImport.test.ts` and `pnpm --filter @lurkloot/cli test`. Expected: PASS. Add a CLI case: a config with top-level `farmPinnedOnly: true` loads with one deprecation warning and both platforms pinned-only.

- [ ] **Step 7: Make the popup compile, mechanically.**
  - In `Popup.tsx`, pass `farmPinnedOnly={settings.platform[platform].farmPinnedOnly}`. The pinned-only toggle saves `{ platform: { [platform]: { farmPinnedOnly } } }` with `tickAfterSavePlatforms: [platform]`.
  - Remove `RewardTypeTabs`, `QUEUE_FACETS`, the `rewardTypes`/`availableRewardTypes`/`rewardTypeCounts`/`onRewardTypesChange` props, `RewardTypeTab` and `farmRewardTypeCounts`.
  - In `settingsRegistry.tsx`, remove the `general.drops.farmUnlinked` and `general.drops.farmSubscription` entries.
  - In `queue.tsx`'s fix map, drop `subscription_campaigns_disabled`.
  - In `drops.tsx`'s key map, drop `subscription_campaigns_disabled`.
  - Update `demo.ts` to the new platform fields.
  - Update `queueView.test.tsx` by deleting the three tab tests, which Task 3 replaces.

- [ ] **Step 8: Run the full checks.** Run `pnpm typecheck && pnpm test`. Expected: PASS.

- [ ] **Step 9: Commit**
  ```bash
  git add -A packages
  git commit -m "feat(settings): farm by a per-platform reward filter"
  ```

---

### Task 3: The Rewards to farm menu and Settings group

**Files:**
- Create: `packages/popup-ui/src/rewardFilterMenu.tsx`
- Modify:
  - `packages/popup-ui/src/queue.tsx` (toolbar row)
  - `packages/popup-ui/src/Popup.tsx`
  - `packages/popup-ui/src/viewModels.ts`
  - `packages/popup-ui/src/settingsRegistry.tsx`. Add a new `${platform}.rewards` group before `${platform}.categories`.
  - `packages/locales/messages/en.json`. English only here; the other locales come in Task 5.
- Test:
  - `packages/extension/tests/queueView.test.tsx`
  - `packages/extension/tests/settingsView.test.tsx`
  - new `packages/extension/tests/rewardFilterMenu.test.tsx`

**Interfaces:**
- Consumes `RewardFilter`, `PLATFORM_REWARD_KINDS`, `defaultRewardFilter` and `isRewardFilterNarrowed` from Task 1, and the new platform settings from Task 2.
- Produces, in `viewModels.ts`:
  - `rewardKindCounts(campaigns: readonly DropCampaign[], settings: ExtensionSettings, platform: Platform): Record<RewardKind, number>`. This is how many campaigns `campaignSection` puts in `"queue"` when that kind alone is selected and the current subscription mode is kept. Apply subscription marks the way `farmRewardTypeCounts` did.
  - `showsSubscriptionChoice(campaigns: readonly DropCampaign[], filter: RewardFilter): boolean`. It's true when any campaign has a reward with `requiredSubs > 0`, or when `filter.subscriptions !== "include"`.
- Produces, in `rewardFilterMenu.tsx`:
  - `rewardFilterLabel(filter: RewardFilter, platform: Platform, t: TFunction): string`.
  - `RewardFilterFields(props: { platform: Platform; filter: RewardFilter; showSubscriptions: boolean; counts?: Partial<Record<RewardKind, number>>; onChange(filter: RewardFilter): void })`. It renders the kinds checkbox group (only when `PLATFORM_REWARD_KINDS[platform].length > 1`) and the subscription radio group with the hint for the current mode.
  - `RewardFilterMenu(props: { platform; filter; showSubscriptions; counts; farmPinnedOnly: boolean; onChange(filter: RewardFilter): void; onFarmPinnedOnlyChange(value: boolean): void })`. A Base UI `Popover` whose trigger shows `rewardFilterLabel`. The trigger gets `data-reward-filter` plus `data-narrowed` when `isRewardFilterNarrowed`. The popup uses `FLOATING_POPUP_CLASS` and `usePortalContainer`, and is non-modal, like `Dropdown`. Its content is `RewardFilterFields`, then the pinned-only checkbox, then "Reset to all rewards" (only when narrowed).

- [ ] **Step 1: Write the failing tests.**
  - In `rewardFilterMenu.test.tsx` (happy-dom), test `rewardFilterLabel` with `t` returning keys:
    - default → `"rewardFilterAll"`;
    - `{ kinds: ["badge"], subscriptions: "include" }` → contains `rewardKindBadge`;
    - `{ kinds: ["badge", "emote"], subscriptions: "skip" }` → contains both kind keys and `rewardFilterNoSub`;
    - `{ kinds: all, subscriptions: "only" }` → contains `rewardFilterAllKinds` and `rewardFilterSubOnly`.
  - Also in `rewardFilterMenu.test.tsx`:
    - `it("cannot uncheck the last kind")`: with `kinds: ["badge"]`, the Badges checkbox is disabled.
    - `it("hides the kinds on a platform with one kind")`: Kick renders no `[data-reward-kind]`.
  - In `queueView.test.tsx`:
    - `it("opens the reward filter from the toolbar and saves both questions")`: click `[data-reward-filter]`, uncheck In-game items, then pick Skip. `onRewardFilterChange` receives `{ kinds: ["badge", "emote"], subscriptions: "include" }` and then `{ kinds: ["badge", "emote"], subscriptions: "skip" }`.
    - `it("shows the subscription choice on a platform without subscription rewards only while it is narrowed")`: Kick with `subscriptions: "include"` has no `[data-subscription-mode]`. With `"only"`, it has one (Review Focus 5).
    - `it("moves farm pinned only into the menu")`: no `[data-queue-pinned-only]` outside the popover.
  - In `settingsView.test.tsx`:
    - `it("edits the same reward filter from each platform's Settings")`: the `twitch.rewards` group renders the fields, pinned-only and unlinked. Changing Skip there calls `onSettingsChange` with `{ platform: { twitch: { rewardFilter: { …, subscriptions: "skip" } } } }`.
    - `general.drops` no longer contains the two eligibility rows.

- [ ] **Step 2: Run the tests and check they fail.** Run `pnpm --filter @lurkloot/extension exec vitest run tests/rewardFilterMenu.test.tsx tests/queueView.test.tsx tests/settingsView.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement the component, viewModels helpers, Queue toolbar and Settings group.**
  - **Queue toolbar:** search, then `RewardFilterMenu`, on one row. `ViewToolbar` with the tabs is gone.
  - **`QueuePanel` props:** `rewardFilter: RewardFilter`, `rewardKindCounts`, `showSubscriptionChoice: boolean`, `onRewardFilterChange(filter: RewardFilter)`, plus the existing `farmPinnedOnly` and `onFarmPinnedOnlyChange`.
  - **`Popup.tsx`:** compute counts the way `rewardTypeCounts` was memoised. Save with `{ tickAfterSave: true, tickAfterSavePlatforms: [platform] }`.
  - **Settings group:** `id: \`${platform}.rewards\``, `titleKey: "rewardFilterTitle"`, description `t("rewardFilterDescription", details.label)`. Its entries, all saved through `platformPatch`:
    - `${platform}.rewards.filter`, which renders `RewardFilterFields`;
    - `${platform}.rewards.pinnedOnly`;
    - `${platform}.rewards.unlinked`, which reuses `farmUnlinkedTitle`/`farmUnlinkedDescription`.
  - **Queue fix buttons:** `unlinked_campaigns_disabled` opens Settings focused on `${platform}.rewards` (pass the group id through `onOpenSettings`).
  - **English copy** for `en.json`, final but tunable. Remove `queueFacetLabel/All/NoSubscription/Subscription/Badge`, `farmSubscriptionTitle/Description` and `campaignRejectionSubscriptionDisabled`. Add:
    - `rewardFilterTitle` "Rewards to farm"
    - `rewardFilterDescription` "What Lurkloot farms on $1. The filter menu in the Queue changes the same setting."
    - `rewardKindsTitle` "Reward types"
    - `rewardKindsDescription` "A reward is farmed if any part of it matches."
    - `rewardKindItem` "In-game items"
    - `rewardKindBadge` "Badges"
    - `rewardKindEmote` "Emotes"
    - `rewardKindItemShort` "Items"
    - `subscriptionRewardsTitle` "Subscription rewards"
    - `subscriptionRewardsDescription` "Rewards that need a channel subscription."
    - `subscriptionModeInclude` "Include"
    - `subscriptionModeSkip` "Skip"
    - `subscriptionModeOnly` "Only"
    - `subscriptionModeIncludeHint` "Subscription rewards are farmed with the rest."
    - `subscriptionModeSkipHint` "Rewards that need a subscription are not farmed."
    - `subscriptionModeOnlyHint` "Only rewards that need a subscription are farmed."
    - `rewardFilterAll` "All rewards"
    - `rewardFilterAllKinds` "All"
    - `rewardFilterNoSub` "no sub"
    - `rewardFilterSubOnly` "sub only"
    - `rewardFilterReset` "Reset to all rewards"
    - `farmPinnedOnlyTitle` "Farm pinned campaigns only"
    - `farmPinnedOnlyDescription` "Only campaigns you pinned in the Queue are farmed on $1."

- [ ] **Step 4: Run the tests and check they pass.** Same command, plus `pnpm --filter @lurkloot/extension exec vitest run tests/i18n.test.ts`. Expected: PASS. The i18n parity test will fail until Task 5 if it compares locales, so add the new keys to every locale with the English text as a placeholder now, and Task 5 replaces them.

- [ ] **Step 5: Commit**
  ```bash
  git add -A packages
  git commit -m "feat(popup): pick rewards to farm from one menu"
  ```

---

### Task 4: Explain filtered campaigns in Skipped

**Files:**
- Modify:
  - `packages/popup-ui/src/drops.tsx`: `campaignRejectionMessageKey` now takes the rejection.
  - `packages/popup-ui/src/queue.tsx`: the Skipped divider hint.
  - every caller of `campaignRejectionMessageKey`
  - `en.json`
- Test: `packages/extension/tests/queueView.test.tsx`

**Interfaces:**
- Consumes `filteredBy` from Task 2 and `RewardFilter` from Task 1.
- Produces `campaignRejectionMessage(rejection: Rejection, filter: RewardFilter, t: TFunction): string`, which replaces `campaignRejectionMessageKey(code)`. For `reward_type_filtered`:
  - `filteredBy: "kind"` → `t("campaignRejectionRewardKind", <selected kinds as a disjunction list via Intl.ListFormat with the UI locale>)`;
  - `"subscription"` with `skip` → `t("campaignRejectionSubscriptionSkipped")`;
  - `"subscription"` with `only` → `t("campaignRejectionSubscriptionOnly")`.
  - Every other code keeps its current key.

- [ ] **Step 1: Write the failing tests** in `queueView.test.tsx`:
  - `it("says which part of the reward filter skipped a campaign")`. Twitch filter `{ kinds: ["badge"], subscriptions: "skip" }`, with an item-only campaign and a sub-badge campaign. Their reasons contain `campaignRejectionRewardKind` and `campaignRejectionSubscriptionSkipped` respectively, and both rows offer `queueFixFarmAll`.
  - `it("explains a Kick campaign skipped by a leftover only")`. Kick with `subscriptions: "only"` shows the reason `campaignRejectionSubscriptionOnly`.
  - `it("counts the campaigns the reward filter skipped on the Skipped divider")`. Two filtered and one excluded campaign → the divider hint is `queueSkippedByFilter:2`.

- [ ] **Step 2: Run the tests and check they fail.** Run `pnpm --filter @lurkloot/extension exec vitest run tests/queueView.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement it.**
  - The divider hint only appears when the count is > 0.
  - Add to `en.json` and, as placeholders, to every other locale:
    - `campaignRejectionRewardKind` "No $1 in this campaign."
    - `campaignRejectionSubscriptionSkipped` "Its rewards need a subscription, and you're skipping those."
    - `campaignRejectionSubscriptionOnly` "It has no subscription rewards, and you're farming only those."
    - `queueSkippedByFilter` "$1 outside your reward filter"
  - Remove `campaignRejectionRewardType` if nothing else uses it.

- [ ] **Step 4: Run the tests and check they pass.** Run `pnpm --filter @lurkloot/extension exec vitest run tests/queueView.test.tsx tests/i18n.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add -A packages
  git commit -m "feat(queue): say which part of the reward filter skipped a campaign"
  ```

---

### Task 5: Translations, demo, docs and CLI README

**Files:**
- Modify:
  - `packages/locales/messages/*.json` (16 non-English catalogs)
  - `packages/popup-ui/src/demo.ts`
  - `docs/architecture.md`, at lines 627, 684-690 and 745-794. Describe `rewardFilter`, per-platform `farmPinnedOnly`/`farmUnlinkedCampaigns` and schema v8.
  - `packages/cli/README.md`. Rewrite the `farmRewardTypes`, `farmPinnedOnly` and `farmingEligibility` paragraphs.

- [ ] **Step 1: Translate the placeholders.** Dispatch one Haiku subagent per locale (`ar cs de es fr hi id it ja ko pl pt_BR ru tr uk zh_CN`). Give each the new English keys and values from Tasks 3–4, with these instructions: keep `$1`, keep "Lurkloot", treat "farm" as the gaming term, and return JSON only. Merge each result into its catalog.

- [ ] **Step 2: Make the demo showcase the filter.** Set the demo's Twitch platform to the default filter, so the landing page shows "All rewards". Keep the Pixel Parade badge campaign.

- [ ] **Step 3: Update the docs.** Update `docs/architecture.md` and `packages/cli/README.md` as listed above.

- [ ] **Step 4: Verify.** Run `pnpm check`. Expected: PASS, with locale parity, typecheck, tests and the site build all green.

- [ ] **Step 5: Commit**
  ```bash
  git add -A packages docs
  git commit -m "docs: describe the per-platform reward filter"
  ```

---

### Task 6: Browser QA and PR

- [ ] **Step 1: Run the full verification.** Run `pnpm verify`. Expected: PASS, including both browser builds.

- [ ] **Step 2: Check the site demo in a browser.** Run `pnpm dev:site` and open the landing-page Queue. Check:
  - **Light and dark, at full and narrow width, with reduced motion on.** That is the maintainer's browser setting.
  - **The menu works from the keyboard:** Tab to the button, Enter opens it, arrows move inside each group, and Escape closes it.
  - **A narrowed filter shows** the accent button and the Skipped hint.

  Take screenshots of the menu open and closed, and of Settings → Twitch → Rewards to farm.

- [ ] **Step 3: Check the store screenshots still render.** Run the store screenshot script, if the repo has one (`git grep -l "storeArtwork" scripts`).

- [ ] **Step 4: Open the PR into `develop`.** Title: `feat(queue): pick rewards to farm from one menu`. In the body:
  - **Summary.**
  - **Behaviour changes:**
    - Skip now farms the free rewards of mixed campaigns;
    - pinned-only and unlinked are now per platform;
    - schema v8.
  - **Testing performed.**
  - **The screenshots.**
  - **`Refs #731`.**

  Link the PR in T3 and enable auto-merge (`gh pr merge --auto --squash`).
