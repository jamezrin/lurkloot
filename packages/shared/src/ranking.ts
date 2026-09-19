import { favouriteCategoryIndex } from "./categories";
import type { DropCampaign, EngineSettings } from "./models";

// Which layer placed a campaign in the list. The popup labels its group
// dividers from this, so "why is this campaign here" has one answer shared by
// the engine and the UI.
export type CampaignRankTier = "pinned" | "favourite" | "strategy";

const TIER_ORDER: Record<CampaignRankTier, number> = { pinned: 0, favourite: 1, strategy: 2 };

export function campaignRankTier(campaign: DropCampaign, settings: EngineSettings): CampaignRankTier {
  if (pinIndex(campaign, settings) !== -1) return "pinned";
  if (favouriteIndex(campaign, settings) !== -1) return "favourite";
  return "strategy";
}

// Position among the pinned campaigns, or -1. Pins are sparse: a campaign the
// user never placed by hand is ranked by the tiers below, which is what lets a
// newly discovered campaign surface without a reordering of the whole list.
export function pinIndex(campaign: DropCampaign, settings: EngineSettings): number {
  return settings.campaignPins.indexOf(campaign.id);
}

function favouriteIndex(campaign: DropCampaign, settings: EngineSettings): number {
  return favouriteCategoryIndex(campaign, settings.platform[campaign.platform]);
}

function availabilityScore(campaign: DropCampaign): number {
  return campaign.allowedChannels?.length ? campaign.allowedChannels.length : Number.MAX_SAFE_INTEGER;
}

function endScore(campaign: DropCampaign): number {
  return campaign.endsAt ? Date.parse(campaign.endsAt) : Number.MAX_SAFE_INTEGER;
}

// The single ranking every surface uses: the scheduler picks what to farm from
// it, the popup renders it, and the keep-watching comparison reads it, so the
// number on a card is the position the engine actually acts on.
//
// Three tiers, in order:
//  1. pinned campaigns, in pin order — an explicit placement by the user;
//  2. campaigns of favourite categories, in the order those were starred;
//  3. everything else, by the one live strategy.
//
// Ranking never decides whether a campaign may be farmed. Eligibility runs
// first (see isEligible/evaluateCampaignFarming), so a pin can never rescue a
// campaign an exclusion, a block or a class filter already refused.
export function rankCampaigns(campaigns: DropCampaign[], settings: EngineSettings): DropCampaign[] {
  return [...campaigns].sort((left, right) => {
    const leftTier = campaignRankTier(left, settings);
    const rightTier = campaignRankTier(right, settings);
    if (leftTier !== rightTier) return TIER_ORDER[leftTier] - TIER_ORDER[rightTier];

    if (leftTier === "pinned") return pinIndex(left, settings) - pinIndex(right, settings);
    if (leftTier === "favourite") {
      const favourites = favouriteIndex(left, settings) - favouriteIndex(right, settings);
      if (favourites !== 0) return favourites;
    }

    if (settings.priorityMode === "lowest_availability") {
      const availability = availabilityScore(left) - availabilityScore(right);
      if (availability !== 0) return availability;
    }
    const ends = endScore(left) - endScore(right);
    if (ends !== 0) return ends;
    const name = left.name.localeCompare(right.name);
    return name !== 0 ? name : left.id.localeCompare(right.id);
  });
}

// The pin list after dragging `campaignId` to `position` among the pins. Only
// the dragged campaign moves: every other campaign keeps whatever tier it had,
// which is what stops one drag from freezing the entire list.
export function pinCampaignAt(pins: string[], campaignId: string, position: number): string[] {
  const without = pins.filter((id) => id !== campaignId);
  const index = Math.max(0, Math.min(position, without.length));
  return [...without.slice(0, index), campaignId, ...without.slice(index)];
}

export function unpinCampaign(pins: string[], campaignId: string): string[] {
  return pins.filter((id) => id !== campaignId);
}
