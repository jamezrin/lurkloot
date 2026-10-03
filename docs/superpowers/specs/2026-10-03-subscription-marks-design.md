# Mark a subscription reward's subscription as made

Ships in 1.15.0, alongside the fixes from the same Chrome Web Store review (v1.14.2). Tracks #679, which stays open for the detection work itself.

## Problem

A reviewer bought and gifted subscriptions, including anonymous gifts. Twitch credited them: the rewards reached their inventory, sometimes with Twitch's own notification. Lurkloot still showed "Progress unavailable" and treated the subscription as not made. Detecting it reliably depends on Twitch fields we have not seen yet (see #679 and the `Twitch subscription reward evidence` diagnostic). Without detection the user loses more than a label:

- the campaign sits under Action required indefinitely;
- watch rewards that list the subscription reward as a prerequisite are blocked as `reward_prerequisites_unmet` and never farmed;
- a reward that needs a subscription and watch time ("Watch and Subscribe") is classified as a subscription reward and never farmed by watching.

## Goal

Give the user a control on each subscription reward, "I've subscribed", after which Lurkloot behaves as if it had detected that reward's qualifying subscription. It is a user assertion, never presented as Twitch's confirmation.

## Semantics

A mark applies to one reward that `canMarkSubscription` accepts: `requiredSubs > 0` and status `locked` or `in_progress`. Watch rewards cannot be marked, and a reward Twitch already made `claimable` or `claimed` ignores its mark.

- **Pure subscription reward** (`requiredMinutes === 0`): counts as obtained. It reads as done, satisfies the prerequisites of rewards that depend on it, and counts as done for its campaign: a campaign whose rewards are all claimed or marked shows as finished and is not farmable.
- **Subscription plus watch reward** (`requiredMinutes > 0`): counts as a watch reward, so it is selected, farmed, deadline-checked and accrual-tracked like one. Lurkloot never invents its claim id. It claims only once Twitch releases the drop instance (`self.dropInstanceID`), which the parser already turns into `claimable`. When its watched minutes reach the requirement and Twitch has released nothing, it is waiting for the platform: not earnable, so the scheduler moves on instead of watching it forever.

Marks live on rewards only. A reward's `status` and a campaign's `status`, `eligibility` and `eligibilityReason` stay what the platform and its parser reported: a mark never sets `claimed` or `completed`, so removing it always restores the platform's view exactly.

## Architecture

### Platform layer: unchanged

Adapters and parsers never see settings or marks, and keep reporting what the platform says. Whether a reward can be marked follows from its data (`requiredSubs`), not from the platform. Kick has no subscription rewards today, so the control never appears there, and nothing in the engine names Twitch.

### Shared contracts (`@lurkloot/shared`)

- **Setting.** `PlatformSettings.subscribedRewardMarks: string[]`, entries `"<campaignId>:<rewardId>"`. It is defaulted and normalized in `settings.ts` like `excludedChannels`, so it rides storage, settings export/import and the CLI config. Marks are per campaign, not per Twitch account, which keeps account ids out of settings exports. Marks of ended campaigns are not pruned, matching `excludedCampaignIds`.
- **Model.** `DropReward.subscriptionMarked?: true`, set only by `applySubscriptionMarks`.
- **Predicates (`rewards.ts`).** Everything that classifies a reward goes through these:
  - `canMarkSubscription(reward)`, as defined above.
  - `rewardRequirementType(reward)` returns `"watch"` for a marked reward with `requiredMinutes > 0`, before it consults `reward.requirement`. `isWatchReward` and `isSubscriptionReward` follow from it.
  - `isRewardObtained(reward)`: `status === "claimed"`, or marked with `requiredMinutes === 0`.
  - `isRewardAvailableToEarn` returns false for a marked reward whose `watchedMinutes >= requiredMinutes` and which is not `claimable` (waiting for the platform). Unmarked rewards are unaffected, so a watch reward whose heartbeat minutes reach the requirement before the next refresh behaves as today.
- **Reconciliation.** `reconcileCampaignAfterClaims` derives `preconditionsMet` from `isRewardObtained` instead of `status === "claimed"`. Its completion stays on `status === "claimed"`, because it writes the campaign's `status` and `eligibility` "completed" one way and a mark must never do that.
- **`applySubscriptionMarks(campaigns, marks)`.** A pure function, idempotent and reversible, that touches rewards only: for every reward it sets `subscriptionMarked` when `canMarkSubscription` accepts it and its key is in `marks`, clears it otherwise, then recomputes every reward's `preconditionsMet` through `isRewardObtained`. With no marks this reproduces the parser's own prerequisites, so applying an empty list restores the platform's view.
- **"Is this reward done?" checks move to `isRewardObtained`:** `campaignFarming.ts` (the `unclaimed` filter, so a fully marked campaign is `no_unclaimed_rewards`) and `campaignFilters.ts` (the reward fallback of `isCampaignFinished`, so it shows as finished, and the earnable filters). These checks are about the platform's report and keep reading `status`: claiming (`canClaimReward`, `claimReadyRewards`), deadline feasibility for claimed and claimable rewards, and everything listed under the engine below.
- **Campaign eligibility.** A campaign whose only rewards need a subscription keeps the parser's `waiting_for_subscription` eligibility when marked. Farmability does not reject on it, so a marked subscription plus watch reward is still farmed. Displays that present it derive "waiting" from the rewards instead (CLI status, below). The "No drops left" notification's `hasEarnableReward` stays as is: it also requires an idle session, so it cannot fire while a marked reward is being farmed.

### Engine (`@lurkloot/core`)

- **Intake.** Marks are applied where adapter output enters the engine:
  - the discovery snapshot (`discoverySnapshot.ts`), right after `refreshCampaigns` and before its farmability filter, so a newly unblocked campaign gets channel checks. The tick commit's `preserveClaimedRewards` copies the flag along, and its reconciliation runs through `isRewardObtained`;
  - the claim service's post-claim refresh (`claimService.ts`), before `preserveClaimedRewards`.
- **Settings changes.** A change to `subscribedRewardMarks` is not ranking-only, so `prepareSettingsCommit` already classifies it as a `"discovery"` effect. That invalidates the platform's discovery and selection and triggers a tick that re-applies the marks. No new commit hook.
- **Status-only checks, unchanged.** The "Reward earned" notification (`reporting.ts`, `newlyEarnedRewards`), claim preservation (`preserveClaimedRewards`), the post-claim handoff (`scheduler.ts`) and the claim-guidance helper (`helpers.ts`) keep comparing `status`, so a mark never notifies, is never kept as a Twitch claim, and never starts a handoff.
- **Accrual.** `scheduler.ts` reads `reward.isWatchBased` directly to decide whether to record watched minutes (around line 1978). It switches to `isWatchReward`, so a marked subscription plus watch reward is accrual-tracked and the existing no-progress channel switching applies to it.

### Popup (`@lurkloot/popup-ui`)

- **Control.** The subscription reward panel (`drops.tsx`, the `subscription` requirement branch) shows "I've subscribed" when `canMarkSubscription` accepts the reward. Once marked it shows "Subscribed · marked by you" with an Undo control. A marked subscription plus watch reward also shows its watch progress. The control writes `subscribedRewardMarks` through the existing settings update path, as Exclude does.
- **Immediate feedback.** The view model applies `applySubscriptionMarks` with the snapshot's settings before building views, so a toggle shows at once instead of after the tick. It is the same pure function the engine runs, so the two cannot disagree.
- **Direct reads.** `viewModels.ts` (next-reward remaining time), `drops.tsx` (the panel's requirement branches) and `statusStrip.tsx` (reward progress) read `reward.requirement` directly. They move to `rewardRequirementType`, keeping the panel's subscription branch for marked rewards so the mark stays visible.
- **Locales.** New keys `subscriptionMarkSubscribed` ("I've subscribed"), `subscriptionMarkedByYou` ("Subscribed · marked by you") and `subscriptionMarkUndo` ("Undo"), translated in all 11 catalogs.

### CLI (`@lurkloot/cli`)

Marks come from the config file's platform settings. `status.ts` shows a marked reward as "subscription marked", with watch progress for a subscription plus watch reward, and labels a campaign "waiting for subscription" only while one of its subscription rewards is neither obtained nor marked, rather than from `eligibility` alone.

## Risks

- A wrong mark spends watch time on rewards Twitch will not count. Accrual tracking (above) lets the existing no-progress channel switching act on it, and the card shows the mark came from the user.
- A mark applies to whichever Twitch account is signed in.
- This is the largest change in 1.15.0 (shared, core, popup-ui, CLI and 11 catalogs), but it is a no-op unless a user marks a reward: `applySubscriptionMarks` with no marks returns the platform's view.

## Acceptance

- **Shared unit tests:** a marked pure subscription reward is obtained and unlocks its dependents; a fully marked sub-only campaign is finished and not farmable while its `status` and `eligibility` are unchanged; a marked subscription plus watch reward is a watch reward and stops being earnable once its minutes are done; watch, claimable and claimed rewards ignore marks; applying an empty list restores the platform's view; settings normalization keeps, deduplicates and drops malformed entries.
- **Engine tests through the controller harness:** a mark gets a prerequisite-blocked watch reward farmed; marking fires no "Reward earned" notification and is not preserved as a claim after the mark is removed; Twitch releasing the reward later still gets it claimed; a marked subscription plus watch reward that earns nothing triggers the no-progress switch.
- **Popup tests:** the control appears only for markable rewards; marking and Undo update the panel immediately and write the setting.
- **CLI test:** status output for a marked reward.
- Changelog entry under 1.15.0. Run `pnpm check`; `pnpm verify` before cutting the release.
