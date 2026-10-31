import type {
  CampaignCategory,
  CampaignLaneChoice,
  DropCampaign,
  DropReward,
  RewardBenefit,
  RewardRequirementType,
} from "@lurkloot/shared/models";
import { withCampaignStatus } from "./parser";

// Twitch reward campaigns (#904): sitewide campaigns, such as the Pokémon badge
// events, that Twitch's drops page lists apart from drop campaigns, in the
// dashboard's rewardCampaignsAvailableToUser. They have no game. Each reward
// group earns by watching any channel in one of its categories, often once per
// window over several days, and some groups are lanes of a track the user picks
// between.
//
// The queries below copy the selections of Twitch's own web client: the drops
// tray's channelDropCampaignsProgress, which is the only place the per-user
// `self` progress is known to come from, and the Pokémon page's dropsCampaign
// and trackSelections. dropsCampaign is read for structure only and never for
// progress.

export interface TwitchRewardCampaignListing {
  id?: string;
  name?: string;
  brand?: string;
  startsAt?: string;
  endsAt?: string;
  isSitewide?: boolean;
  game?: unknown;
  unlockRequirements?: { minuteWatchedGoal?: number; subsGoal?: number } | null;
}

interface TwitchRewardItem {
  id?: string;
  name?: string;
  thumbnailURL?: string;
  distributionType?: string;
  dropDetail?: { badge?: { id?: string } | null } | null;
  pool?: {
    rewards?: Array<{
      id?: string;
      name?: string;
      thumbnailURL?: string;
      dropDetail?: { badge?: { id?: string } | null } | null;
    }>;
  } | null;
}

export interface TwitchRewardGroupSelf {
  status?: string;
  currentMinutesWatched?: number;
  currentSubs?: number;
  grantCount?: number;
  nextEligibleAt?: string | null;
  currentWindow?: { startedAt?: string; expiresAt?: string } | null;
}

export interface TwitchRewardGroup {
  id?: string;
  name?: string;
  track?: string | null;
  lane?: string | null;
  progressCriteria?: {
    requirementType?: string;
    requirements?: { minutesWatched?: number | null; subs?: number | null } | null;
    repeatableConfig?: {
      repeatableTimes?: number;
      resetIntervalSeconds?: number;
      shouldCompleteAllRepeatsToEarn?: boolean;
    } | null;
    channels?: Array<{ id?: string }> | null;
    categories?: Array<{ id?: string; displayName?: string }> | null;
  } | null;
  rewards?: TwitchRewardItem[] | null;
  self?: TwitchRewardGroupSelf | null;
}

export interface TwitchDropsCampaign {
  id?: string;
  name?: string;
  status?: string;
  brandName?: string;
  owner?: { name?: string } | null;
  detailsURL?: string;
  imageURL?: string;
  startAt?: string;
  endAt?: string;
  rewardGroups?: TwitchRewardGroup[] | null;
}

const REWARD_GROUP_STRUCTURE = `
      id
      name
      track
      lane
      progressCriteria {
        requirementType
        requirements { minutesWatched subs }
        repeatableConfig { repeatableTimes resetIntervalSeconds shouldCompleteAllRepeatsToEarn }
        channels { id }
        categories { id displayName }
      }
      rewards {
        id
        name
        thumbnailURL
        distributionType
        pool { rewards { id name thumbnailURL dropDetail { badge { id } } } }
      }`;

// The reward campaigns the dashboard lists (ViewerDropsDashboard with
// fetchRewardCampaigns). Sent on its own, inline, so the dashboard's persisted
// query, which the CLI's integrity check also replays, stays as it is.
export const TWITCH_REWARD_CAMPAIGNS_QUERY = `query RewardCampaignsAvailable {
  rewardCampaignsAvailableToUser {
    id
    name
    brand
    startsAt
    endsAt
    isSitewide
    unlockRequirements { minuteWatchedGoal subsGoal }
  }
}`;

// The structure of one reward campaign, by id. Sent inline: the web client
// only has it as a fragment of a Pokémon-specific operation.
export const TWITCH_DROPS_CAMPAIGN_QUERY = `query RewardCampaignDetails($id: ID!) {
  dropsCampaign(id: $id) {
    id
    name
    status
    brandName
    owner { name }
    detailsURL
    imageURL
    startAt
    endAt
    rewardGroups {${REWARD_GROUP_STRUCTURE}
    }
  }
}`;

// The drops tray's query: every campaign running on the channel, with the
// signed-in user's progress on each reward group.
export const TWITCH_CHANNEL_CAMPAIGN_PROGRESS_QUERY = `query RewardCampaignProgress($channelID: ID!) {
  channelDropCampaignsProgress(channelID: $channelID) {
    id
    rewardGroups {
      id
      self {
        status
        currentMinutesWatched
        currentSubs
        grantCount
        nextEligibleAt
        currentWindow { startedAt expiresAt }
      }
    }
  }
}`;

export const TWITCH_TRACK_SELECTIONS_QUERY = `query RewardTrackSelections($tracks: [ID!]!) {
  trackSelections(tracks: $tracks) { id track lane }
}`;

export const TWITCH_SET_TRACK_SELECTION_MUTATION = `mutation SetRewardTrackSelection($input: SetTrackSelectionInput!) {
  setTrackSelection(input: $input) { error }
}`;

export interface TwitchChannelCampaignProgress {
  id?: string;
  rewardGroups?: Array<{ id?: string; self?: TwitchRewardGroupSelf | null }> | null;
}

// Claim statuses Twitch's drops tray treats as success for a reward group.
export function isTwitchRewardGroupClaimAccepted(status: string | null | undefined): boolean {
  return (
    status === undefined
    || status === null
    || status === "ELIGIBLE_FOR_ALL"
    || status === "LIMITED"
    || status === "DROP_INSTANCE_ALREADY_CLAIMED"
  );
}

// The listing entries LurkLoot can farm: sitewide campaigns earned by watching.
// Subscription-only ones (a month of a streaming service for a sub) stay out,
// as subscription drops without watch time do.
export function farmableRewardCampaignIds(
  listings: readonly TwitchRewardCampaignListing[],
): string[] {
  return listings
    .filter(
      (listing) =>
        listing.id
        && listing.isSitewide !== false
        && (listing.unlockRequirements?.minuteWatchedGoal ?? 0) > 0,
    )
    .map((listing) => listing.id as string);
}

// The campaigns a tray response lists. A listed campaign is answered for, even
// where some of its groups carry no progress (an unequipped lane).
export function listedCampaignIds(
  campaigns: readonly (TwitchChannelCampaignProgress | null | undefined)[],
): Set<string> {
  return new Set(
    campaigns.map((campaign) => campaign?.id).filter((id): id is string => Boolean(id)),
  );
}

// Progress per reward group id, from any number of tray responses.
export function rewardGroupProgress(
  campaigns: readonly (TwitchChannelCampaignProgress | null | undefined)[],
): Map<string, TwitchRewardGroupSelf> {
  const progress = new Map<string, TwitchRewardGroupSelf>();
  for (const campaign of campaigns) {
    for (const group of campaign?.rewardGroups ?? []) {
      if (group?.id && group.self) progress.set(group.id, group.self);
    }
  }
  return progress;
}

export function rewardCampaignCategories(campaign: TwitchDropsCampaign): CampaignCategory[] {
  const categories = new Map<string, CampaignCategory>();
  for (const group of campaign.rewardGroups ?? []) {
    for (const category of group.progressCriteria?.categories ?? []) {
      if (category?.id && !categories.has(category.id))
        categories.set(category.id, { id: category.id, name: category.displayName ?? category.id });
    }
  }
  return [...categories.values()];
}

export function rewardCampaignTracks(campaign: TwitchDropsCampaign): string[] {
  return [...laneTracks(campaign).keys()];
}

function isBadgeItem(item: { dropDetail?: { badge?: unknown } | null }): boolean {
  return Boolean(item.dropDetail?.badge);
}

function rewardBenefits(group: TwitchRewardGroup): RewardBenefit[] {
  return (group.rewards ?? []).map((item): RewardBenefit => {
    const poolRewards = item.pool?.rewards ?? [];
    // A pool hands out one of its entries, picked by Twitch on the claim. The
    // Pokémon balls only ever hold badges, but nothing says so except the
    // entries' names, so a pool is a badge only when each entry carries badge
    // detail.
    const distributionType =
      item.distributionType === "POOL"
        ? poolRewards.length > 0 && poolRewards.every(isBadgeItem)
          ? "BADGE"
          : "POOL"
        : item.distributionType;
    return {
      ...(item.id ? { id: item.id } : {}),
      ...(item.name ? { name: item.name } : {}),
      ...(item.thumbnailURL ? { imageUrl: item.thumbnailURL } : {}),
      ...(distributionType ? { distributionType } : {}),
    };
  });
}

function parsedTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

// The group statuses Twitch's drops tray knows. Any other is not farmed.
export const KNOWN_REWARD_GROUP_STATUSES: ReadonlySet<string> = new Set([
  "IN_PROGRESS",
  "CLAIMABLE",
  "CLAIMED",
  "FULFILLED",
  "EXPIRED",
]);

export interface RewardGroupState {
  status: DropReward["status"];
  // Twitch reported a status this code does not know; the group is not farmed.
  unknownStatus?: boolean;
  watchedMinutes: number;
  grantCount: number;
  // When the next window opens, while the group cannot earn in this one.
  availableFrom?: string;
}

// What one reward group's progress means now, following the rules of Twitch's
// drops tray: a finished status or every grant in ends it; CLAIMABLE claims
// only once all grants are in when the group pays out at the end; progress
// counts only inside the current window.
export function rewardGroupState(
  group: TwitchRewardGroup,
  self: TwitchRewardGroupSelf,
  now: number,
): RewardGroupState {
  const required = group.progressCriteria?.requirements?.minutesWatched ?? 0;
  const repeat = group.progressCriteria?.repeatableConfig;
  const times = Math.max(repeat?.repeatableTimes ?? 1, 1);
  const completeAll = repeat?.shouldCompleteAllRepeatsToEarn === true && times > 1;
  const grantCount = Math.max(self.grantCount ?? 0, 0);
  const done: RewardGroupState = { status: "claimed", watchedMinutes: required, grantCount };
  if (self.status && !KNOWN_REWARD_GROUP_STATUSES.has(self.status))
    return { status: "locked", watchedMinutes: 0, grantCount, unknownStatus: true };
  if (self.status === "CLAIMED" || self.status === "FULFILLED" || self.status === "EXPIRED")
    return done;
  if (self.status === "CLAIMABLE" && (!completeAll || grantCount >= times))
    return { status: "claimable", watchedMinutes: required, grantCount };
  if (grantCount >= times) return done;

  const windowEnds = parsedTime(self.currentWindow?.expiresAt);
  const windowOpen = windowEnds === undefined || windowEnds > now;
  const watched = windowOpen ? Math.max(self.currentMinutesWatched ?? 0, 0) : 0;
  const nextWindow = parsedTime(self.nextEligibleAt);
  // Waiting for the next window: either Twitch says when it opens, or this
  // window's minutes are already in and nothing more counts until it ends.
  const waitUntil =
    nextWindow !== undefined && nextWindow > now
      ? self.nextEligibleAt
      : required > 0 && watched >= required && windowOpen && windowEnds !== undefined
        ? self.currentWindow?.expiresAt
        : undefined;
  if (waitUntil) {
    return {
      status: "in_progress",
      watchedMinutes: 0,
      grantCount,
      availableFrom: waitUntil ?? undefined,
    };
  }
  return {
    status: watched > 0 ? "in_progress" : "locked",
    watchedMinutes: Math.min(watched, required),
    grantCount,
  };
}

export interface ParseRewardCampaignInput {
  campaign: TwitchDropsCampaign;
  progress: ReadonlyMap<string, TwitchRewardGroupSelf>;
  // The lane equipped on each track; a track missing here has none equipped.
  equippedLanes: ReadonlyMap<string, string>;
  userId?: string;
  now?: number;
}

function requirementOf(group: TwitchRewardGroup): RewardRequirementType {
  const type = group.progressCriteria?.requirementType;
  if (type === "WATCH") return "watch";
  if (type === "SUB") return "subscription";
  return "action";
}

function laneName(groups: readonly TwitchRewardGroup[]): string {
  const names = groups
    .map((group) => group.name?.trim() || group.rewards?.[0]?.name?.trim())
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)].join(" → ");
}

// The tracks whose lanes are a real choice: at least two lanes. A track with
// one lane (Twitch keeps one track, the balls, out of lane handling) gates
// nothing.
function laneTracks(campaign: TwitchDropsCampaign): Map<string, Map<string, TwitchRewardGroup[]>> {
  const tracks = new Map<string, Map<string, TwitchRewardGroup[]>>();
  for (const group of campaign.rewardGroups ?? []) {
    if (!group.track || group.lane == null) continue;
    const lanes = tracks.get(group.track) ?? new Map<string, TwitchRewardGroup[]>();
    lanes.set(group.lane, [...(lanes.get(group.lane) ?? []), group]);
    tracks.set(group.track, lanes);
  }
  for (const [track, lanes] of tracks) if (lanes.size < 2) tracks.delete(track);
  return tracks;
}

function laneChoices(
  campaign: TwitchDropsCampaign,
  equippedLanes: ReadonlyMap<string, string>,
): CampaignLaneChoice[] {
  return [...laneTracks(campaign).entries()].map(([track, lanes]) => ({
    track,
    lanes: [...lanes.entries()].map(([lane, groups]) => ({
      lane,
      name: laneName(groups) || lane,
      ...(groups[0]?.rewards?.[0]?.thumbnailURL
        ? { imageUrl: groups[0].rewards[0].thumbnailURL }
        : {}),
      equipped: equippedLanes.get(track) === lane,
    })),
  }));
}

// A reward campaign as a DropCampaign the engine farms like any other. Each
// reward group is one reward. A group without known progress cannot be farmed:
// without it, a finished group would be watched for ever.
export function parseTwitchRewardCampaign({
  campaign,
  progress,
  equippedLanes,
  userId,
  now = Date.now(),
}: ParseRewardCampaignInput): DropCampaign | undefined {
  if (!campaign.id) return undefined;
  const campaignId = campaign.id;
  const rewards: DropReward[] = [];
  const tracks = laneTracks(campaign);
  for (const group of campaign.rewardGroups ?? []) {
    if (!group.id) continue;
    const benefits = rewardBenefits(group);
    const required = group.progressCriteria?.requirements?.minutesWatched ?? 0;
    const repeatTimes = Math.max(group.progressCriteria?.repeatableConfig?.repeatableTimes ?? 1, 1);
    const self = progress.get(group.id);
    let requirement = requirementOf(group);
    // Watching earns a lane only while it is equipped, and a group limited to
    // channels by id cannot be matched to the channels the engine watches.
    const onLane = Boolean(group.track && group.lane != null && tracks.has(group.track));
    if (onLane && equippedLanes.get(group.track as string) !== group.lane) requirement = "action";
    if (group.progressCriteria?.channels?.length) requirement = "action";
    if (requirement === "watch" && required <= 0) requirement = "action";
    const state: RewardGroupState = self
      ? rewardGroupState(group, self, now)
      : { status: "locked", watchedMinutes: 0, grantCount: 0 };
    // Unknown progress, or a status this code does not know: treated as an
    // action reward, so it is shown but never farmed.
    if ((!self || state.unknownStatus) && requirement === "watch") requirement = "action";
    const isWatchBased = requirement === "watch";
    const claimId = userId ? `${userId}#${campaignId}#${group.id}` : undefined;
    rewards.push({
      id: group.id,
      name: benefits[0]?.name ?? group.name ?? `Reward ${group.id}`,
      ...(benefits[0]?.imageUrl ? { imageUrl: benefits[0].imageUrl } : {}),
      benefitIds: benefits.map((benefit) => benefit.id).filter((id): id is string => Boolean(id)),
      ...(benefits[0]?.distributionType ? { benefitType: benefits[0].distributionType } : {}),
      benefits,
      requiredMinutes: required,
      ...(requirement === "subscription"
        ? { requiredSubs: group.progressCriteria?.requirements?.subs ?? 1 }
        : {}),
      requirement,
      isWatchBased,
      watchedMinutes: state.watchedMinutes,
      status: state.status,
      ...(claimId
        ? {
            claimId,
            // One key per grant: claiming today's grant must not mark
            // tomorrow's claimed (preserveClaimedRewards).
            claimKey: repeatTimes > 1 ? `${claimId}#${state.grantCount}` : claimId,
          }
        : {}),
      ...(state.availableFrom ? { availableFrom: state.availableFrom } : {}),
      ...(campaign.endAt ? { availableUntil: campaign.endAt } : {}),
      ...(campaign.endAt ? { claimUntil: campaign.endAt } : {}),
      preconditionRewardIds: [],
      preconditionsMet: true,
      ...(repeatTimes > 1 ? { repeat: { grantCount: state.grantCount, times: repeatTimes } } : {}),
      ...(onLane ? { lane: { track: group.track as string, lane: group.lane as string } } : {}),
    });
  }

  const startsAt = parsedTime(campaign.startAt);
  const endsAt = parsedTime(campaign.endAt);
  const rawStatus = campaign.status?.toUpperCase();
  const status: DropCampaign["status"] =
    (startsAt !== undefined && startsAt > now) || rawStatus === "UPCOMING"
      ? "upcoming"
      : (endsAt !== undefined && endsAt <= now) || rawStatus === "EXPIRED"
        ? "expired"
        : rewards.length > 0 && rewards.every((reward) => reward.status === "claimed")
          ? "completed"
          : "active";
  const choices = laneChoices(campaign, equippedLanes);
  const brand = campaign.brandName?.trim() || campaign.owner?.name?.trim();
  const parsed = withCampaignStatus(
    {
      id: campaignId,
      platform: "twitch",
      name: campaign.name ?? `Twitch campaign ${campaignId}`,
      ...(brand ? { brand } : {}),
      ...(campaign.imageURL ? { gameImageUrl: campaign.imageURL } : {}),
      categories: rewardCampaignCategories(campaign),
      sitewide: true,
      ...(choices.length > 0 ? { laneChoices: choices } : {}),
      ...(campaign.startAt ? { startsAt: campaign.startAt } : {}),
      ...(campaign.endAt ? { endsAt: campaign.endAt } : {}),
      status,
      accountLinked: true,
      ...(campaign.detailsURL ? { url: campaign.detailsURL } : {}),
      allowedChannels: [],
      connectionUrls: [],
      isGeneralDrop: true,
      rewards,
    },
    status,
  );
  // With no lane equipped every lane reward is an action reward, which alone
  // would read as "no rewards" and hide the card that holds the lane picker.
  // Kept eligible, the campaign is listed under Action required instead.
  const awaitsLane =
    choices.some((choice) => !choice.lanes.some((lane) => lane.equipped))
    && rewards.some((reward) => reward.lane && reward.status !== "claimed");
  return awaitsLane && parsed.eligibility === "no_rewards"
    ? { ...parsed, eligibility: "eligible", eligibilityReason: "Pick a lane to earn" }
    : parsed;
}

// Structure changes rarely; progress moves while the campaign is watched, and
// the farmed campaign's is always read fresh from the watched channel.
export const STRUCTURE_FRESH_MS = 10 * 60_000;
export const PROGRESS_FRESH_MS = 3 * 60_000;
// How long progress no tray has repeated still stands in. Past it the group's
// progress is unknown again, and it is not farmed (parseTwitchRewardCampaign).
const PROGRESS_STALE_MS = 3 * PROGRESS_FRESH_MS;
// Reward campaigns start and end rarely; the listing is not worth a request on
// every tick.
export const LISTING_FRESH_MS = 5 * 60_000;

// What reward-campaign discovery keeps between ticks. The extension rebuilds
// the adapter every tick, so it lives on TwitchDiscoveryState and is replaced
// whole when the signed-in account changes.
export class TwitchRewardCampaignCache {
  private readonly structures = new Map<string, { value: TwitchDropsCampaign; at: number }>();
  private readonly progress = new Map<string, { self: TwitchRewardGroupSelf; at: number }>();
  private retained: DropCampaign[] = [];
  private listing?: { ids: string[]; at: number };
  // When a read was last tried, whatever came of it: a read that keeps failing
  // or answering nothing is tried again only after its freshness window, not
  // on every tick.
  private readonly attempts = new Map<string, number>();
  private readonly slugs = new Map<string, string>();
  private readonly reportedStatuses = new Set<string>();

  attemptedRecently(key: string, windowMs: number, now = Date.now()): boolean {
    const at = this.attempts.get(key);
    return at !== undefined && now - at < windowMs;
  }

  recordAttempt(key: string, now = Date.now()): void {
    this.attempts.set(key, now);
  }

  // Directory slugs by category id. The adapter's own slug cache dies with it
  // every tick; this one lives as long as the discovery state.
  slug(categoryId: string): string | undefined {
    return this.slugs.get(categoryId);
  }

  rememberSlug(categoryId: string, slug: string): void {
    this.slugs.set(categoryId, slug);
  }

  // Whether this unknown group status is new, so it is reported once.
  firstSeenStatus(status: string): boolean {
    if (this.reportedStatuses.has(status)) return false;
    this.reportedStatuses.add(status);
    return true;
  }
  private lanes?: { key: string; equipped: Map<string, string>; at: number };

  // The lanes equipped on these tracks, while the last read of them is fresh.
  freshLanes(tracks: readonly string[], now = Date.now()): Map<string, string> | undefined {
    const key = [...tracks].sort().join("|");
    return this.lanes && this.lanes.key === key && now - this.lanes.at < LISTING_FRESH_MS
      ? this.lanes.equipped
      : undefined;
  }

  rememberLanes(tracks: readonly string[], equipped: Map<string, string>, now = Date.now()): void {
    this.lanes = { key: [...tracks].sort().join("|"), equipped, at: now };
  }

  // After the user equips a lane, the next refresh reads the lanes again.
  forgetLanes(): void {
    this.lanes = undefined;
  }

  // The farmable campaign ids the last listing returned, while still fresh.
  freshListing(now = Date.now()): string[] | undefined {
    return this.listing && now - this.listing.at < LISTING_FRESH_MS ? this.listing.ids : undefined;
  }

  rememberListing(ids: string[], now = Date.now()): void {
    this.listing = { ids, at: now };
  }

  freshStructure(id: string, now = Date.now()): TwitchDropsCampaign | undefined {
    const entry = this.structures.get(id);
    return entry && now - entry.at < STRUCTURE_FRESH_MS ? entry.value : undefined;
  }

  // The last structure read for the campaign, however old: used when a refresh
  // of it fails, rather than losing the campaign.
  lastStructure(id: string): TwitchDropsCampaign | undefined {
    return this.structures.get(id)?.value;
  }

  rememberStructure(id: string, value: TwitchDropsCampaign, now = Date.now()): void {
    this.structures.set(id, { value, at: now });
  }

  rememberProgress(progress: ReadonlyMap<string, TwitchRewardGroupSelf>, now = Date.now()): void {
    for (const [groupId, self] of progress) this.progress.set(groupId, { self, at: now });
  }

  // Progress for these groups if every one of them was read recently.
  freshProgress(
    groupIds: readonly string[],
    now = Date.now(),
  ): Map<string, TwitchRewardGroupSelf> | undefined {
    const result = new Map<string, TwitchRewardGroupSelf>();
    for (const id of groupIds) {
      const entry = this.progress.get(id);
      if (!entry || now - entry.at >= PROGRESS_FRESH_MS) return undefined;
      result.set(id, entry.self);
    }
    return result;
  }

  // Progress known for these groups that is not yet stale (PROGRESS_STALE_MS).
  knownProgress(groupIds: readonly string[], now = Date.now()): Map<string, TwitchRewardGroupSelf> {
    const result = new Map<string, TwitchRewardGroupSelf>();
    for (const id of groupIds) {
      const entry = this.progress.get(id);
      if (entry && now - entry.at < PROGRESS_STALE_MS) result.set(id, entry.self);
    }
    return result;
  }

  retain(campaigns: DropCampaign[]): void {
    this.retained = campaigns;
  }

  retainedCampaigns(): DropCampaign[] {
    return this.retained;
  }
}
