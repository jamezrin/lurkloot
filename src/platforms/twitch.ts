import type { ChannelCandidate, ChannelCheck, DropCampaign, DropReward, WatchSession } from "../core/models";
import { fetchJsonInPage, openPinnedMutedTab, stopWatchTab } from "../core/tabs";
import type { PageFetcher, PlatformAdapter, WatchTabOptions } from "./adapter";
import { mergeTwitchCampaignProgress, parseTwitchInventory, twitchCandidatesFromCampaign } from "./twitchParser";

const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const TWITCH_QUERIES = {
  inventory: {
    operationName: "Inventory",
    sha256Hash: "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b",
    variables: { fetchRewardCampaigns: true },
  },
  dashboard: {
    operationName: "ViewerDropsDashboard",
    sha256Hash: "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619",
    variables: { fetchRewardCampaigns: true },
  },
  campaignDetailsHash: "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1",
  gameDirectoryHash: "c7c9d5aad09155c4161d2382092dc44610367f3536aac39019ec2582ae5065f9",
  streamInfoHash: "198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d",
  currentDropHash: "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b",
  channelPointsHash: "374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345",
  claimCommunityPointsHash: "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0",
  claimHash: "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930",
};

// Persisted query hashes for stream info rotate and eventually return
// PersistedQueryNotFound. The viewer-count check sends this inline query instead
// so it keeps working without depending on a server-side registered hash.
const STREAM_INFO_QUERY = `query StreamInfo($channel: String!) {
  user(login: $channel) {
    id
    displayName
    stream { id type viewersCount game { id name } }
  }
}`;

interface TwitchGqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface TwitchDashboardData {
  currentUser?: {
    id?: string;
    login?: string;
    dropCampaigns?: Array<{ id?: string; status?: string; self?: { isAccountConnected?: boolean } }>;
  };
}

interface TwitchCampaignDetailsData {
  currentUser?: { id?: string; login?: string };
  user?: { dropCampaign?: unknown };
  dropCampaign?: unknown;
}

interface TwitchDirectoryData {
  game?: {
    streams?: {
      edges?: Array<{
        node?: {
          title?: string;
          viewersCount?: number;
          broadcaster?: {
            login?: string;
            displayName?: string;
            profileImageURL?: string;
          };
        };
      }>;
    };
  };
}

interface TwitchStreamInfoData {
  user?: {
    id?: string;
    displayName?: string;
    stream?: {
      type?: string;
      viewersCount?: number;
      game?: { id?: string; name?: string };
    } | null;
  };
}

interface TwitchChannelPointsData {
  community?: {
    channel?: {
      id?: string;
      self?: {
        communityPoints?: {
          availableClaim?: { id?: string };
        };
      };
    };
  };
}

interface TwitchCurrentDropData {
  currentUser?: {
    dropCurrentSession?: {
      dropID?: string;
      currentMinutesWatched?: number;
    } | null;
  };
}

export class TwitchAdapter implements PlatformAdapter {
  platform = "twitch" as const;

  constructor(
    private readonly fetcher: PageFetcher = {
      fetchJson: (url, init) => fetchJsonInPage("https://www.twitch.tv/drops/inventory", url, init, {
        retainPageContext: { platform: "twitch" },
      }),
    },
  ) {}

  async discoverCampaigns(): Promise<DropCampaign[]> {
    const [inventory, dashboard] = await Promise.all([
      this.gql<unknown>(TWITCH_QUERIES.inventory.operationName, TWITCH_QUERIES.inventory.sha256Hash, TWITCH_QUERIES.inventory.variables),
      this.gql<TwitchDashboardData>(TWITCH_QUERIES.dashboard.operationName, TWITCH_QUERIES.dashboard.sha256Hash, TWITCH_QUERIES.dashboard.variables),
    ]);
    const userLogin = dashboard.data?.currentUser?.login ?? dashboard.data?.currentUser?.id ?? "";
    const inventoryCampaigns = parseTwitchInventory(inventory as Parameters<typeof parseTwitchInventory>[0]);
    const discoverableCampaignIds = (dashboard.data?.currentUser?.dropCampaigns ?? [])
      .filter((campaign) =>
        campaign.id
        && (campaign.status === "ACTIVE" || campaign.status === "UPCOMING")
        && campaign.self?.isAccountConnected !== false
      )
      .map((campaign) => campaign.id as string);

    if (discoverableCampaignIds.length === 0) {
      return inventoryCampaigns;
    }

    const details = await Promise.allSettled(
      discoverableCampaignIds.map((dropID) =>
        this.gql<TwitchCampaignDetailsData>("DropCampaignDetails", TWITCH_QUERIES.campaignDetailsHash, {
          channelLogin: userLogin,
          dropID,
        }),
      ),
    );
    const detailedCampaigns = details
      .map((result) => result.status === "fulfilled" ? result.value.data?.dropCampaign ?? result.value.data?.user?.dropCampaign : undefined)
      .filter((campaign): campaign is NonNullable<typeof campaign> => Boolean(campaign));
    if (detailedCampaigns.length === 0) {
      return inventoryCampaigns;
    }
    const parsedDetails = parseTwitchInventory(detailedCampaigns as Parameters<typeof parseTwitchInventory>[0]);
    const mergedDetails = mergeTwitchCampaignProgress(parsedDetails, inventory as Parameters<typeof mergeTwitchCampaignProgress>[1]);
    const detailedIds = new Set(mergedDetails.map((campaign) => campaign.id));
    return [
      ...mergedDetails,
      ...inventoryCampaigns.filter((campaign) => !detailedIds.has(campaign.id)),
    ];
  }

  async readProgress(campaigns: DropCampaign[], session?: WatchSession): Promise<DropCampaign[]> {
    const inventory = await this.gql<unknown>(
      TWITCH_QUERIES.inventory.operationName,
      TWITCH_QUERIES.inventory.sha256Hash,
      TWITCH_QUERIES.inventory.variables,
    );
    const inventoryProgress = mergeTwitchCampaignProgress(campaigns, inventory as Parameters<typeof mergeTwitchCampaignProgress>[1]);
    if (!session?.channel || session.status !== "watching") return inventoryProgress;
    return this.mergeCurrentSessionProgress(inventoryProgress, session.channel);
  }

  async listCandidateChannels(campaign: DropCampaign): Promise<ChannelCandidate[]> {
    const aclCandidates = twitchCandidatesFromCampaign(campaign);
    if (aclCandidates.length > 0) return aclCandidates;
    if (!campaign.slug && !campaign.categoryId) return [];

    const response = await this.gql<TwitchDirectoryData>("GameDirectory", TWITCH_QUERIES.gameDirectoryHash, {
      name: campaign.slug ?? campaign.gameName,
      options: {
        sort: "VIEWER_COUNT",
        recommendationsContext: { platform: "web" },
        requestID: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
        freeformTags: ["DropsEnabled"],
        tags: [],
      },
      sortTypeIsRecency: false,
      limit: 25,
    });

    return (response.data?.game?.streams?.edges ?? [])
      .map((edge): ChannelCandidate | undefined => {
        const broadcaster = edge.node?.broadcaster;
        if (!broadcaster?.login) return undefined;
        return {
          platform: "twitch",
          username: broadcaster.login.toLowerCase(),
          displayName: broadcaster.displayName ?? broadcaster.login,
          profileImageUrl: broadcaster.profileImageURL,
          url: `https://www.twitch.tv/${broadcaster.login}`,
          campaignId: campaign.id,
          categoryId: campaign.categoryId,
          categoryName: campaign.gameName,
          isAclMatch: false,
          viewerCount: edge.node?.viewersCount,
          title: edge.node?.title,
          live: true,
        };
      })
      .filter((candidate): candidate is ChannelCandidate => Boolean(candidate));
  }

  async checkChannel(channel: ChannelCandidate, campaign?: DropCampaign): Promise<ChannelCheck> {
    try {
      const response = await this.gql<TwitchStreamInfoData>(
        "StreamInfo",
        TWITCH_QUERIES.streamInfoHash,
        { channel: channel.username },
        STREAM_INFO_QUERY,
        // Anonymous: this is public data, and logged-in GQL calls without an
        // integrity token are rejected (which would mask the channel as live).
        "omit",
      );
      const stream = response.data?.user?.stream;
      const actualCategoryId = stream?.game?.id;
      const expectedCategoryId = campaign?.categoryId ?? channel.categoryId;
      return {
        live: Boolean(stream),
        categoryMatches: !expectedCategoryId || actualCategoryId === expectedCategoryId,
        reason: stream ? undefined : "Twitch channel is offline",
        candidate: {
          ...channel,
          displayName: response.data?.user?.displayName ?? channel.displayName,
          categoryId: actualCategoryId ?? channel.categoryId,
          categoryName: stream?.game?.name ?? channel.categoryName,
          viewerCount: stream?.viewersCount ?? channel.viewerCount,
        },
      };
    } catch (error) {
      return this.checkChannelFromPage(channel, campaign, error);
    }
  }

  async claimReward(_campaign: DropCampaign, reward: DropReward): Promise<boolean> {
    if (!reward.claimId) return false;
    const result = await this.gql<{ claimDropRewards?: { status?: string } }>(
      "DropsPage_ClaimDropRewards",
      TWITCH_QUERIES.claimHash,
      { input: { dropInstanceID: reward.claimId } },
    );
    const status = result.data?.claimDropRewards?.status;
    return status === "ELIGIBLE_FOR_ALL" || status === "DROP_INSTANCE_ALREADY_CLAIMED";
  }

  async claimChannelPoints(channel: ChannelCandidate): Promise<boolean> {
    const context = await this.gql<TwitchChannelPointsData>(
      "ChannelPointsContext",
      TWITCH_QUERIES.channelPointsHash,
      { channelLogin: channel.username },
    );
    const channelId = context.data?.community?.channel?.id;
    const claimId = context.data?.community?.channel?.self?.communityPoints?.availableClaim?.id;
    if (!channelId || !claimId) return false;

    const result = await this.gql<{ claimCommunityPoints?: { status?: string } }>(
      "ClaimCommunityPoints",
      TWITCH_QUERIES.claimCommunityPointsHash,
      { input: { claimID: claimId, channelID: channelId } },
    );
    return result.data?.claimCommunityPoints?.status !== "CLAIM_NOT_AVAILABLE";
  }

  prepareWatchTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>) {
    return openPinnedMutedTab(channel, session, options);
  }

  stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
    return stopWatchTab(session, options);
  }

  private async mergeCurrentSessionProgress(
    campaigns: DropCampaign[],
    channel: ChannelCandidate,
  ): Promise<DropCampaign[]> {
    try {
      const streamInfo = await this.gql<TwitchStreamInfoData>(
        "VideoPlayerStreamInfoOverlayChannel",
        TWITCH_QUERIES.streamInfoHash,
        { channel: channel.username },
      );
      const channelId = streamInfo.data?.user?.id;
      if (!channelId) return campaigns;

      const current = await this.gql<TwitchCurrentDropData>(
        "DropCurrentSessionContext",
        TWITCH_QUERIES.currentDropHash,
        { channelID: channelId, channelLogin: "" },
      );
      const drop = current.data?.currentUser?.dropCurrentSession;
      if (!drop?.dropID || drop.currentMinutesWatched == null) return campaigns;
      const currentMinutesWatched = drop.currentMinutesWatched;

      return campaigns.map((campaign) => ({
        ...campaign,
        rewards: campaign.rewards.map((reward) => reward.id === drop.dropID
          ? {
              ...reward,
              watchedMinutes: Math.max(reward.watchedMinutes, currentMinutesWatched),
              status: currentMinutesWatched >= reward.requiredMinutes
                ? "claimable"
                : currentMinutesWatched > 0
                  ? "in_progress"
                  : reward.status,
              isCurrentReward: true,
            }
          : { ...reward, isCurrentReward: false }),
      }));
    } catch {
      return campaigns;
    }
  }

  private async gql<T>(
    operationName: string,
    sha256Hash: string,
    variables: Record<string, unknown>,
    query?: string,
    credentials?: RequestCredentials,
  ): Promise<TwitchGqlResponse<T>> {
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "client-id": TWITCH_CLIENT_ID,
      },
      ...(credentials ? { credentials } : {}),
      body: JSON.stringify(
        query
          ? { operationName, variables, query }
          : {
              operationName,
              variables,
              extensions: {
                persistedQuery: {
                  version: 1,
                  sha256Hash,
                },
              },
            },
      ),
    } satisfies RequestInit;
    let response = await this.fetcher.fetchJson<TwitchGqlResponse<T>>("https://gql.twitch.tv/gql", request);
    if (response.errors?.some((error) => isTransientGqlError(error.message))) {
      response = await this.fetcher.fetchJson<TwitchGqlResponse<T>>("https://gql.twitch.tv/gql", request);
    }
    if (response.errors?.length) {
      throw new Error(response.errors.map((error) => error.message).filter(Boolean).join("; ") || `${operationName} failed`);
    }
    return response;
  }

  private async checkChannelFromPage(
    channel: ChannelCandidate,
    campaign: DropCampaign | undefined,
    originalError: unknown,
  ): Promise<ChannelCheck> {
    try {
      const page = await this.fetcher.fetchJson<{ html?: string }>(channel.url);
      const html = page.html ?? "";
      const live = parseLiveState(html);
      const actualCategoryId = parseGameId(html);
      const expectedCategoryId = campaign?.categoryId ?? channel.categoryId;
      return {
        live,
        categoryMatches: !expectedCategoryId || actualCategoryId == null || actualCategoryId === expectedCategoryId,
        reason: "Twitch GQL check failed; used channel page fallback",
        candidate: {
          ...channel,
          categoryId: actualCategoryId ?? channel.categoryId,
        },
      };
    } catch {
      return {
        live: true,
        categoryMatches: true,
        reason: originalError instanceof Error ? originalError.message : "Twitch channel check failed",
        candidate: channel,
      };
    }
  }
}

function isTransientGqlError(message: string | undefined): boolean {
  return message === "service error"
    || message === "service timeout"
    || message === "service unavailable"
    || message === "context deadline exceeded";
}

function parseLiveState(html: string): boolean {
  if (/["']isLiveBroadcast["']\s*:\s*true/i.test(html)) return true;
  if (/["']stream["']\s*:\s*null/i.test(html)) return false;
  if (/isLiveBroadcast/i.test(html) || /DropsEnabled/i.test(html)) return true;
  return true;
}

function parseGameId(html: string): string | undefined {
  const gameObject = html.match(/["']game["']\s*:\s*\{[^{}]*["']id["']\s*:\s*["']([^"']+)["']/i);
  if (gameObject?.[1]) return gameObject[1];
  const gameId = html.match(/["']gameID["']\s*:\s*["']([^"']+)["']/i);
  return gameId?.[1];
}
