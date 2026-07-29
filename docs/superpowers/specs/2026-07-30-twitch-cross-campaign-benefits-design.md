# Twitch Cross-Campaign Benefit Claim-State Design

## Problem

Twitch's `gameEventDrops` inventory is campaign-agnostic and deduplicated by
benefit ID. Overwatch reused the `RoT S3 Lootbox` and `RoT S3 Epic Lootbox`
benefits in consecutive campaigns. A user who claimed those benefits in the
earlier campaign therefore still has their IDs in `gameEventDrops`.

Lurkloot currently uses that ownership as a fallback signal that a watch reward
is claimed. During the later campaign this overrides authoritative in-progress
state (`self.isClaimed === false` with partial watched minutes), causing the
reused rewards to appear complete.

## Required Behavior

When Twitch inventory v2 includes a campaign in `dropCampaignsInProgress`, its
per-reward `self` state and campaign-scoped `earnedDropRewards` are
authoritative. Campaign-agnostic benefit ownership must not mark any reward in
that campaign claimed.

When a campaign is absent from the progress payload, Lurkloot may retain its
existing completion fallbacks:

1. Prefer campaign-scoped `earnedDropRewards` counts when available.
2. Use campaign-agnostic `gameEventDrops` ownership only for benefits not
   covered by those counts.

This preserves completion recognition after Twitch removes a finished campaign
from `dropCampaignsInProgress`.

Legacy inventory v1 does not provide campaign-scoped earned-reward evidence.
It must retain its existing ownership fallback even while a campaign is in
progress because Twitch can leave `self.isClaimed` false for an already-owned
reward. Inventory v1 remains an explicit compatibility rollback; automatic
selection uses v2.

## Implementation

The Twitch parser already distinguishes inventory sources that contain
per-tier progress from bare campaign lists. Extend that distinction to the
owned-benefit fallback:

- While parsing an inventory campaign with per-tier progress and a v2
  `earnedDropRewards` field, pass no benefit IDs to the ownership fallback.
- While merging detailed campaign metadata with v2 inventory progress,
  suppress the ownership fallback whenever the matching progress campaign is
  present.
- Preserve the existing ownership behavior for v1 inventory responses that
  have no `earnedDropRewards` field.
- Leave campaign-scoped earned-reward handling unchanged.
- Leave behavior for campaigns absent from the progress payload unchanged.

No shared model, storage, scheduler, UI, permission, or localization change is
required.

## Tests

Add parser regression tests proving:

1. Under v2, a reward with partial progress and `isClaimed: false` stays in
   progress even when `gameEventDrops` contains the same benefit from an
   earlier campaign.
2. The same rule applies when detailed campaign metadata is merged with an
   in-progress v2 inventory response.
3. A campaign absent from `dropCampaignsInProgress` can still use the ownership
   fallback, protecting the historical completed-campaign behavior.
4. Existing v1 ownership-fallback coverage stays green.

Run the focused parser tests first, then the repository test, typecheck, and
verification commands appropriate to the change.
