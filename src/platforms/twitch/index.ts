import type { CategorySelection, ChannelCandidate, ChannelCheck, DropCampaign, DropReward, WatchSession } from "../../core/models";
import type { HeartbeatResult, TablessWatchController, WatchContext } from "../../core/tablessWatch";
import { logActivity } from "../../core/activityLog";
import { ensureTwitchIntegrity, fetchTwitchInBackground, openPinnedMutedTab, stopWatchTab } from "../../core/tabs";
import type { PageFetcher, PlatformAdapter, WatchTabOptions } from "../adapter";
import { campaignHasClaimableReward, mergeTwitchCampaignProgress, parseTwitchInventory, twitchCandidatesFromCampaign, withCampaignStatus } from "./parser";
import { buildSpadeInput, SEND_SPADE_EVENTS_MUTATION } from "./watch";

// Inline query: the viewer's own user id, needed for the minute-watched event.
const CURRENT_USER_QUERY = "query CurrentUser { currentUser { id } }";

const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const TWITCH_QUERIES = {
  inventory: {
    operationName: "Inventory",
    sha256Hash: "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b",
    variables: { fetchRewardCampaigns: false },
  },
  dashboard: {
    operationName: "ViewerDropsDashboard",
    sha256Hash: "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619",
    variables: { fetchRewardCampaigns: false },
  },
  campaignDetailsHash: "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1",
  gameDirectoryHash: "cb5dc816e139dcb8a118f14b4b677d59abc224a4b016c4bc2bb00a47fe0ddec4",
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

// Inline query for the category picker's live search. Sent inline (no persisted
// hash) so it keeps working without a server-registered hash. Field/arg names
// match the directory's category search; verify in twitch.tv DevTools if it drifts.
const SEARCH_CATEGORIES_QUERY = `query SearchCategories($query: String!) {
  searchCategories(query: $query, first: 15) {
    edges { node { id displayName boxArtURL } }
  }
}`;

const TWITCH_CAMPAIGN_FIELDS = `{
  id
  name
  imageURL
  startAt
  endAt
  status
  accountLinkURL
  self { isAccountConnected }
  game { id name displayName slug boxArtURL }
  allow { channels { name login } }
  timeBasedDrops {
    id
    name
    startAt
    endAt
    requiredMinutesWatched
    requiredSubs
    preconditionDrops { id }
    benefitEdges { benefit { id name imageAssetURL distributionType } }
    self { currentMinutesWatched isClaimed dropInstanceID }
  }
}`;

const TWITCH_INLINE_QUERIES: Partial<Record<string, string>> = {
  Inventory: `query Inventory($fetchRewardCampaigns: Boolean!) {
    currentUser {
      id
      inventory {
        gameEventDrops { id benefit { id } lastAwardedAt }
        dropCampaignsInProgress ${TWITCH_CAMPAIGN_FIELDS}
        dropCampaigns @include(if: $fetchRewardCampaigns) ${TWITCH_CAMPAIGN_FIELDS}
      }
    }
  }`,
  ViewerDropsDashboard: `query ViewerDropsDashboard($fetchRewardCampaigns: Boolean!) {
    currentUser {
      id
      login
      inventory {
        dropCampaigns @include(if: $fetchRewardCampaigns) { id status self { isAccountConnected } }
      }
      dropCampaigns { id status self { isAccountConnected } }
    }
  }`,
  DropCampaignDetails: `query DropCampaignDetails($channelLogin: String!, $dropID: ID!) {
    currentUser { id login }
    user(login: $channelLogin) {
      dropCampaign(id: $dropID) ${TWITCH_CAMPAIGN_FIELDS}
    }
  }`,
  DirectoryPage_Game: `query DirectoryPage_Game($slug: String!, $options: StreamSearchOptions, $sortTypeIsRecency: Boolean, $limit: Int) {
    game(name: $slug) {
      streams(options: $options, first: $limit, sortTypeIsRecency: $sortTypeIsRecency) {
        edges {
          node {
            title
            viewersCount
            broadcaster { login displayName profileImageURL }
          }
        }
      }
    }
  }`,
  DropCurrentSessionContext: `query DropCurrentSessionContext($channelID: ID!, $channelLogin: String!) {
    currentUser {
      dropCurrentSession(channelID: $channelID, channelLogin: $channelLogin) {
        dropID
        currentMinutesWatched
      }
    }
  }`,
  ChannelPointsContext: `query ChannelPointsContext($channelLogin: String!) {
    community {
      channel(login: $channelLogin) {
        id
        self { communityPoints { availableClaim { id } } }
      }
    }
  }`,
  ClaimCommunityPoints: `mutation ClaimCommunityPoints($input: ClaimCommunityPointsInput!) {
    claimCommunityPoints(input: $input) { status }
  }`,
};

interface TwitchGqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
  // Twitch reports auth/integrity failures as a top-level `{ error, message }`
  // pair rather than the standard `errors[]` envelope (see TwitchDropsMiner
  // twitch.py:1352). Surface it instead of treating the response as usable.
  error?: string;
  message?: string;
}

interface TwitchDashboardData {
  currentUser?: {
    id?: string;
    login?: string;
    inventory?: {
      dropCampaigns?: Array<{ id?: string; status?: string; self?: { isAccountConnected?: boolean } }>;
    };
    dropCampaigns?: Array<{ id?: string; status?: string; self?: { isAccountConnected?: boolean } }>;
  };
}

interface TwitchCampaignDetailsData {
  currentUser?: { id?: string; login?: string };
  user?: { dropCampaign?: unknown };
  dropCampaign?: unknown;
}

interface TwitchSearchCategoriesData {
  searchCategories?: {
    edges?: Array<{ node?: { id?: string; displayName?: string; boxArtURL?: string } }>;
  };
}

// Box art URLs come back with `{width}x{height}` placeholders; size them for the
// small picker avatar.
function twitchBoxArtUrl(boxArtURL: string | undefined): string | undefined {
  if (!boxArtURL) return undefined;
  return boxArtURL.replace("{width}", "144").replace("{height}", "192");
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
      id?: string;
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
    // Twitch GQL is unreachable from the twitch.tv page context (CORS / anti-
    // tampering blocks it). The background fetch has host permissions for
    // gql.twitch.tv and attaches the OAuth token from cookies, like the web client.
    private readonly fetcher: PageFetcher = {
      fetchJson: (url, init) => fetchTwitchInBackground(url, init),
    },
    // Drop claims require a valid Client-Integrity token; this opens/reuses a live
    // twitch.tv tab to capture one when none is present (see src/core/tabs.ts).
    private readonly ensureIntegrity: () => Promise<boolean> = ensureTwitchIntegrity,
  ) {}

  async discoverCampaigns(): Promise<DropCampaign[]> {
    let inventory = await this.fetchInventory();
    let dashboard = await this.optionalGql<TwitchDashboardData>(
      TWITCH_QUERIES.dashboard.operationName,
      TWITCH_QUERIES.dashboard.sha256Hash,
      TWITCH_QUERIES.dashboard.variables,
    );
    let inventoryCampaigns = parseTwitchInventory(inventory as Parameters<typeof parseTwitchInventory>[0]);
    let dashboardCampaigns = twitchDashboardCampaigns(dashboard);

    if (inventoryCampaigns.length === 0 && dashboardCampaigns.length === 0) {
      inventory = await this.fetchInventory({ fetchRewardCampaigns: true });
      dashboard = await this.optionalGql<TwitchDashboardData>(
        TWITCH_QUERIES.dashboard.operationName,
        TWITCH_QUERIES.dashboard.sha256Hash,
        { fetchRewardCampaigns: true },
      );
      inventoryCampaigns = parseTwitchInventory(inventory as Parameters<typeof parseTwitchInventory>[0]);
      dashboardCampaigns = twitchDashboardCampaigns(dashboard);
    }

    if (!twitchHasCurrentUser(inventory) && !dashboard.data?.currentUser) {
      throw new Error("Twitch did not return a logged-in current user; open twitch.tv and confirm you are signed in");
    }

    const userLogin = twitchCurrentUserId(inventory) ?? dashboard.data?.currentUser?.id ?? dashboard.data?.currentUser?.login ?? "";
    const discoverableCampaignIds = dashboardCampaigns
      .filter((campaign) =>
        campaign.id
        && (campaign.status === "ACTIVE" || campaign.status === "UPCOMING")
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
    // The Inventory payload omits campaign/reward end dates, so an ended
    // campaign that still has in-progress drops parses as "active". The
    // dashboard is the authoritative signal for what is still running: if it
    // responded and no longer lists this campaign as ACTIVE/UPCOMING, treat the
    // inventory-only campaign as expired (unless it still has a claimable reward
    // we should keep surfacing so the user can claim it).
    const activeDashboardIds = new Set(discoverableCampaignIds);
    const dashboardResponded = dashboardCampaigns.length > 0;
    const inventoryOnly = inventoryCampaigns
      .filter((campaign) => !detailedIds.has(campaign.id))
      .map((campaign) =>
        dashboardResponded
        && !activeDashboardIds.has(campaign.id)
        && !campaignHasClaimableReward(campaign)
          ? withCampaignStatus(campaign, "expired")
          : campaign,
      );
    return [...mergedDetails, ...inventoryOnly];
  }

  async readProgress(campaigns: DropCampaign[], session?: WatchSession): Promise<DropCampaign[]> {
    const inventory = await this.fetchInventory();
    const inventoryProgress = mergeTwitchCampaignProgress(campaigns, inventory as Parameters<typeof mergeTwitchCampaignProgress>[1]);
    if (!session?.channel || session.status !== "watching") return inventoryProgress;
    return this.mergeCurrentSessionProgress(inventoryProgress, session.channel);
  }

  async listCandidateChannels(campaign: DropCampaign): Promise<ChannelCandidate[]> {
    const aclCandidates = twitchCandidatesFromCampaign(campaign);
    if (aclCandidates.length > 0) return aclCandidates;
    if (!campaign.slug && !campaign.categoryId) return [];

    const response = await this.gql<TwitchDirectoryData>("DirectoryPage_Game", TWITCH_QUERIES.gameDirectoryHash, {
      slug: campaign.slug ?? campaign.gameName,
      imageWidth: 50,
      includeCostreaming: false,
      options: {
        sort: "VIEWER_COUNT",
        broadcasterLanguages: [],
        includeRestricted: ["SUB_ONLY_LIVE"],
        recommendationsContext: { platform: "web" },
        requestID: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
        freeformTags: null,
        systemFilters: ["DROPS_ENABLED"],
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
          channelId: response.data?.user?.id ?? channel.channelId,
          broadcastId: stream?.id ?? channel.broadcastId,
        },
      };
    } catch (error) {
      return this.checkChannelFromPage(channel, campaign, error);
    }
  }

  async searchCategories(query: string): Promise<CategorySelection[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Anonymous: public data, and logged-in GQL without an integrity token is
    // rejected. Passing the inline query skips the persisted-hash attempt.
    const response = await this.gql<TwitchSearchCategoriesData>(
      "SearchCategories",
      "",
      { query: trimmed },
      SEARCH_CATEGORIES_QUERY,
      "omit",
    );
    return (response.data?.searchCategories?.edges ?? [])
      .map((edge): CategorySelection => ({
        id: edge.node?.id ?? "",
        name: edge.node?.displayName ?? "",
        imageUrl: twitchBoxArtUrl(edge.node?.boxArtURL),
      }))
      .filter((category) => category.id && category.name);
  }

  private async fetchInventory(variables: Record<string, unknown> = TWITCH_QUERIES.inventory.variables): Promise<unknown> {
    return this.gql<unknown>(
      TWITCH_QUERIES.inventory.operationName,
      TWITCH_QUERIES.inventory.sha256Hash,
      variables,
    );
  }

  private async optionalGql<T>(
    operationName: string,
    sha256Hash: string,
    variables: Record<string, unknown>,
  ): Promise<TwitchGqlResponse<T>> {
    try {
      return await this.gql(operationName, sha256Hash, variables);
    } catch {
      return {};
    }
  }

  // A "claimable" reward can only be claimed once Twitch has released its real
  // drop-instance id (see parseTwitchReward). Until then, defer.
  isClaimReady(reward: DropReward): boolean {
    return Boolean(reward.claimId);
  }

  async claimReward(campaign: DropCampaign, reward: DropReward): Promise<boolean> {
    if (!reward.claimId) return false;

    logActivity("debug", `Claiming ${reward.name} from ${campaign.name} (instance ${reward.claimId})`, "twitch");
    // Claiming requires a valid Client-Integrity token, which we replay from the
    // live twitch.tv page (see src/core/twitchIntegrity.ts). Proactively ensure one
    // exists first so a tabless / no-tab session can still claim. This is a no-op
    // fast path when a token is already captured.
    await this.ensureIntegrity();

    try {
      return await this.runClaim(reward);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only integrity rejections are worth a refresh + retry; everything else
      // (e.g. an unexpected status or a stale id) propagates unchanged.
      if (!/integrity/i.test(message)) throw error;
      logActivity("warn", `Claim for ${reward.name} was rejected for integrity; refreshing the token and retrying once`, "twitch");
      // The captured token may have just expired or been anonymous; force one
      // refresh and retry exactly once. A second failure propagates.
      const refreshed = await this.ensureIntegrity();
      if (refreshed) return await this.runClaim(reward);
      throw new Error(`Twitch rejected the claim for ${reward.name} (${message}). Keep a logged-in twitch.tv tab open so the extension can capture a valid integrity token, then retry.`);
    }
  }

  private async runClaim(reward: DropReward): Promise<boolean> {
    const result = await this.gql<{ claimDropRewards?: { status?: string } }>(
      "DropsPage_ClaimDropRewards",
      TWITCH_QUERIES.claimHash,
      { input: { dropInstanceID: reward.claimId } },
    );
    const status = result.data?.claimDropRewards?.status;
    if (status === "ELIGIBLE_FOR_ALL" || status === "DROP_INSTANCE_ALREADY_CLAIMED") return true;
    // Surface the rejection instead of a silent false so the cause is visible in
    // the event log (e.g. an unexpected status, integrity, or a stale id).
    throw new Error(`Twitch refused claim for ${reward.name}: status=${status ?? "unknown"}`);
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

  // Tabless farming: send Twitch's minute-watched telemetry instead of opening a
  // video tab. The watcher reuses this adapter's authenticated GQL transport, so
  // it keeps working even though the controller recreates adapters each tick.
  supportsTabless = true;

  createTablessWatcher(): TablessWatchController {
    return new TwitchWatcher((operationName, sha256Hash, variables, query, credentials) =>
      this.gql(operationName, sha256Hash, variables, query, credentials));
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logActivity("warn", `Could not merge current session progress for ${channel.username}: ${message}`, "twitch");
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
    const buildRequest = (queryText?: string) => ({
      method: "POST",
      headers: {
        "Accept": "*/*",
        "Accept-Language": "en-US",
        "Content-Type": "text/plain; charset=UTF-8",
        "Client-ID": TWITCH_CLIENT_ID,
      },
      ...(credentials ? { credentials } : {}),
      body: JSON.stringify(
        queryText
          ? { operationName, variables, query: queryText }
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
    } satisfies RequestInit);
    const fetchOnce = async (queryText?: string): Promise<TwitchGqlResponse<T> | null> => {
      const request = buildRequest(queryText);
      const raw = await this.fetcher.fetchJson<unknown>("https://gql.twitch.tv/gql", request);
      // The page fetcher reports failures as a serializable envelope (a rejection
      // would be swallowed at the executeScript boundary). Surface its diagnostic.
      const pageError = twitchPageFetchError(raw);
      if (pageError) throw new Error(`${operationName}: ${pageError}`);
      return normalizeTwitchGqlResponse<T>(raw);
    };
    logActivity("debug", `GQL ${operationName} request (${query ? "inline" : "persisted"} query)`, "twitch");
    let activeQuery = query;
    let response = await fetchOnce(activeQuery);
    if (!isTwitchGqlResponse<T>(response)) {
      throw new Error(`${operationName} ${query ? "inline query" : "persisted query"} returned an empty Twitch GQL response`);
    }
    const fallbackQuery = !query ? TWITCH_INLINE_QUERIES[operationName] : undefined;
    if (fallbackQuery && hasPersistedQueryNotFound(response)) {
      logActivity("debug", `GQL ${operationName} persisted query not found; retrying with the inline query`, "twitch");
      activeQuery = fallbackQuery;
      response = await fetchOnce(activeQuery);
      if (!isTwitchGqlResponse<T>(response)) {
        throw new Error(`${operationName} inline query fallback returned an empty Twitch GQL response`);
      }
    }
    if (response.errors?.some((error) => isTransientGqlError(error.message))) {
      logActivity("debug", `GQL ${operationName} returned a transient error; retrying once`, "twitch");
      response = await fetchOnce(activeQuery);
      if (!isTwitchGqlResponse<T>(response)) {
        throw new Error(`${operationName} ${activeQuery ? "inline query" : "persisted query"} returned an empty Twitch GQL response`);
      }
    }
    if (response.error || (response.message && response.data === undefined)) {
      throw new Error([response.error, response.message].filter(Boolean).join(": ") || `${operationName} failed`);
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
    const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
    logActivity("debug", `Channel GQL check failed for ${channel.username}, falling back to the channel page: ${originalMessage}`, "twitch");
    try {
      const page = await this.fetcher.fetchJson<{ html?: string }>(channel.url);
      const html = page.html ?? "";
      const live = parseLiveState(html);
      if (!live) {
        logActivity("debug", `Channel page for ${channel.username} showed no live signal; treating as offline`, "twitch");
      }
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
        live: false,
        categoryMatches: false,
        reason: originalError instanceof Error ? originalError.message : "Twitch channel check failed",
        candidate: channel,
      };
    }
  }
}

type TwitchGql = <T>(
  operationName: string,
  sha256Hash: string,
  variables: Record<string, unknown>,
  query?: string,
  credentials?: RequestCredentials,
) => Promise<TwitchGqlResponse<T>>;

// Sends one minute-watched spade event per tick (~once a minute), the tabless
// equivalent of keeping a muted video tab playing. Stateless across ticks except
// for the cached viewer id, so the controller can keep a single instance alive.
class TwitchWatcher implements TablessWatchController {
  readonly platform = "twitch" as const;
  private channel?: ChannelCandidate;
  private viewerUserId?: string;

  constructor(private readonly gql: TwitchGql) {}

  get channelUrl(): string | undefined {
    return this.channel?.url;
  }

  async start(channel: ChannelCandidate, context: WatchContext): Promise<void> {
    this.channel = channel;
    if (context.userId) this.viewerUserId = context.userId;
  }

  async stop(): Promise<void> {
    this.channel = undefined;
  }

  async tick(context: WatchContext): Promise<HeartbeatResult> {
    const channel = this.channel;
    if (!channel) return { ok: false, message: "Twitch tabless watcher has no channel" };
    if (context.userId) this.viewerUserId = context.userId;

    // Public stream info (anonymous, like checkChannel) for a fresh broadcast id
    // and liveness; logged-in GQL without an integrity token would be rejected.
    const info = await this.gql<TwitchStreamInfoData>(
      "StreamInfo",
      TWITCH_QUERIES.streamInfoHash,
      { channel: channel.username },
      STREAM_INFO_QUERY,
      "omit",
    );
    const stream = info.data?.user?.stream;
    const channelId = info.data?.user?.id ?? channel.channelId;
    const broadcastId = stream?.id ?? channel.broadcastId;
    if (!stream || !channelId || !broadcastId) {
      logActivity("debug", `Spade tick skipped for ${channel.username}: channel offline or missing a broadcast id`, "twitch");
      return { ok: false, live: false, message: "Twitch channel is offline or missing a broadcast id" };
    }

    const userId = await this.resolveUserId();
    if (!userId) return { ok: false, live: true, message: "Twitch did not return a logged-in user id" };
    logActivity("debug", `Spade tick for ${channel.username} (broadcast ${broadcastId}, channel ${channelId})`, "twitch");

    const input = await buildSpadeInput({
      broadcastId,
      channelId,
      channelLogin: channel.username,
      userId,
      gameId: stream.game?.id,
      gameName: stream.game?.name,
    });
    const result = await this.gql<{ sendSpadeEvents?: { statusCode?: number } }>(
      "SendEvents",
      "",
      { input },
      SEND_SPADE_EVENTS_MUTATION,
    );
    const status = result.data?.sendSpadeEvents?.statusCode;
    const ok = status === 204;
    logActivity("debug", `Spade event for ${channel.username} returned status ${status ?? "unknown"}`, "twitch");
    return { ok, live: true, message: ok ? undefined : `Twitch watch event returned status ${status ?? "unknown"}` };
  }

  private async resolveUserId(): Promise<string | undefined> {
    if (this.viewerUserId) return this.viewerUserId;
    try {
      const response = await this.gql<{ currentUser?: { id?: string } }>("CurrentUser", "", {}, CURRENT_USER_QUERY);
      this.viewerUserId = response.data?.currentUser?.id;
    } catch (error) {
      // Leave unresolved; tick() reports the missing-user case to the scheduler.
      const message = error instanceof Error ? error.message : String(error);
      logActivity("warn", `Could not resolve the Twitch viewer id for tabless watching: ${message}`, "twitch");
    }
    return this.viewerUserId;
  }
}

function twitchDashboardCampaigns(dashboard: TwitchGqlResponse<TwitchDashboardData>) {
  return dashboard.data?.currentUser?.dropCampaigns
    ?? dashboard.data?.currentUser?.inventory?.dropCampaigns
    ?? [];
}

function twitchCurrentUserId(value: unknown): string | undefined {
  return (value as { data?: { currentUser?: { id?: string } } }).data?.currentUser?.id;
}

function twitchHasCurrentUser(value: unknown): boolean {
  return Boolean((value as { data?: { currentUser?: unknown } }).data?.currentUser);
}

function isTwitchGqlResponse<T>(value: TwitchGqlResponse<T> | null): value is TwitchGqlResponse<T> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Twitch's GQL endpoint answers with a JSON array (one entry per batched
// operation) even though we POST a single operation. Unwrap the lone entry so
// the caller sees the same `{ data, errors }` shape it would for an unbatched
// response; both PersistedQueryNotFound and integrity rejections arrive this way.
// The in-page fetcher resolves `{ __twitchGqlError }` instead of rejecting,
// because executeScript discards rejection messages. Pull the diagnostic out.
function twitchPageFetchError(value: unknown): string | undefined {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as { __twitchGqlError?: unknown }).__twitchGqlError;
    if (typeof error === "string") return error;
  }
  return undefined;
}

function normalizeTwitchGqlResponse<T>(value: unknown): TwitchGqlResponse<T> | null {
  if (Array.isArray(value)) {
    return value.length === 1 ? (value[0] as TwitchGqlResponse<T> | null) : null;
  }
  return value as TwitchGqlResponse<T> | null;
}

function isTransientGqlError(message: string | undefined): boolean {
  return message === "service error"
    || message === "service timeout"
    || message === "service unavailable"
    || message === "context deadline exceeded";
}

function hasPersistedQueryNotFound<T>(response: TwitchGqlResponse<T>): boolean {
  return response.errors?.some((error) => error.message === "PersistedQueryNotFound") ?? false;
}

function parseLiveState(html: string): boolean {
  if (/["']isLiveBroadcast["']\s*:\s*true/i.test(html)) return true;
  if (/["']stream["']\s*:\s*null/i.test(html)) return false;
  if (/isLiveBroadcast/i.test(html) || /DropsEnabled/i.test(html)) return true;
  // No detectable live signal in the page. Treat as offline rather than
  // assuming live: if Twitch's page markup drifts so no marker matches, a
  // default of `true` would silently stall the scheduler on an offline channel
  // (offlineChecks never increments). Reporting offline instead self-heals —
  // the scheduler re-selects and re-checks via GQL, which usually recovers.
  return false;
}

function parseGameId(html: string): string | undefined {
  const gameObject = html.match(/["']game["']\s*:\s*\{[^{}]*["']id["']\s*:\s*["']([^"']+)["']/i);
  if (gameObject?.[1]) return gameObject[1];
  const gameId = html.match(/["']gameID["']\s*:\s*["']([^"']+)["']/i);
  return gameId?.[1];
}
