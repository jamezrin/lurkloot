# AvailableDrops Cache TTL Design

## Problem

The strict Twitch campaign-availability cache currently chooses its expiry from whether
`DropsHighlightService_AvailableDrops` returned any campaign. That is not the question the
caller asks. When Lurkloot checks campaign A and Twitch returns only campaign B, A is a negative
result even though the returned set is non-empty. The current implementation consequently keeps
that negative for the two-minute positive TTL instead of the intended 30-second negative TTL.

This affects only users who explicitly enable `strictCampaignAvailability`; the production
default remains off.

## Required behavior

- A requested campaign present in a valid `viewerDropCampaigns` snapshot is reusable for two
  minutes.
- A requested campaign absent from a valid snapshot is reusable for only 30 seconds, whether the
  returned array is empty or contains other campaign IDs.
- Expiring a negative lookup for campaign A must not prematurely expire a still-positive lookup
  for campaign B from the same snapshot.
- Malformed, mismatched, or errored responses remain uncached and fail open.
- Batch and single-channel paths use the same membership-relative cache behavior.
- Existing broadcast invalidation, authenticated-identity generation guards, bounded storage,
  and progress-confirmed availability overrides remain intact.

## Scope

Implement only the membership-relative TTL correction and deterministic regression coverage.
Batch request retry/fallback optimization is outside this issue.

## Source

GitHub issue: https://github.com/jamezrin/lurkloot/issues/414
