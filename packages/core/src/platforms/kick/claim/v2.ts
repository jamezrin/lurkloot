import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import type { KickClaimCapability, KickClaimOutcome } from "./types";
import { isKickClaimSuccess, isRecord, safeHttpsUrl } from "./types";
import { kickClaimV1 } from "./v1";

export class KickClaimV2 implements KickClaimCapability {
  private readonly suppressions = new Map<string, string>();

  classify(response: unknown, campaign: DropCampaign): KickClaimOutcome {
    if (isKickClaimSuccess(response)) return { kind: "claimed" };
    if (isRecord(response)) {
      const data = isRecord(response.data) ? response.data : undefined;
      for (const value of [response.connect_url, response.connectUrl, data?.connect_url, data?.connectUrl]) {
        const url = safeHttpsUrl(value);
        if (url) return { kind: "link_required", url };
      }
    }
    return kickClaimV1.classify(response, campaign);
  }

  isSuppressed(campaign: DropCampaign, reward: DropReward): boolean {
    return this.suppressions.has(this.key(campaign, reward));
  }

  suppress(campaign: DropCampaign, reward: DropReward, url: string): void {
    this.suppressions.set(this.key(campaign, reward), url);
    const guidance = { kind: "link_required" as const, url };
    campaign.claimGuidance = guidance;
    reward.claimGuidance = guidance;
  }

  reconcileProgress(campaigns: DropCampaign[], affirmativelyLinkedCampaignIds: ReadonlySet<string>): DropCampaign[] {
    return campaigns.map((campaign) => {
      const suppressedRewards = campaign.rewards.filter((reward) => this.isSuppressed(campaign, reward));
      if (suppressedRewards.length === 0) return campaign;
      if (affirmativelyLinkedCampaignIds.has(campaign.id)) {
        for (const reward of suppressedRewards) this.suppressions.delete(this.key(campaign, reward));
        return {
          ...campaign,
          claimGuidance: undefined,
          rewards: campaign.rewards.map((reward) => ({ ...reward, claimGuidance: undefined })),
        };
      }
      const campaignUrl = this.suppressions.get(this.key(campaign, suppressedRewards[0]));
      return {
        ...campaign,
        claimGuidance: campaignUrl ? { kind: "link_required", url: campaignUrl } : campaign.claimGuidance,
        rewards: campaign.rewards.map((reward) => {
          const url = this.suppressions.get(this.key(campaign, reward));
          return url ? { ...reward, claimGuidance: { kind: "link_required", url } } : reward;
        }),
      };
    });
  }

  private key(campaign: DropCampaign, reward: DropReward): string {
    return `${campaign.id}:${reward.id}`;
  }
}
