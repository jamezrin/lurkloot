import { matchesSearch } from "./settingsSearch";
import type { CampaignView, GameItem } from "./types";

export function filterCampaigns(campaigns: CampaignView[], gameMap: Record<string, GameItem>, query: string): CampaignView[] {
  if (!query.trim()) return campaigns;
  return campaigns.filter((campaign) => matchesSearch(
    [campaign.title, gameMap[campaign.gameId]?.name ?? "", ...campaign.rewards.map((reward) => reward.name)],
    query,
  ));
}
