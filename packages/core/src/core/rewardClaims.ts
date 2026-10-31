import type { DropCampaign, DropReward, Platform, WatchSession } from "@lurkloot/shared/models";
import { canClaimReward, reconcileCampaignAfterClaims } from "@lurkloot/shared/rewards";
import type { CampaignRewardData } from "@lurkloot/shared/events";
import { safeHttpsUrl } from "@lurkloot/shared/rewardEvents";
import type { RewardDetail, RewardObtainedData } from "@lurkloot/shared/rewardEvents";
import type { ClaimedChallenge, PlatformAdapter } from "../platforms/adapter";

// One claim request per reward at a time within one process (#599). The
// scheduler tick claims outside every lock, so it can overlap the drop-claim
// job or a manual claim for the same reward; each path reserves the reward
// first and skips it while another path holds it. A claim that succeeded
// stays reserved until its claimer has committed it (#597): until then the
// stored state still shows it claimable to everyone else.
export interface RewardClaimGuard {
  // False when another path is claiming the reward right now.
  reserve(rewardId: string): boolean;
  release(rewardId: string): void;
}

export function createRewardClaimGuard(): RewardClaimGuard {
  const inFlight = new Set<string>();
  return {
    reserve(rewardId) {
      if (inFlight.has(rewardId)) return false;
      inFlight.add(rewardId);
      return true;
    },
    release(rewardId) {
      inFlight.delete(rewardId);
    },
  };
}

function markClaimed(reward: DropReward): DropReward {
  return { ...reward, status: "claimed", watchedMinutes: reward.requiredMinutes };
}

// Claims every ready reward in the given campaigns. The scheduler tick reaches
// it only through its claimRewards effect; the drop-claim job calls it directly.
export type ClaimReadyRewardEvent =
  | ({
      level: "info";
      message: string;
      claimed: true;
    } & CampaignRewardData)
  | {
      level: "info" | "warn" | "error";
      message: string;
      claimed?: false;
    };

// The campaign and reward facts every drop activity event carries, built in one
// place so each emit site reports the same ones.
export function campaignRewardData(campaign: DropCampaign, reward: DropReward): CampaignRewardData {
  const gameImageUrl = safeHttpsUrl(campaign.gameImageUrl);
  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    rewardId: reward.id,
    rewardName: reward.name,
    ...(reward.imageUrl ? { rewardImageUrl: reward.imageUrl } : {}),
    ...(campaign.url ? { campaignUrl: campaign.url } : {}),
    ...(campaign.gameName ? { gameName: campaign.gameName } : {}),
    ...(gameImageUrl ? { gameImageUrl } : {}),
  };
}

// A claimed gamification challenge as a listed reward. Both the tick and the
// manual-watch job report claims through it.
export function challengeRewardData(
  platform: Platform,
  challenge: ClaimedChallenge,
): RewardObtainedData {
  const details: RewardDetail[] = [{ key: "recurrence", value: challenge.recurrence }];
  if (challenge.consolation?.watchTimeMinutes !== undefined)
    details.push({ key: "consolationMinutes", value: challenge.consolation.watchTimeMinutes });
  if (challenge.cardType) details.push({ key: "cardType", value: challenge.cardType });
  return {
    kind: "challenge_card",
    source: { platform },
    rarity: challenge.rarity,
    ...(challenge.cardName ? { name: challenge.cardName } : {}),
    ...(challenge.cardId ? { itemId: challenge.cardId } : {}),
    ...(challenge.imageUrl ? { imageUrl: challenge.imageUrl } : {}),
    details,
  };
}

// The channel a claimed reward was being farmed on, when the platform's watch
// session was on its campaign.
export function claimChannel(session: WatchSession, campaignId: string): string | undefined {
  if (session.campaignId !== campaignId || !session.channel) return undefined;
  return session.channel.displayName ?? session.channel.username;
}

export async function claimReadyRewards(
  adapter: PlatformAdapter,
  campaigns: DropCampaign[],
  previouslyWaitingRewardIds: Set<string>,
  signal?: AbortSignal,
  guard?: RewardClaimGuard,
  // Receives each reward claimed here, still reserved: the caller releases it
  // once its commit has landed, whatever that commit's outcome.
  held?: Set<string>,
): Promise<{ campaigns: DropCampaign[]; events: ClaimReadyRewardEvent[] }> {
  const events: ClaimReadyRewardEvent[] = [];
  const updated: DropCampaign[] = [];
  const stillWaitingRewardIds = new Set<string>();

  for (const campaign of campaigns) {
    const rewards: DropReward[] = [];
    for (const reward of campaign.rewards) {
      signal?.throwIfAborted();
      if (reward.status === "claimable" && canClaimReward(reward)) {
        if (adapter.isClaimReady && !adapter.isClaimReady(reward, campaign)) {
          // Watched to completion, but the platform hasn't released the claim
          // yet (e.g. Twitch hasn't returned the drop-instance id, or the game
          // account is not linked). Defer; the next tick re-checks.
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
        if (guard && !guard.reserve(reward.id)) {
          // Another path is claiming it right now and records its own result.
          rewards.push(reward);
          continue;
        }
        let keepReserved = false;
        try {
          const claimed = await adapter.claimReward(campaign, reward, { signal });
          rewards.push(claimed ? markClaimed(reward) : reward);
          if (claimed && guard && held) {
            held.add(reward.id);
            keepReserved = true;
          }
          if (claimed) {
            events.push({
              level: "info",
              message: `Claimed ${reward.name} from ${campaign.name}`,
              claimed: true,
              ...campaignRewardData(campaign, reward),
            });
          } else if (!reward.claimGuidance) {
            // A refusal that carries guidance was already explained by the
            // platform, once; warning here would repeat it on every tick (#779).
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
        } finally {
          if (!keepReserved) guard?.release(reward.id);
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
