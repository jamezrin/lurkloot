import type { ChannelCandidate, ChannelCheck, DropCampaign, DropReward, WatchSession } from "../core/models";
import { fetchJsonInPage, openPinnedMutedTab, stopWatchTab } from "../core/tabs";
import type { PageFetcher, PlatformAdapter, WatchTabOptions } from "./adapter";
import { kickCandidatesFromCampaign, mergeKickProgress, parseKickCampaigns } from "./kickParser";

interface KickLivestreamsResponse {
  data?: Array<KickLivestream> | { livestreams?: KickLivestream[] };
}

interface KickLivestream {
    slug?: string;
    channel?: { slug?: string; username?: string };
    category?: { id?: string | number; name?: string };
    viewer_count?: number;
    session_title?: string;
}

interface KickChannelResponse {
  livestream?: {
    is_live?: boolean;
    category?: { id?: string | number; name?: string };
    categories?: Array<{ id?: string | number; name?: string }>;
    viewer_count?: number;
    session_title?: string;
  } | null;
}

export class KickAdapter implements PlatformAdapter {
  platform = "kick" as const;

  constructor(
    private readonly fetcher: PageFetcher = {
      fetchJson: (url, init) => fetchJsonInPage("https://kick.com", url, init),
    },
  ) {}

  async discoverCampaigns(): Promise<DropCampaign[]> {
    const data = await this.fetcher.fetchJson<unknown>("https://web.kick.com/api/v1/drops/campaigns");
    return parseKickCampaigns(data as Parameters<typeof parseKickCampaigns>[0]);
  }

  async readProgress(campaigns: DropCampaign[]): Promise<DropCampaign[]> {
    try {
      const data = await this.fetcher.fetchJson<unknown>("https://web.kick.com/api/v1/drops/progress");
      return mergeKickProgress(campaigns, data as Parameters<typeof mergeKickProgress>[1]);
    } catch {
      return campaigns;
    }
  }

  async listCandidateChannels(campaign: DropCampaign): Promise<ChannelCandidate[]> {
    const aclCandidates = kickCandidatesFromCampaign(campaign);
    if (aclCandidates.length > 0) return aclCandidates;
    if (!campaign.categoryId) return [];

    const url = new URL("https://web.kick.com/api/v1/livestreams");
    url.searchParams.set("limit", "25");
    url.searchParams.set("sort", "viewer_count");
    url.searchParams.set("category_id", campaign.categoryId);

    const response = await this.fetcher.fetchJson<KickLivestreamsResponse>(url.toString());
    const streams = Array.isArray(response.data) ? response.data : response.data?.livestreams ?? [];
    return streams.map((stream): ChannelCandidate => {
      const username = stream.channel?.slug ?? stream.channel?.username ?? stream.slug ?? "";
      return {
        platform: "kick",
        username,
        displayName: username,
        url: `https://kick.com/${username}`,
        campaignId: campaign.id,
        categoryId: stream.category?.id == null ? campaign.categoryId : String(stream.category.id),
        categoryName: stream.category?.name,
        isAclMatch: false,
        viewerCount: stream.viewer_count,
        title: stream.session_title,
        live: true,
      };
    }).filter((candidate) => Boolean(candidate.username));
  }

  async checkChannel(channel: ChannelCandidate, campaign?: DropCampaign): Promise<ChannelCheck> {
    try {
      const data = await this.fetcher.fetchJson<KickChannelResponse>(
        `https://kick.com/api/v2/channels/${encodeURIComponent(channel.username)}`,
      );
      const livestream = data.livestream;
      // Kick now returns a `categories` array; keep `category` as a fallback.
      const category = livestream?.categories?.[0] ?? livestream?.category;
      const actualCategoryId = category?.id == null ? undefined : String(category.id);
      const expectedCategoryId = campaign?.categoryId ?? channel.categoryId;
      return {
        live: Boolean(livestream?.is_live ?? livestream),
        categoryMatches: !expectedCategoryId || actualCategoryId === expectedCategoryId,
        reason: livestream ? undefined : "Kick channel is offline",
        candidate: {
          ...channel,
          categoryId: actualCategoryId ?? channel.categoryId,
          categoryName: category?.name ?? channel.categoryName,
          viewerCount: livestream?.viewer_count ?? channel.viewerCount,
          title: livestream?.session_title ?? channel.title,
        },
      };
    } catch (error) {
      return this.checkChannelFromPage(channel, campaign, error);
    }
  }

  async claimReward(campaign: DropCampaign, reward: DropReward): Promise<boolean> {
    if (!reward.claimId && reward.status !== "claimable") return false;
    const response = await this.fetcher.fetchJson<{ success?: boolean }>(
      "https://web.kick.com/api/v1/drops/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaign.id,
          reward_id: reward.id,
          claim_id: reward.claimId,
        }),
      },
    );
    return response.success !== false;
  }

  prepareWatchTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>) {
    return openPinnedMutedTab(channel, session, options);
  }

  stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
    return stopWatchTab(session, options);
  }

  private async checkChannelFromPage(
    channel: ChannelCandidate,
    campaign: DropCampaign | undefined,
    originalError: unknown,
  ): Promise<ChannelCheck> {
    try {
      const page = await this.fetcher.fetchJson<{ html?: string }>(channel.url);
      const html = page.html ?? "";
      const live = parseBooleanField(html, ["is_live", "isLive", "live"]) ?? html.includes("livestream");
      const actualCategoryId = parseCategoryId(html);
      const expectedCategoryId = campaign?.categoryId ?? channel.categoryId;
      return {
        live,
        categoryMatches: !expectedCategoryId || actualCategoryId == null || actualCategoryId === expectedCategoryId,
        reason: "Kick API check failed; used channel page fallback",
        candidate: {
          ...channel,
          categoryId: actualCategoryId ?? channel.categoryId,
        },
      };
    } catch {
      return {
        live: true,
        categoryMatches: true,
        reason: originalError instanceof Error ? originalError.message : "Kick channel check failed",
        candidate: channel,
      };
    }
  }
}

function parseBooleanField(html: string, names: string[]): boolean | undefined {
  for (const name of names) {
    const match = html.match(new RegExp(`["']${name}["']\\s*:\\s*(true|false)`, "i"));
    if (match?.[1]) return match[1].toLowerCase() === "true";
  }
  return undefined;
}

function parseCategoryId(html: string): string | undefined {
  const categoryObject = html.match(/["']category["']\s*:\s*\{[^{}]*["']id["']\s*:\s*["']?([^"',}]+)["']?/i);
  if (categoryObject?.[1]) return categoryObject[1];
  const categoryId = html.match(/["']category_id["']\s*:\s*["']?([^"',}]+)["']?/i);
  return categoryId?.[1];
}
