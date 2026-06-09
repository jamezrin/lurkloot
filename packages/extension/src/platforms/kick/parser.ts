import type { ChannelCandidate, DropCampaign, DropReward } from "@stream-autopilot/shared/models";

interface KickCampaignResponse {
  data?: KickCampaign[] | KickCampaignBuckets;
  campaigns?: KickCampaign[];
  active?: KickCampaign[];
  current?: KickCampaign[];
  upcoming?: KickCampaign[];
  expired?: KickCampaign[];
  completed?: KickCampaign[];
}

interface KickCampaignBuckets {
  campaigns?: KickCampaign[];
  active?: KickCampaign[];
  current?: KickCampaign[];
  upcoming?: KickCampaign[];
  expired?: KickCampaign[];
  completed?: KickCampaign[];
}

interface KickCampaign {
  id: string | number;
  name?: string;
  title?: string;
  status?: string;
  starts_at?: string;
  startsAt?: string;
  startAt?: string;
  ends_at?: string;
  endsAt?: string;
  endAt?: string;
  start_date?: string;
  end_date?: string;
  category_id?: string | number;
  game_id?: string | number;
  category?: { id?: string | number; name?: string; slug?: string; image_url?: string };
  // Org/game account-link URL (e.g. https://accounts.krafton.com/auth/kick/...).
  connect_url?: string;
  channels?: Array<{
    slug?: string;
    username?: string;
    user_slug?: string;
    name?: string;
    profile_picture?: string;
    user?: { username?: string; slug?: string; profile_picture?: string };
  }>;
  rewards?: KickReward[];
  drops?: KickReward[];
}

interface KickReward {
  id: string | number;
  name?: string;
  title?: string;
  image_url?: string;
  image?: string;
  required_units?: number;
  required_minutes?: number;
  minutes_required?: number;
  watch_time_required?: number;
  is_claimed?: boolean;
  claimed?: boolean;
}

interface KickProgressResponse {
  data?: KickProgress[] | KickProgressBuckets;
  progress?: KickProgress[];
  campaigns?: KickProgress[];
  active?: KickProgress[];
  current?: KickProgress[];
  completed?: KickProgress[];
}

interface KickProgressBuckets {
  progress?: KickProgress[];
  campaigns?: KickProgress[];
  active?: KickProgress[];
  current?: KickProgress[];
  completed?: KickProgress[];
}

interface KickProgress {
  id?: string | number;
  campaign_id?: string | number;
  drop_campaign_id?: string | number;
  reward_id?: string | number;
  drop_id?: string | number;
  watched_minutes?: number;
  current_minutes?: number;
  progress_minutes?: number;
  progress?: number;
  percentage?: number;
  status?: string;
  claimed?: boolean;
  is_claimed?: boolean;
  claim_id?: string;
  required_units?: number;
  rewards?: KickProgressReward[];
  progress_units?: number;
  user_app_connected?: boolean;
  connect_url?: string;
  category?: { id?: string | number; name?: string; slug?: string; image_url?: string };
}

interface KickProgressReward {
  id?: string | number;
  reward_id?: string | number;
  drop_id?: string | number;
  progress?: number;
  progress_units?: number;
  required_units?: number;
  claimed?: boolean;
  is_claimed?: boolean;
  status?: string;
  claim_id?: string;
}

export function parseKickCampaigns(input: KickCampaignResponse | KickCampaign[]): DropCampaign[] {
  const campaigns = collectKickCampaigns(input);

  return campaigns.map((campaign): DropCampaign => {
    const startsAt = campaign.starts_at ?? campaign.startsAt ?? campaign.startAt ?? campaign.start_date;
    const endsAt = campaign.ends_at ?? campaign.endsAt ?? campaign.endAt ?? campaign.end_date;
    const rewards = campaign.rewards ?? campaign.drops ?? [];
    const categoryId = campaign.category_id ?? campaign.game_id ?? campaign.category?.id;
    const status = parseCampaignStatus(
      campaign.status,
      startsAt,
      endsAt,
      rewards.length > 0 && rewards.every((reward) => reward.claimed || reward.is_claimed),
    );
    const allowedChannels = campaign.channels
      ?.map((channel) => channel.slug ?? channel.username ?? channel.user_slug ?? channel.user?.slug ?? channel.user?.username ?? channel.name)
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());

    return {
      id: String(campaign.id),
      platform: "kick",
      name: campaign.name ?? campaign.title ?? `Kick campaign ${campaign.id}`,
      slug: campaign.category?.slug,
      gameName: campaign.category?.name,
      gameImageUrl: campaign.category?.image_url,
      categoryId: categoryId == null ? undefined : String(categoryId),
      startsAt,
      endsAt,
      status,
      accountLinked: true,
      accountLinkUrl: campaign.connect_url,
      eligibility: status === "active" && rewards.length > 0 ? "eligible" : status === "completed" ? "completed" : rewards.length === 0 ? "no_rewards" : status === "active" ? "eligible" : status,
      eligibilityReason: status === "active" && rewards.length > 0 ? "Eligible" : status === "completed" ? "All rewards are claimed" : rewards.length === 0 ? "Campaign has no rewards" : `Campaign is ${status}`,
      allowedChannels,
      connectionUrls: allowedChannels?.map((username) => `https://kick.com/${username}`) ?? [],
      isGeneralDrop: !allowedChannels?.length,
      rewards: rewards.map(parseKickReward),
    };
  }).filter((campaign) => campaign.status !== "expired" && campaign.status !== "completed");
}

// Kick's drops API returns reward images as relative paths
// (e.g. "drops/reward-image/<id>.png") served from ext.kick.com — see the org
// `logo_url` full URL in the same response. Resolve them to absolute URLs so the
// popup's <img> doesn't 404 against the extension origin and fall back to the
// gradient+initials placeholder.
const KICK_ASSET_BASE = "https://ext.kick.com";

export function kickRewardImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${KICK_ASSET_BASE}/${value.replace(/^\/+/, "")}`;
}

function parseKickReward(reward: KickReward): DropReward {
  return {
    id: String(reward.id),
    name: reward.name ?? reward.title ?? `Reward ${reward.id}`,
    imageUrl: kickRewardImageUrl(reward.image_url ?? reward.image),
    requiredMinutes:
      reward.required_units ?? reward.required_minutes ?? reward.minutes_required ?? reward.watch_time_required ?? 0,
    watchedMinutes: 0,
    status: reward.claimed || reward.is_claimed ? "claimed" : "locked",
  };
}

export function mergeKickProgress(campaigns: DropCampaign[], input: KickProgressResponse | KickProgress[]): DropCampaign[] {
  const progressItems = collectKickProgress(input);

  return campaigns.map((campaign) => {
    const campaignProgress = progressItems.find((item) => String(item.id ?? item.campaign_id ?? item.drop_campaign_id) === campaign.id);
    // Kick's live drops API returns a single cumulative watch counter per
    // campaign (`progress_units`, in minutes); tiered rewards share it, so each
    // reward's watched minutes is the cumulative capped at its requirement. This
    // is the reliable signal — the per-reward `progress` is only a 0..1 fraction.
    // (Confirmed against the live /api/v1/drops/progress response.)
    const campaignUnits = typeof campaignProgress?.progress_units === "number" ? campaignProgress.progress_units : undefined;
    const rewards = campaign.rewards.map((reward) => {
      const flatProgress = progressItems.find((item) => {
        const campaignId = item.campaign_id ?? item.drop_campaign_id;
        const rewardId = item.reward_id ?? item.drop_id;
        return String(campaignId) === campaign.id && String(rewardId) === reward.id;
      });
      const nestedProgress = campaignProgress?.rewards?.find((item) => {
        const rewardId = item.id ?? item.reward_id ?? item.drop_id;
        return String(rewardId) === reward.id;
      });
      const progress = nestedProgress ?? flatProgress;
      if (!progress && campaignUnits == null) return reward;

      const watchedMinutes = campaignUnits != null
        ? Math.min(campaignUnits, reward.requiredMinutes)
        : progressMinutes(progress!, reward);
      const rawStatus = progress?.status?.toLowerCase();
      const status = progress?.claimed || progress?.is_claimed
        ? "claimed"
        : rawStatus === "claimable" || watchedMinutes >= reward.requiredMinutes
          ? "claimable"
          : watchedMinutes > 0
            ? "in_progress"
            : reward.status;

      return {
        ...reward,
        watchedMinutes,
        status,
        claimId: progress?.claim_id ?? reward.claimId,
      };
    });
    const status = rewards.every((reward) => reward.status === "claimed")
      ? "completed"
      : campaignProgress?.status === "claimed"
        ? "completed"
        : campaign.status;

    return {
      ...campaign,
      status,
      // `user_app_connected` is Kick's account-link flag (the org connection).
      // Only an explicit false gates the campaign; absent means leave as-is.
      accountLinked: campaignProgress?.user_app_connected === false ? false : campaign.accountLinked,
      accountLinkUrl: campaignProgress?.connect_url ?? campaign.accountLinkUrl,
      gameName: campaignProgress?.category?.name ?? campaign.gameName,
      gameImageUrl: campaignProgress?.category?.image_url ?? campaign.gameImageUrl,
      categoryId: campaignProgress?.category?.id == null ? campaign.categoryId : String(campaignProgress.category.id),
      rewards,
    };
  });
}

export function kickCandidatesFromCampaign(campaign: DropCampaign): ChannelCandidate[] {
  return (campaign.allowedChannels ?? []).map((username) => ({
    platform: "kick",
    username,
    displayName: username,
    url: `https://kick.com/${username}`,
    campaignId: campaign.id,
    categoryId: campaign.categoryId,
    categoryName: campaign.gameName,
    isAclMatch: true,
  }));
}

function progressMinutes(progress: KickProgress | KickProgressReward, reward: DropReward): number {
  if ("watched_minutes" in progress || "current_minutes" in progress || "progress_minutes" in progress) {
    return progress.watched_minutes ?? progress.current_minutes ?? progress.progress_minutes ?? reward.watchedMinutes;
  }
  if (progress.progress_units != null) return progress.progress_units;
  if ("percentage" in progress && progress.percentage != null) {
    return Math.round((progress.percentage / 100) * reward.requiredMinutes);
  }
  if (progress.progress != null) {
    const required = progress.required_units ?? reward.requiredMinutes;
    const multiplier = progress.progress > 1 ? progress.progress / 100 : progress.progress;
    return Math.round(multiplier * required);
  }
  return reward.watchedMinutes;
}

function collectKickCampaigns(input: KickCampaignResponse | KickCampaign[]): KickCampaign[] {
  if (Array.isArray(input)) return input;
  const data = input.data;
  if (Array.isArray(data)) return data;
  return [
    ...(input.campaigns ?? []),
    ...(input.active ?? []),
    ...(input.current ?? []),
    ...(input.upcoming ?? []),
    ...(data?.campaigns ?? []),
    ...(data?.active ?? []),
    ...(data?.current ?? []),
    ...(data?.upcoming ?? []),
  ];
}

function collectKickProgress(input: KickProgressResponse | KickProgress[]): KickProgress[] {
  if (Array.isArray(input)) return input;
  const data = input.data;
  if (Array.isArray(data)) return data;
  return [
    ...(input.progress ?? []),
    ...(input.campaigns ?? []),
    ...(input.active ?? []),
    ...(input.current ?? []),
    ...(input.completed ?? []),
    ...(data?.progress ?? []),
    ...(data?.campaigns ?? []),
    ...(data?.active ?? []),
    ...(data?.current ?? []),
    ...(data?.completed ?? []),
  ];
}

function parseCampaignStatus(
  rawStatus: string | undefined,
  startsAt: string | undefined,
  endsAt: string | undefined,
  completed: boolean,
): DropCampaign["status"] {
  if (completed) return "completed";
  const normalized = rawStatus?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const now = Date.now();
  const startsAtTime = parseTimestamp(startsAt);
  const endsAtTime = parseTimestamp(endsAt);
  if (startsAtTime != null && startsAtTime > now) return "upcoming";
  if (endsAtTime != null && endsAtTime < now) return "expired";
  if (normalized === "active" || normalized === "in_progress" || normalized === "current") return "active";
  if (normalized === "upcoming" || normalized === "scheduled") return "upcoming";
  if (normalized === "expired" || normalized === "ended" || normalized === "inactive" || normalized === "finished") {
    return "expired";
  }
  if (normalized === "completed" || normalized === "complete" || normalized === "claimed") return "completed";
  return "active";
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}
