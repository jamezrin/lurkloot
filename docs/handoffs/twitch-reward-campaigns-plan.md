# Twitch reward campaigns (#904): implementation plan

Decisions from the maintainer, 2026-10-31:
- Assume the existing watch heartbeat credits reward-group progress.
- Reward campaigns join the normal Drops queue; there is no new watch source.
- The popup lets the user pick a track lane.

## Protocol (from the Twitch web bundles and a HAR, 2026-10-31)
- List: `ViewerDropsDashboard` with `fetchRewardCampaigns: true` returns `rewardCampaignsAvailableToUser[]`, each with `id name brand startsAt endsAt isSitewide game(null) unlockRequirements{minuteWatchedGoal subsGoal}`.
- Details: `dropsCampaign(id)` (type `DropsCampaign`) has `rewardGroups[]`, each with:
  - `id name track lane`
  - `progressCriteria{ requirementType(WATCH|SUB), requirements{minutesWatched subs}, repeatableConfig{repeatableTimes resetIntervalSeconds shouldCompleteAllRepeatsToEarn}, categories{id displayName}, channels{id} }`
  - `rewards{ id name thumbnailURL distributionType(BADGE|POOL|…) pool{ rewards{ id name thumbnailURL } } }`
  - `self{ status(IN_PROGRESS|CLAIMABLE|CLAIMED|FULFILLED|EXPIRED) currentMinutesWatched grantCount nextEligibleAt currentWindow{startedAt expiresAt} }`
- Claim: the existing `claimDropRewards`, with `dropInstanceID = "<userId>#<campaignId>#<rewardGroupId>"` once status is CLAIMABLE and, if `shouldCompleteAllRepeatsToEarn` is set, `grantCount >= repeatableTimes`.
- Lanes: `trackSelections(tracks:[ID!]!){track lane}` reads the user's choice; `setTrackSelection(input:{track,lane}){error}` sets it. Groups that share a `track` with different `lane`s are alternatives, and only the equipped lane is earned.
- Window: when `currentWindow.expiresAt <= now`, progress counts as 0. The next window opens at `nextEligibleAt ?? currentWindow.expiresAt`.

## Mapping onto existing models
- Each reward campaign becomes a `DropCampaign`:
  - `sitewide: true`, `categories: [{id,name}]` (the union over its groups), no `categoryId`/`gameName`.
  - `gameName` is set to the brand for display only; categoryId stays undefined.
- Each WATCH reward group becomes a `DropReward`:
  - `id` = group id; `claimId` = user#campaign#group; `requiredMinutes` = minutesWatched; `watchedMinutes` = currentMinutesWatched (0 if the window expired).
  - `benefits` come from the rewards; a POOL counts as BADGE when every pool entry is a badge.
  - `status`: CLAIMED/FULFILLED/EXPIRED or all grants done → claimed; CLAIMABLE (claimable per Twitch's rule) → claimable; otherwise in_progress or locked.
  - Cooling down: `availableFrom = nextEligibleAt` while that time is still in the future and grants remain. Existing rules already turn that into `reward_not_started`.
  - `repeat: {grantCount, times}` is shown in the popup.
  - SUB groups map to `requirement: "subscription"` and are never farmed, as today.
  - `lane: {track, lane, equipped}`: a group on an unequipped lane gets `requirement: "action"`, so it is never farmed and is shown as an alternative.
- `DropCampaign.laneChoices?: {track, lanes: {lane, name, imageUrl, equipped}[]}[]` drives the popup picker.

## Engine changes (generic, not Twitch-specific)
- `categories.ts`:
  - `categoryListIndex` also considers `campaign.categories` and returns the best (lowest) index.
  - Blocked means *all* of the campaign's categories are blocked.
  - A new `campaignWatchCategories(campaign, platformSettings)` narrows the categories to the allowed ones.
- `scheduler.chooseCampaignDecision`: passes the narrowed campaign to `listCandidateChannels`, with the directory reuse key `categories:<ids>`.

## Twitch adapter
- The dashboard always sends `fetchRewardCampaigns: true`, and the inline query also selects `rewardCampaignsAvailableToUser`.
- Watch-based reward campaigns: fetch details with an inline `dropsCampaign(id)` batch (integrity-retried), selecting the fields above, plus a `trackSelections` read for the tracks that are present.
- `listCandidateChannels`: for a sitewide campaign, read the directories of up to 3 categories, 10 channels each.
- `twitchStreamCategoryMatches` accepts any id in `campaign.categories`.
- Strict availability (AvailableDrops) is skipped for sitewide campaigns, which are never listed there.
- `selectRewardLane(campaignId, track, lane)` → `setTrackSelection`; the controller exposes a `selectRewardLane` runtime message and refreshes.

## Popup
- The campaign card shows a lane picker per track, a repeat counter ("day 1/3") and a "next window" time while cooling down.
- New locale keys; translations go to a cheap subagent.

## Tests
- Parser fixtures built from the HAR (user id scrubbed).
- Category helpers.
- Scheduler: a multi-category campaign, and a cooldown that is not farmed until it passes.
- Hours of ticks: a cooling reward never reopens a tab.
- Message routing for selectRewardLane.
- docs/architecture.md section.
