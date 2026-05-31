import type { ChannelCandidate, DropCampaign, DropReward } from "../core/models";

interface TwitchInventory {
  data?: {
    currentUser?: {
      id?: string;
      inventory?: {
        dropCampaignsInProgress?: TwitchCampaign[];
        dropCampaigns?: TwitchCampaign[];
        gameEventDrops?: TwitchGameEventDrop[];
      };
      dropCampaigns?: TwitchCampaign[];
    };
  };
}

interface TwitchCampaign {
  id: string;
  name?: string;
  game?: { name?: string; displayName?: string; id?: string; slug?: string; boxArtURL?: string };
  imageURL?: string;
  startAt?: string;
  endAt?: string;
  status?: string;
  self?: { isAccountConnected?: boolean };
  accountLinkURL?: string | null;
  allow?: { channels?: Array<{ name?: string; login?: string }> };
  allowedChannels?: Array<{ name?: string; login?: string } | string>;
  timeBasedDrops?: TwitchReward[];
}

interface TwitchReward {
  id: string;
  name?: string;
  startAt?: string;
  endAt?: string;
  requiredMinutesWatched?: number;
  requiredSubs?: number;
  benefitEdges?: Array<{
    benefit?: {
      id?: string;
      name?: string;
      imageAssetURL?: string;
      distributionType?: string;
    };
  }>;
  self?: {
    currentMinutesWatched?: number;
    isClaimed?: boolean;
    dropInstanceID?: string;
  };
  preconditionDrops?: Array<{ id: string }>;
}

interface TwitchGameEventDrop {
  id?: string;
  benefit?: { id?: string };
  lastAwardedAt?: string;
}

export function parseTwitchInventory(input: TwitchInventory | TwitchCampaign[]): DropCampaign[] {
  const campaigns = Array.isArray(input)
    ? input
    : input.data?.currentUser?.inventory?.dropCampaignsInProgress
      ?? input.data?.currentUser?.inventory?.dropCampaigns
      ?? input.data?.currentUser?.dropCampaigns
      ?? [];
  const gameEventDrops = Array.isArray(input) ? [] : input.data?.currentUser?.inventory?.gameEventDrops ?? [];
  const userId = Array.isArray(input) ? undefined : input.data?.currentUser?.id;
  const now = Date.now();

  return campaigns.map((campaign) => {
    const allowedChannels = [
      ...(campaign.allow?.channels ?? []),
      ...(campaign.allowedChannels ?? []),
    ]
      .map((channel) => (typeof channel === "string" ? channel : channel.login ?? channel.name))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());
    const slug = campaign.game?.slug;
    const startsAt = campaign.startAt;
    const endsAt = campaign.endAt;
    const accountLinked = campaign.self?.isAccountConnected ?? campaign.accountLinkURL == null;
    const rawStatus = campaign.status?.toLowerCase();
    const status = startsAt && Date.parse(startsAt) > now
      ? "upcoming"
      : endsAt && Date.parse(endsAt) < now
        ? "expired"
        : rawStatus === "upcoming"
          ? "upcoming"
          : rawStatus === "expired"
          ? "expired"
          : "active";
    const parsedRewards = (campaign.timeBasedDrops ?? []).map((drop) =>
      parseTwitchReward(drop, campaign.id, userId, endsAt, gameEventDrops),
    );
    const rewards = parsedRewards.map((reward) => ({
      ...reward,
      preconditionsMet: (reward.preconditionRewardIds ?? []).every((id) =>
        parsedRewards.some((candidate) => candidate.id === id && candidate.status === "claimed"),
      ),
    }));

    const finalStatus = rewards.length > 0 && rewards.every((reward) => reward.status === "claimed") ? "completed" : status;

    return {
      id: campaign.id,
      platform: "twitch",
      name: campaign.name ?? `Twitch campaign ${campaign.id}`,
      slug,
      gameName: campaign.game?.displayName ?? campaign.game?.name,
      gameImageUrl: campaign.game?.boxArtURL ?? campaign.imageURL,
      categoryId: campaign.game?.id,
      startsAt,
      endsAt,
      accountLinked,
      accountLinkUrl: campaign.accountLinkURL ?? undefined,
      status: finalStatus,
      eligibility: eligibility(finalStatus, accountLinked, rewards.length),
      eligibilityReason: eligibilityReason(finalStatus, accountLinked, rewards.length),
      allowedChannels,
      connectionUrls: allowedChannels.length > 0
        ? allowedChannels.map((login) => `https://www.twitch.tv/${login}`)
        : slug
          ? [`https://www.twitch.tv/directory/category/${slug}?filter=drops&sort=VIEWER_COUNT`]
          : [],
      isGeneralDrop: allowedChannels.length === 0,
      rewards,
    };
  });
}

function parseTwitchReward(
  reward: TwitchReward,
  campaignId: string,
  userId?: string,
  campaignEndsAt?: string,
  gameEventDrops: TwitchGameEventDrop[] = [],
): DropReward {
  const watchedMinutes = reward.self?.currentMinutesWatched ?? 0;
  const requiredMinutes = reward.requiredMinutesWatched ?? 0;
  const benefits = (reward.benefitEdges ?? [])
    .map((edge) => edge.benefit)
    .filter((benefit): benefit is NonNullable<typeof benefit> => Boolean(benefit));
  const eventClaimed = benefits.some((benefit) =>
    gameEventDrops.some((drop) => drop.id === reward.self?.dropInstanceID || drop.benefit?.id === benefit.id),
  );
  const isClaimed = reward.self?.isClaimed || eventClaimed;
  const claimId = reward.self?.dropInstanceID ?? (userId ? `${userId}#${campaignId}#${reward.id}` : undefined);
  const preconditionRewardIds = reward.preconditionDrops?.map((drop) => drop.id) ?? [];

  return {
    id: reward.id,
    name: benefits[0]?.name ?? reward.name ?? `Reward ${reward.id}`,
    imageUrl: benefits[0]?.imageAssetURL,
    benefitIds: benefits.map((benefit) => benefit.id).filter((id): id is string => Boolean(id)),
    benefitType: benefits[0]?.distributionType,
    requiredMinutes,
    requiredSubs: reward.requiredSubs,
    watchedMinutes: isClaimed ? requiredMinutes : watchedMinutes,
    claimId,
    availableFrom: reward.startAt,
    availableUntil: reward.endAt,
    claimUntil: campaignEndsAt ? addHours(campaignEndsAt, 24) : undefined,
    preconditionRewardIds,
    preconditionsMet: preconditionRewardIds.length === 0,
    status: isClaimed
      ? "claimed"
      : watchedMinutes >= requiredMinutes && requiredMinutes > 0
        ? "claimable"
        : watchedMinutes > 0
          ? "in_progress"
          : "locked",
  };
}

export function twitchCandidatesFromCampaign(campaign: DropCampaign): ChannelCandidate[] {
  const aclCandidates = (campaign.allowedChannels ?? []).map((username): ChannelCandidate => ({
    platform: "twitch",
    username,
    displayName: username,
    url: `https://www.twitch.tv/${username}`,
    campaignId: campaign.id,
    categoryId: campaign.categoryId,
    categoryName: campaign.gameName,
    isAclMatch: true,
  }));
  return aclCandidates;
}

export function mergeTwitchCampaignProgress(
  campaigns: DropCampaign[],
  inventory: TwitchInventory | TwitchCampaign[],
): DropCampaign[] {
  const progressCampaigns = parseTwitchInventory(inventory);
  return campaigns.map((campaign) => {
    const progress = progressCampaigns.find((item) => item.id === campaign.id);
    if (!progress) return campaign;
    return {
      ...campaign,
      status: progress.status,
      rewards: campaign.rewards.map((reward) => {
        const progressReward = progress.rewards.find((item) => item.id === reward.id);
        return progressReward ? { ...reward, ...progressReward } : reward;
      }),
    };
  });
}

function addHours(value: string, hours: number): string | undefined {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time + hours * 60 * 60 * 1000).toISOString();
}

function eligibility(
  status: DropCampaign["status"],
  accountLinked: boolean,
  rewardCount: number,
): DropCampaign["eligibility"] {
  if (!accountLinked) return "account_not_linked";
  if (status === "upcoming") return "upcoming";
  if (status === "expired") return "expired";
  if (status === "completed") return "completed";
  if (rewardCount === 0) return "no_rewards";
  return "eligible";
}

function eligibilityReason(status: DropCampaign["status"], accountLinked: boolean, rewardCount: number): string {
  if (!accountLinked) return "Account is not linked for this campaign";
  if (status === "upcoming") return "Campaign has not started";
  if (status === "expired") return "Campaign has ended";
  if (status === "completed") return "All rewards are claimed";
  if (rewardCount === 0) return "Campaign has no time-based rewards";
  return "Eligible";
}
