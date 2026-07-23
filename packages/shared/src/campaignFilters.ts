import type { CampaignFilterKey, DisplayFilterKey, FarmingFilterKey } from "./models";

export const FARMING_FILTER_KEYS: FarmingFilterKey[] = ["notLinked", "subscription"];
export const DISPLAY_FILTER_KEYS: DisplayFilterKey[] = ["upcoming", "expired", "excluded", "finished"];
export const CAMPAIGN_FILTER_KEYS: CampaignFilterKey[] = [...FARMING_FILTER_KEYS, ...DISPLAY_FILTER_KEYS];
