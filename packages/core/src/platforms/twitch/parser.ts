import type { ChannelCandidate, DropCampaign, DropReward } from "@lurkloot/shared/models";
import { isWaitingSubscriptionReward, isWatchReward } from "@lurkloot/shared/rewards";

interface TwitchInventory {
  data?: {
    currentUser?: {
      id?: string;
      inventory?: {
        dropCampaignsInProgress?: TwitchCampaign[];
        dropCampaigns?: TwitchCampaign[];
        gameEventDrops?: TwitchGameEventDrop[];
        // twitch-inventory-v2 only; absent on v1 responses.
        earnedDropRewards?: { edges?: Array<{ node?: TwitchEarnedDropReward }> };
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
  detailsURL?: string | null;
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
  name?: string;
  benefit?: { id?: string };
  lastAwardedAt?: string;
}

// One edge per claim, campaign-scoped, keyed by benefit (item) id rather than by
// drop id. Counting edges is therefore the only way to learn how many tiers of a
// shared benefit were claimed — gameEventDrops deduplicates them away.
export interface TwitchEarnedDropReward {
  id?: string;
  item?: { id?: string };
  campaign?: { id?: string };
  status?: string;
  earnedAt?: string;
}

// claimedCount[campaignId][benefitId] = number of claimed rewards of that benefit.
export type EarnedRewardCounts = ReadonlyMap<string, ReadonlyMap<string, number>>;

export function earnedRewardCounts(
  edges: ReadonlyArray<{ node?: TwitchEarnedDropReward } | TwitchEarnedDropReward>,
): EarnedRewardCounts {
  const counts = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    const node = ("node" in edge ? edge.node : edge) as TwitchEarnedDropReward | undefined;
    if (node?.status !== "CLAIMED") continue;
    const campaignId = node.campaign?.id;
    const benefitId = node.item?.id ?? node.id;
    if (!campaignId || !benefitId) continue;
    const byBenefit = counts.get(campaignId) ?? new Map<string, number>();
    byBenefit.set(benefitId, (byBenefit.get(benefitId) ?? 0) + 1);
    counts.set(campaignId, byBenefit);
  }
  return counts;
}

// Resolves which reward ids a campaign's earned counts account for. A benefit
// claimed N times covers the N cheapest tiers that award it: Twitch releases a
// tier's claim only once its watch requirement is met, so claims accrue in
// ascending requiredMinutesWatched order.
function rewardIdsClaimedByEarnedCounts(
  rewards: ReadonlyArray<{ id: string; requiredMinutes: number; benefitIds?: readonly (string | undefined)[] }>,
  countsForCampaign: ReadonlyMap<string, number> | undefined,
): ReadonlySet<string> {
  const claimed = new Set<string>();
  if (!countsForCampaign || countsForCampaign.size === 0) return claimed;
  const byBenefit = new Map<string, Array<{ id: string; requiredMinutes: number }>>();
  for (const reward of rewards) {
    for (const benefitId of new Set(reward.benefitIds ?? [])) {
      if (!benefitId) continue;
      const tiers = byBenefit.get(benefitId) ?? [];
      tiers.push({ id: reward.id, requiredMinutes: reward.requiredMinutes });
      byBenefit.set(benefitId, tiers);
    }
  }
  for (const [benefitId, tiers] of byBenefit) {
    const count = countsForCampaign.get(benefitId) ?? 0;
    if (count === 0) continue;
    tiers
      .sort((left, right) => left.requiredMinutes - right.requiredMinutes)
      .slice(0, count)
      .forEach((tier) => claimed.add(tier.id));
  }
  return claimed;
}

function earnedRewardCountsFromInventory(input: TwitchInventory): EarnedRewardCounts | undefined {
  const edges = input.data?.currentUser?.inventory?.earnedDropRewards?.edges;
  return edges ? earnedRewardCounts(edges) : undefined;
}

// The per-user claim state a set of campaigns comes with. An Inventory response
// carries all of it; a bare campaign list (campaign details, reward campaigns)
// carries none, so every field falls back to its empty value there.
interface TwitchCampaignSource {
  campaigns: readonly TwitchCampaign[];
  // Only dropCampaignsInProgress carries a per-tier self edge. Everything else
  // reports no per-user claim state, so shared-benefit tiers there must keep
  // using the owned-benefit fallback.
  hasPerTierProgress: boolean;
  gameEventDrops: readonly TwitchGameEventDrop[];
  // v2 responses carry one edge per claim, which answers per tier what
  // gameEventDrops can only answer per benefit. Absent on v1.
  earnedCounts?: EarnedRewardCounts;
  userId?: string;
}

function inventorySource(inventory: TwitchInventory): TwitchCampaignSource {
  const inProgress = inventory.data?.currentUser?.inventory?.dropCampaignsInProgress;
  const campaigns = inProgress
    ?? inventory.data?.currentUser?.inventory?.dropCampaigns
    ?? inventory.data?.currentUser?.dropCampaigns
    ?? [];
  return {
    campaigns,
    hasPerTierProgress: campaigns === inProgress,
    gameEventDrops: inventory.data?.currentUser?.inventory?.gameEventDrops ?? [],
    earnedCounts: earnedRewardCountsFromInventory(inventory),
    userId: inventory.data?.currentUser?.id,
  };
}

function campaignListSource(campaigns: readonly TwitchCampaign[]): TwitchCampaignSource {
  return { campaigns, hasPerTierProgress: false, gameEventDrops: [] };
}

// Parses a full Inventory response: campaigns plus the per-user claim state that
// comes with them.
export function parseTwitchInventory(inventory: TwitchInventory): DropCampaign[] {
  return parseTwitchCampaignSource(inventorySource(inventory));
}

// Parses a bare campaign list (campaign details, reward campaigns), which
// carries no per-user claim state.
export function parseTwitchCampaigns(campaigns: readonly TwitchCampaign[]): DropCampaign[] {
  return parseTwitchCampaignSource(campaignListSource(campaigns));
}

function parseTwitchCampaignSource(source: TwitchCampaignSource): DropCampaign[] {
  const { campaigns, hasPerTierProgress, gameEventDrops, earnedCounts, userId } = source;
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
    const accountLinkUrl = normalizeTwitchAccountLinkUrl(campaign.accountLinkURL);
    const hasAccountLink = Boolean(accountLinkUrl);
    const accountLinked = !hasAccountLink || campaign.self?.isAccountConnected !== false;
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
    // Twitch includes subscription, purchase, and other action-gated rewards in
    // timeBasedDrops. Retain them internally so an obtained reward can still be
    // claimed, but mark them as non-watch rewards so they never drive farming.
    const rewardBenefitIds = (campaign.timeBasedDrops ?? []).map((drop) =>
      (drop.benefitEdges ?? []).map((edge) => edge.benefit?.id));
    // v2 has campaign-scoped earned rewards, so its current per-tier state can
    // reject a gameEventDrops match left behind by an earlier campaign that
    // awarded the same benefit. Legacy v1 lacks that evidence and retains the
    // ownership fallback, except where one benefit is ambiguous across tiers.
    const benefitIdsExcludedFromOwnership = hasPerTierProgress
      ? earnedCounts !== undefined
        ? new Set(rewardBenefitIds.flat().filter((id): id is string => Boolean(id)))
        : benefitIdsSharedAcrossRewards(rewardBenefitIds)
      : new Set<string>();
    const claimedByEarned = rewardIdsClaimedByEarnedCounts(
      (campaign.timeBasedDrops ?? []).map((drop) => ({
        id: drop.id,
        requiredMinutes: drop.requiredMinutesWatched ?? 0,
        benefitIds: (drop.benefitEdges ?? []).map((edge) => edge.benefit?.id),
      })),
      earnedCounts?.get(campaign.id),
    );
    const earnedBenefitIds = new Set(earnedCounts?.get(campaign.id)?.keys() ?? []);
    const parsedRewards = (campaign.timeBasedDrops ?? [])
      .map((drop) => parseTwitchReward(drop, campaign.id, userId, endsAt, gameEventDrops, benefitIdsExcludedFromOwnership, claimedByEarned, earnedBenefitIds));
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
      accountLinkUrl,
      status: finalStatus,
      url: campaign.detailsURL ?? undefined,
      eligibility: eligibility(finalStatus, accountLinked, rewards),
      eligibilityReason: eligibilityReason(finalStatus, accountLinked, rewards),
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

function normalizeTwitchAccountLinkUrl(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "twitch.tv" || hostname.endsWith(".twitch.tv")) return undefined;
  } catch {
    // Preserve non-URL values for compatibility; Twitch normally returns an absolute URL.
  }
  return trimmed;
}

function parseTwitchReward(
  reward: TwitchReward,
  campaignId: string,
  userId?: string,
  campaignEndsAt?: string,
  gameEventDrops: readonly TwitchGameEventDrop[] = [],
  benefitIdsExcludedFromOwnership: ReadonlySet<string> = new Set(),
  claimedByEarnedRewardIds: ReadonlySet<string> = new Set(),
  earnedBenefitIds: ReadonlySet<string> = new Set(),
): DropReward {
  const watchedMinutes = reward.self?.currentMinutesWatched ?? 0;
  const requiredMinutes = reward.requiredMinutesWatched ?? 0;
  const requiredSubs = reward.requiredSubs ?? 0;
  const requirement = requiredSubs > 0
    ? "subscription" as const
    : requiredMinutes > 0
      ? "watch" as const
      : "action" as const;
  const isWatchBased = requirement === "watch";
  const benefits = (reward.benefitEdges ?? [])
    .map((edge) => edge.benefit)
    .filter((benefit): benefit is NonNullable<typeof benefit> => Boolean(benefit));
  // For watch rewards, a benefit already present in gameEventDrops means the
  // user owns this reward even if Twitch still reports isClaimed=false. That
  // inventory is campaign-agnostic, so subscription rewards must rely only on
  // their campaign-specific self state / drop instance.
  //
  // The shortcut also cannot speak for a benefit that several tiers of the same
  // campaign award (Hunt: Showdown hands out one "Supply Crate" benefit at 30 /
  // 60 / 120 / 180 minutes): owning it proves only that *some* tier paid out,
  // and gameEventDrops carries no per-tier count. Claiming the earliest tier
  // would otherwise mark every later tier claimed and strand a real pending
  // claim, so those tiers defer to their own self edge.
  // A benefit the earned-reward counts mention is fully accounted for by them, so
  // the owned-benefit fallback must not add claims on top — otherwise a count of 3
  // over 4 tiers would still mark the fourth claimed. Benefits absent from the
  // counts keep the fallback only when campaign-scoped progress cannot answer:
  // an old campaign may have no recent edges at all, while legacy v1 has no
  // earned-reward field. The caller excludes every benefit for an in-progress
  // v2 campaign so an identically reused benefit from an older campaign cannot
  // override the current self edge.
  const benefitIdsForOwnership = benefits
    .map((benefit) => benefit.id)
    .filter((id) => id != null && !benefitIdsExcludedFromOwnership.has(id) && !earnedBenefitIds.has(id));
  const ownsBenefit = isWatchBased && ownsRewardBenefit(benefitIdsForOwnership, gameEventDrops);
  // An earned-reward count is per claim and campaign-scoped, so it outranks both
  // the self edge (absent once a campaign leaves the progress payload) and the
  // owned-benefit fallback (blind to how many tiers of a shared benefit paid out).
  const isClaimed = claimedByEarnedRewardIds.has(reward.id)
    || reward.self?.isClaimed === true
    || ownsBenefit;
  // Twitch's real dropInstanceID has the form `userID#campaignID#dropID` (see
  // TwitchDropsMiner inventory.py generate_claim and its inventory dump, which
  // strips user ids out of these). Prefer the value Twitch returns on the self
  // edge once the claim is released, and reconstruct it deterministically when
  // the edge is absent so a watched-complete drop is still claimable.
  const claimId = reward.self?.dropInstanceID
    ?? (isWatchBased && userId ? `${userId}#${campaignId}#${reward.id}` : undefined);
  const preconditionRewardIds = reward.preconditionDrops?.map((drop) => drop.id) ?? [];

  return {
    id: reward.id,
    name: benefits[0]?.name ?? reward.name ?? `Reward ${reward.id}`,
    imageUrl: benefits[0]?.imageAssetURL,
    benefitIds: benefits.map((benefit) => benefit.id).filter((id): id is string => Boolean(id)),
    benefitType: benefits[0]?.distributionType,
    requiredMinutes,
    requiredSubs: reward.requiredSubs,
    requirement,
    isWatchBased,
    watchedMinutes: isClaimed ? requiredMinutes : watchedMinutes,
    claimId,
    availableFrom: reward.startAt,
    availableUntil: reward.endAt,
    claimUntil: campaignEndsAt ? addHours(campaignEndsAt, 24) : undefined,
    preconditionRewardIds,
    preconditionsMet: preconditionRewardIds.length === 0,
    status: isClaimed
      ? "claimed"
      : !isWatchBased
        ? reward.self?.dropInstanceID
          ? "claimable"
          : watchedMinutes > 0
            ? "in_progress"
            : "locked"
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
  inventory: TwitchInventory,
): DropCampaign[] {
  const { gameEventDrops, earnedCounts } = inventorySource(inventory);
  const progressCampaigns = parseTwitchInventory(inventory);
  return campaigns.map((campaign) => {
    const progress = progressCampaigns.find((item) => item.id === campaign.id);
    // Withholding the owned-benefit fallback from shared benefits is only safe
    // while a per-tier self edge exists to answer in its place. A campaign absent
    // from the progress payload has no such edge — every tier would read
    // unclaimed forever and the scheduler would re-farm a finished campaign — so
    // there the fallback still applies.
    const sharedBenefitIds = progress
      ? benefitIdsSharedAcrossRewards(campaign.rewards.map((reward) => reward.benefitIds ?? []))
      : new Set<string>();
    // Per-claim truth for this campaign, when the response carries it (v2). It
    // answers the shared-benefit question outright, so it applies whether or not
    // the campaign is still in the progress payload.
    const claimedByEarned = rewardIdsClaimedByEarnedCounts(
      campaign.rewards.map((reward) => ({
        id: reward.id,
        requiredMinutes: reward.requiredMinutes,
        benefitIds: reward.benefitIds,
      })),
      earnedCounts?.get(campaign.id),
    );
    const earnedBenefitIds = new Set(earnedCounts?.get(campaign.id)?.keys() ?? []);
    const rewards = campaign.rewards.map((reward) => {
      const progressReward = progress?.rewards.find((item) => item.id === reward.id);
      const merged = progressReward ? { ...reward, ...progressReward } : reward;
      if (merged.status !== "claimed" && claimedByEarned.has(merged.id)) {
        return { ...merged, status: "claimed" as const, watchedMinutes: merged.requiredMinutes };
      }
      // A claimed watch campaign falls out of dropCampaignsInProgress, so the
      // merge above can't update it. gameEventDrops is always returned, so
      // cross-check watch ownership only when the campaign-scoped v2 evidence
      // cannot answer: after a campaign leaves progress, or under legacy v1.
      // Never apply it to subscription rewards or a benefit shared by several
      // tiers of this campaign (see parseTwitchReward).
      if (
        (!progress || earnedCounts === undefined)
        && merged.status !== "claimed"
        && isWatchReward(merged)
        && ownsRewardBenefit(
          (merged.benefitIds ?? []).filter((id) => !sharedBenefitIds.has(id) && !earnedBenefitIds.has(id)),
          gameEventDrops,
        )
      ) {
        return { ...merged, status: "claimed" as const, watchedMinutes: merged.requiredMinutes };
      }
      return merged;
    });
    const allClaimed = rewards.length > 0 && rewards.every((reward) => reward.status === "claimed");
    const status = allClaimed
      ? "completed"
      : progress?.status === "completed"
        ? campaign.status
        : progress?.status ?? campaign.status;
    return withCampaignStatus({ ...campaign, rewards }, status);
  });
}

function addHours(value: string, hours: number): string | undefined {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time + hours * 60 * 60 * 1000).toISOString();
}

// True when the user already owns any of these benefits (it appears in the
// inventory's gameEventDrops). Used to treat a drop as claimed regardless of
// when it was awarded or what the per-drop self edge reports.
//
// Twitch's canonical Inventory response returns each owned reward as a
// UserDropReward whose benefit id is the `id` field directly (e.g.
// `<gameId>_CUSTOM_ID_BackpackCharmCannedTomatoes`); there is no `benefit`
// sub-object. We match on `id` and keep `benefit.id` only as a defensive
// fallback for the inline query shape.
function ownsRewardBenefit(
  benefitIds: readonly (string | undefined)[],
  gameEventDrops: readonly TwitchGameEventDrop[],
): boolean {
  return benefitIds.some((id) =>
    id != null && gameEventDrops.some((drop) => drop.id === id || drop.benefit?.id === id),
  );
}

// Benefit ids that more than one reward of the same campaign awards, given one
// entry of benefit ids per reward. Ownership of such a benefit cannot identify
// which of those rewards is still unclaimed.
function benefitIdsSharedAcrossRewards(
  rewardBenefitIds: ReadonlyArray<ReadonlyArray<string | undefined>>,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const benefitIds of rewardBenefitIds) {
    // Deduplicate within a reward: the same id twice on one reward is not shared.
    for (const id of new Set(benefitIds.filter((id): id is string => Boolean(id)))) {
      if (seen.has(id)) shared.add(id);
      else seen.add(id);
    }
  }
  return shared;
}

function eligibility(
  status: DropCampaign["status"],
  accountLinked: boolean,
  rewards: DropReward[],
): DropCampaign["eligibility"] {
  if (!accountLinked) return "account_not_linked";
  if (status === "upcoming") return "upcoming";
  if (status === "expired") return "expired";
  if (status === "completed") return "completed";
  if (rewards.length > 0 && rewards.every((reward) => reward.status === "claimed")) return "completed";
  if (rewards.some(isWatchReward)) return "eligible";
  if (rewards.some(isWaitingSubscriptionReward)) return "waiting_for_subscription";
  return "no_rewards";
}

function eligibilityReason(status: DropCampaign["status"], accountLinked: boolean, rewards: DropReward[]): string {
  if (!accountLinked) return "Account is not linked for this campaign";
  if (status === "upcoming") return "Campaign has not started";
  if (status === "expired") return "Campaign has ended";
  if (status === "completed") return "All rewards are claimed";
  if (rewards.length > 0 && rewards.every((reward) => reward.status === "claimed")) return "All rewards are claimed";
  if (rewards.some(isWatchReward)) return "Eligible";
  if (rewards.some(isWaitingSubscriptionReward)) return "Waiting for a qualifying subscription";
  return "Campaign has no time-based rewards";
}

// Returns a copy of the campaign with a new status and consistent eligibility
// fields. Used when discovery has out-of-band knowledge (e.g. the dashboard no
// longer lists the campaign as active) that the inventory payload can't convey.
export function withCampaignStatus(campaign: DropCampaign, status: DropCampaign["status"]): DropCampaign {
  const accountLinked = campaign.accountLinked !== false;
  return {
    ...campaign,
    status,
    eligibility: eligibility(status, accountLinked, campaign.rewards),
    eligibilityReason: eligibilityReason(status, accountLinked, campaign.rewards),
  };
}

export function campaignHasClaimableReward(campaign: DropCampaign): boolean {
  return campaign.rewards.some((reward) => reward.status === "claimable");
}
