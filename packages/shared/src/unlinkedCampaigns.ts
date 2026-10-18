import type { DropCampaign, UnlinkedCampaignMode } from "./models";

export const UNLINKED_CAMPAIGN_MODES: readonly UnlinkedCampaignMode[] = ["include", "skip", "last"];

export const DEFAULT_UNLINKED_CAMPAIGN_MODE: UnlinkedCampaignMode = "include";

export function normalizeUnlinkedCampaignMode(value: unknown): UnlinkedCampaignMode {
  return UNLINKED_CAMPAIGN_MODES.find((mode) => mode === value) ?? DEFAULT_UNLINKED_CAMPAIGN_MODE;
}

// The one test for "this campaign needs an account link first". Eligibility,
// ranking and the scheduler's reasons all read it, so the "farm last" tier can
// never disagree with the "skip" rejection about which campaigns are unlinked.
export function isCampaignUnlinked(
  campaign: Pick<DropCampaign, "accountLinked" | "eligibility">,
): boolean {
  return campaign.accountLinked === false || campaign.eligibility === "account_not_linked";
}
