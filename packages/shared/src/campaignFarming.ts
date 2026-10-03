import { campaignPassesCategoryFilter, isCampaignCategoryBlocked } from "./categories";
import type { DropCampaign, DropReward, EngineSettings } from "./models";
import {
  campaignHasSubscriptionRewards,
  canClaimReward,
  isRewardAvailableToEarn,
  isRewardObtained,
  isSubscriptionReward,
  isWatchReward,
  rewardFeasibility,
} from "./rewards";

export type CampaignFarmingRejectionCode =
  | "excluded"
  | "upcoming"
  | "expired"
  | "completed"
  | "unlinked_campaigns_disabled"
  | "twitch_link_required"
  | "subscription_campaigns_disabled"
  | "category_filtered"
  | "category_blocked"
  | "not_pinned"
  | "no_rewards"
  | "no_unclaimed_rewards"
  | "reward_prerequisites_unmet"
  | "reward_not_started"
  | "reward_window_ended"
  | "insufficient_time"
  | "subscription_required"
  | "action_required"
  | "no_farmable_reward";

export type CampaignFarmingEvaluation =
  | { farmable: true }
  | {
      farmable: false;
      code: CampaignFarmingRejectionCode;
      rewardId?: string;
      rewardName?: string;
      deadline?: string;
      remainingMinutes?: number;
      availableMinutes?: number;
      marginMinutes?: number;
    };

export interface CampaignFarmingEvaluationOptions {
  // Whether to apply the "farm pinned only" switch. The scheduler always does;
  // the popup asks for it so a skipped campaign can explain itself.
  includePinnedOnly?: boolean;
  now?: number;
}

type Rejection = Extract<CampaignFarmingEvaluation, { farmable: false }>;

function rejected(code: CampaignFarmingRejectionCode): Rejection {
  return { farmable: false, code };
}

function rewardRejected(code: CampaignFarmingRejectionCode, reward: DropReward): Rejection {
  return { farmable: false, code, rewardId: reward.id, rewardName: reward.name };
}

function parsedTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

export function evaluateCampaignFarming(
  campaign: DropCampaign,
  settings: EngineSettings,
  options: CampaignFarmingEvaluationOptions = {},
): CampaignFarmingEvaluation {
  const now = options.now ?? Date.now();
  if (settings.excludedCampaignIds.includes(campaign.id)) return rejected("excluded");
  if (campaign.status === "upcoming" || campaign.eligibility === "upcoming") return rejected("upcoming");
  if (campaign.status === "expired" || campaign.eligibility === "expired") return rejected("expired");
  const campaignEndsAt = parsedTime(campaign.endsAt);
  if (campaignEndsAt !== undefined && campaignEndsAt < now) return rejected("expired");
  if (campaign.status === "completed" || campaign.eligibility === "completed") return rejected("completed");
  const accountUnlinked = campaign.accountLinked === false || campaign.eligibility === "account_not_linked";
  if (accountUnlinked && !settings.farmingEligibility.farmUnlinkedCampaigns) {
    return rejected("unlinked_campaigns_disabled");
  }
  if (campaignHasSubscriptionRewards(campaign) && !settings.farmingEligibility.farmSubscriptionCampaigns) {
    return rejected("subscription_campaigns_disabled");
  }
  if (isCampaignCategoryBlocked(campaign, settings.platform[campaign.platform])) {
    return rejected("category_blocked");
  }
  if (!campaignPassesCategoryFilter(campaign, settings.platform[campaign.platform])) {
    return rejected("category_filtered");
  }
  if (options.includePinnedOnly && settings.farmPinnedOnly && !settings.campaignPins.includes(campaign.id)) {
    return rejected("not_pinned");
  }
  if (campaign.rewards.length === 0 || campaign.eligibility === "no_rewards") return rejected("no_rewards");
  const unclaimed = campaign.rewards.filter((reward) => !isRewardObtained(reward));
  if (unclaimed.length === 0) return rejected("no_unclaimed_rewards");

  const blockers: Rejection[] = [];
  for (const reward of unclaimed) {
    if (reward.preconditionsMet === false) {
      blockers.push(rewardRejected("reward_prerequisites_unmet", reward));
      continue;
    }
    const startsAt = parsedTime(reward.availableFrom);
    if (startsAt !== undefined && now < startsAt) {
      blockers.push(rewardRejected("reward_not_started", reward));
      continue;
    }
    const endsAt = parsedTime(reward.availableUntil);
    if (endsAt !== undefined && now >= endsAt) {
      blockers.push(rewardRejected("reward_window_ended", reward));
      continue;
    }
    if (canClaimReward(reward, now)) return { farmable: true };
    if (isWatchReward(reward) && isRewardAvailableToEarn(reward, now)) {
      const feasibility = rewardFeasibility(
        campaign,
        reward,
        settings.skipUnfinishableRewards,
        settings.deadlineSafetyMarginMinutes,
        now,
      );
      if (feasibility.kind !== "insufficient_time") return { farmable: true };
      blockers.push({
        ...rewardRejected("insufficient_time", reward),
        deadline: feasibility.deadline,
        remainingMinutes: feasibility.remainingMinutes,
        availableMinutes: feasibility.availableMilliseconds / 60_000,
        marginMinutes: feasibility.marginMinutes,
      });
      continue;
    }
    blockers.push(rewardRejected(
      isSubscriptionReward(reward) ? "subscription_required" : "action_required",
      reward,
    ));
  }

  const precedence: CampaignFarmingRejectionCode[] = [
    "reward_prerequisites_unmet",
    "reward_not_started",
    "reward_window_ended",
    "insufficient_time",
    "subscription_required",
    "action_required",
  ];
  return precedence.flatMap((code) => blockers.filter((blocker) => blocker.code === code))[0]
    ?? rejected("no_farmable_reward");
}

export type CampaignFarmingRejection = Rejection;

// Blockers only the user can clear, on the platform or elsewhere: no setting
// in Lurkloot makes these campaigns farmable (#677).
export const OUTSIDE_ACTION_REJECTION_CODES: ReadonlySet<CampaignFarmingRejectionCode> = new Set([
  "twitch_link_required",
  "reward_prerequisites_unmet",
  "subscription_required",
  "action_required",
]);

// Every blocker a user would meet in turn, fixing each one Lurkloot can fix
// (#677): the evaluation, replayed with each settings blocker lifted. It ends
// at a blocker no setting lifts, or once the campaign would be farmable, so a
// "Pin" or "Include" that is not enough on its own can say what comes next.
// The first entry is always evaluateCampaignFarming's answer.
export function campaignFarmingBlockers(
  campaign: DropCampaign,
  settings: EngineSettings,
  options: CampaignFarmingEvaluationOptions = {},
): Rejection[] {
  const blockers: Rejection[] = [];
  let current: EngineSettings | undefined = settings;
  while (current) {
    const evaluation = evaluateCampaignFarming(campaign, current, options);
    if (evaluation.farmable) break;
    blockers.push(evaluation);
    current = withBlockerLifted(campaign, current, evaluation.code);
  }
  return blockers;
}

// The settings with this campaign's blocker lifted, or undefined when no
// setting can lift it. Each case clears a blocker evaluateCampaignFarming
// checks before it, so the replay always moves on.
function withBlockerLifted(
  campaign: DropCampaign,
  settings: EngineSettings,
  code: CampaignFarmingRejectionCode,
): EngineSettings | undefined {
  const withPlatform = (patch: Partial<EngineSettings["platform"][typeof campaign.platform]>): EngineSettings => ({
    ...settings,
    platform: { ...settings.platform, [campaign.platform]: { ...settings.platform[campaign.platform], ...patch } },
  });
  switch (code) {
    case "excluded":
      return { ...settings, excludedCampaignIds: settings.excludedCampaignIds.filter((id) => id !== campaign.id) };
    case "not_pinned":
      return { ...settings, campaignPins: [...settings.campaignPins, campaign.id] };
    case "unlinked_campaigns_disabled":
      return { ...settings, farmingEligibility: { ...settings.farmingEligibility, farmUnlinkedCampaigns: true } };
    case "subscription_campaigns_disabled":
      return { ...settings, farmingEligibility: { ...settings.farmingEligibility, farmSubscriptionCampaigns: true } };
    case "category_blocked":
      return withPlatform({ blockedCategories: [] });
    case "category_filtered":
      return withPlatform({ categoryMode: "all" });
    case "insufficient_time":
      return { ...settings, skipUnfinishableRewards: false };
    default:
      return undefined;
  }
}
