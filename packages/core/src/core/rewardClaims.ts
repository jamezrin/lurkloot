import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import { canClaimReward, reconcileCampaignAfterClaims } from "@lurkloot/shared/rewards";
import type { PlatformAdapter } from "../platforms/adapter";

// Claims every ready reward in the given campaigns. The scheduler tick reaches
// it only through its claimRewards effect; the drop-claim job calls it directly.
export type ClaimReadyRewardEvent = {
  level: "info";
  message: string;
  claimed: true;
  campaignId: string;
  campaignName: string;
  rewardId: string;
  rewardName: string;
  rewardImageUrl?: string;
  campaignUrl?: string;
} | {
  level: "info" | "warn" | "error";
  message: string;
  claimed?: false;
};

export async function claimReadyRewards(
  adapter: PlatformAdapter,
  campaigns: DropCampaign[],
  previouslyWaitingRewardIds: Set<string>,
  signal?: AbortSignal,
): Promise<{ campaigns: DropCampaign[]; events: ClaimReadyRewardEvent[] }> {
  const events: ClaimReadyRewardEvent[] = [];
  const updated: DropCampaign[] = [];
  const stillWaitingRewardIds = new Set<string>();

  for (const campaign of campaigns) {
    const rewards: DropReward[] = [];
    for (const reward of campaign.rewards) {
      signal?.throwIfAborted();
      if (reward.status === "claimable" && canClaimReward(reward)) {
        if (adapter.isClaimReady && !adapter.isClaimReady(reward)) {
          // Watched to completion, but the platform hasn't released the claim
          // yet (e.g. Twitch hasn't returned the drop-instance id). Defer; the
          // next tick re-checks once progress data catches up.
          rewards.push(reward);
          stillWaitingRewardIds.add(reward.id);
          if (!previouslyWaitingRewardIds.has(reward.id)) {
            events.push({
              level: "info",
              message: `${reward.name} watched-complete; waiting for ${campaign.name} claim to be released`,
            });
          }
          continue;
        }
        try {
          const claimed = await adapter.claimReward(campaign, reward, { signal });
          rewards.push(claimed ? { ...reward, status: "claimed", watchedMinutes: reward.requiredMinutes } : reward);
          if (claimed) {
            events.push({
              level: "info",
              message: `Claimed ${reward.name} from ${campaign.name}`,
              claimed: true,
              campaignId: campaign.id,
              campaignName: campaign.name,
              rewardId: reward.id,
              rewardName: reward.name,
              ...(reward.imageUrl ? { rewardImageUrl: reward.imageUrl } : {}),
              ...(campaign.url ? { campaignUrl: campaign.url } : {}),
            });
          } else {
            events.push({
              level: "warn",
              message: `Could not claim ${reward.name} from ${campaign.name}`,
            });
          }
        } catch (error) {
          rewards.push(reward);
          events.push({
            level: "error",
            message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
          });
        }
      } else {
        rewards.push(reward);
      }
    }
    updated.push(reconcileCampaignAfterClaims(campaign, rewards));
  }

  previouslyWaitingRewardIds.clear();
  for (const rewardId of stillWaitingRewardIds) previouslyWaitingRewardIds.add(rewardId);

  return { campaigns: updated, events };
}
