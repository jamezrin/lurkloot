import type { CategorySelection, ChannelCandidate, ChannelCheck, DropCampaign, DropReward, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { TablessWatchController } from "../../core/tablessWatch";
import { KickWafBlockedError } from "../../core/tabs";
import { diagnostic, ignoreEvent, unavailableWatchTabPort, type PageFetcher, type PlatformAdapter, type WatchTabOptions, type WatchTabPort } from "../adapter";
import { kickCandidatesFromCampaign, mergeKickProgress, parseKickCampaigns } from "./parser";
import { KICK_CLIENT_TOKEN, KickWatcher, type WebSocketFactory } from "./watch";
import type { ResolvedCompatibility } from "../../compatibility/types";
import { createKickClaimCapability } from "./claim/factory";
import type { KickClaimCapability } from "./claim/types";
import { safeHttpsUrl } from "./claim/types";

export { createKickClaimCapability } from "./claim/factory";
export type { KickClaimCapability, KickClaimOutcome } from "./claim/types";

export interface KickAdapterOptions {
  // Resolved metadata is injected by the host. It is intentionally not used to
  // switch request behavior until the versioned implementations land.
  compatibility?: ResolvedCompatibility["kick"];
}

interface KickLivestreamsResponse {
  data?: Array<KickLivestream> | { livestreams?: KickLivestream[] };
}

interface KickLivestream {
    slug?: string;
    channel?: { slug?: string; username?: string };
    category?: { id?: string | number; name?: string };
    viewer_count?: number;
    // The livestreams endpoint names the stream title `title`; channel-v2 uses
    // `session_title`. Accept both so candidate titles populate either way.
    title?: string;
    session_title?: string;
}

interface KickChannelResponse {
  id?: string | number;
  livestream?: {
    id?: string | number;
    is_live?: boolean;
    category?: { id?: string | number; name?: string };
    categories?: Array<{ id?: string | number; name?: string }>;
    viewer_count?: number;
    session_title?: string;
  } | null;
}

interface KickClaimResponse {
  success?: boolean;
  message?: string;
  data?: { id?: string | number } | null;
}

// Default Kick fetcher. Spike: try the service worker first (fully tabless) and
// fall back to a retained kick.com page-context tab if Kick's WAF rejects the
// extension origin. The outcome is logged once per host (then debug) so a
// real-Chrome run shows exactly which calls are tabless-capable. The fallback
// makes this risk-free: farming behaves as before regardless of the result.
export function createKickFetcher(deps: {
  background: (url: string, init?: RequestInit) => Promise<unknown>;
  pageFetch: (url: string, init?: RequestInit) => Promise<unknown>;
}): PageFetcher {
  const { background, pageFetch } = deps;
  const announced = new Map<string, "background" | "fallback">();
  const report = (emit: EventEmitter, host: string, outcome: "background" | "fallback", detail: string): void => {
    const repeat = announced.get(host) === outcome;
    announced.set(host, outcome);
    diagnostic(emit, repeat ? "debug" : "info", `Kick fetch ${host} ${detail}`, "kick");
  };
  return {
    fetchJson: async <T,>(url: string, init?: RequestInit, emit: EventEmitter = ignoreEvent): Promise<T> => {
      const host = safeHost(url);
      try {
        const result = await background(url, init);
        report(emit, host, "background", "→ service worker OK (tabless-capable)");
        return result as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report(emit, host, "fallback", error instanceof KickWafBlockedError
          ? `→ WAF-blocked from service worker, using page tab (${message})`
          : `→ service worker error, using page tab (${message})`);
        return await pageFetch(url, init) as T;
      }
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Parses the `categories[]` array from Kick's `/api/search` response. Each entry
// is a game/subcategory `{id, name, slug, banner:{src,srcset}}`; its `id` matches
// the campaign categoryId used by the scheduler. Deduped by id; entries without
// an id or name are skipped.
function parseKickCategories(data: unknown): CategorySelection[] {
  const root = (data ?? {}) as Record<string, unknown>;
  const raw = (Array.isArray(root.categories) ? root.categories : []) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const result: CategorySelection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "").trim();
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const key = id.toLowerCase();
    if (!id || !name || seen.has(key)) continue;
    seen.add(key);
    const imageUrl = kickCategoryImage(entry.banner) ?? (typeof entry.image_url === "string" ? entry.image_url : undefined);
    result.push(imageUrl ? { id, name, imageUrl } : { id, name });
  }
  return result;
}

function kickCategoryImage(banner: unknown): string | undefined {
  const src = (banner as { src?: unknown } | undefined)?.src;
  return typeof src === "string" && src ? src : undefined;
}

export class KickAdapter implements PlatformAdapter {
  platform = "kick" as const;
  readonly compatibility?: ResolvedCompatibility["kick"];
  private readonly claimCapability: KickClaimCapability;

  constructor(
    private readonly fetcher: PageFetcher,
    // Tab-based watch is browser-bound, so it is injected (see WatchTabPort).
    private readonly watchTabPort: WatchTabPort = unavailableWatchTabPort,
    // Optional factory for the tabless viewer WebSocket. The extension leaves it
    // unset (the watcher uses the platform WebSocket from the service worker); a
    // headless runtime injects one that rides its impersonated session so the
    // handshake clears Kick's WAF.
    private readonly webSocketFactory?: WebSocketFactory,
    private readonly emit: EventEmitter = ignoreEvent,
    options: KickAdapterOptions = {},
  ) {
    this.compatibility = options.compatibility;
    // Compatibility-based selection is wired in Task 4. Until then, use the
    // recommended response-aware policy rather than duplicating claim logic.
    this.claimCapability = createKickClaimCapability("kick-claim-v2");
  }

  async discoverCampaigns(): Promise<DropCampaign[]> {
    const data = await this.fetcher.fetchJson<unknown>("https://web.kick.com/api/v1/drops/campaigns", undefined, this.emit);
    return parseKickCampaigns(data as Parameters<typeof parseKickCampaigns>[0]);
  }

  async readProgress(campaigns: DropCampaign[]): Promise<DropCampaign[]> {
    try {
      // Kick's WAF rejects authed drops endpoints that omit X-Client-Token with
      // "Request blocked by security policy." — the reference sends it on
      // /drops/progress and /drops/claim (references/kickautodrops/core/kick.py:
      // 131, 67). pageFetchJson adds the Bearer from session_token on top.
      const data = await this.fetcher.fetchJson<unknown>("https://web.kick.com/api/v1/drops/progress", {
        headers: { "X-Client-Token": KICK_CLIENT_TOKEN },
      }, this.emit);
      const progress = mergeKickProgress(campaigns, data as Parameters<typeof mergeKickProgress>[1]);
      return this.claimCapability.reconcileProgress?.(progress, affirmativelyLinkedCampaignIds(data)) ?? progress;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(this.emit, "warn", `Could not read Kick drop progress; using last-known progress: ${message}`, "kick");
      return campaigns;
    }
  }

  async searchCategories(query: string): Promise<CategorySelection[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Confirmed live (scripts/kick-inspect.mjs --categories): this is the endpoint
    // Kick's own search box uses, and its `categories[]` ids match campaign
    // categoryIds (e.g. Rust = 13). search.kick.com is the newer variant but needs
    // a Typesense key; this one is plain and works from the SW/page fetcher.
    const url = new URL("https://kick.com/api/search");
    url.searchParams.set("searched_word", trimmed);
    const data = await this.fetcher.fetchJson<unknown>(url.toString(), undefined, this.emit);
    return parseKickCategories(data);
  }

  async listCandidateChannels(campaign: DropCampaign): Promise<ChannelCandidate[]> {
    const aclCandidates = kickCandidatesFromCampaign(campaign);
    if (aclCandidates.length > 0) return aclCandidates;

    const url = new URL("https://web.kick.com/api/v1/livestreams");
    url.searchParams.set("limit", "25");
    url.searchParams.set("sort", "viewer_count_desc");
    if (campaign.categoryId) url.searchParams.set("category_id", campaign.categoryId);

    const response = await this.fetcher.fetchJson<KickLivestreamsResponse>(url.toString(), undefined, this.emit);
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
        title: stream.title ?? stream.session_title,
        live: true,
      };
    }).filter((candidate) => Boolean(candidate.username));
  }

  async checkChannel(channel: ChannelCandidate, campaign?: DropCampaign): Promise<ChannelCheck> {
    try {
      const data = await this.fetcher.fetchJson<KickChannelResponse>(
        `https://kick.com/api/v2/channels/${encodeURIComponent(channel.username)}`,
        undefined,
        this.emit,
      );
      const livestream = data.livestream;
      // Kick now returns a `categories` array; keep `category` as a fallback.
      const category = livestream?.categories?.[0] ?? livestream?.category;
      const actualCategoryId = category?.id == null ? undefined : String(category.id);
      const expectedCategoryId = campaign ? campaign.categoryId : channel.categoryId;
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
          channelId: data.id == null ? channel.channelId : String(data.id),
          broadcastId: livestream?.id == null ? channel.broadcastId : String(livestream.id),
        },
      };
    } catch (error) {
      return this.checkChannelFromPage(channel, campaign, error);
    }
  }

  async claimReward(campaign: DropCampaign, reward: DropReward): Promise<boolean> {
    if (!reward.claimId && reward.status !== "claimable") return false;
    if (this.claimCapability.isSuppressed?.(campaign, reward)) return false;
    // JSON.stringify drops `undefined`, so when no claim id was carried by
    // /drops/progress this matches the reference's `{ campaign_id, reward_id }`
    // payload exactly (references/kickautodrops/core/kick.py:48-52); `claim_id`
    // is only sent when Kick itself returned one. The live claim cannot be
    // exercised until campaigns launch — the raw response is logged below so we
    // can confirm the shape on day one.
    try {
      const response = await this.fetcher.fetchJson<KickClaimResponse>(
        "https://web.kick.com/api/v1/drops/claim",
        {
          method: "POST",
          // Verified working end-to-end: once the Kick account is linked, this
          // claims the reward. The session Bearer (added by pageFetchJson)
          // authorizes it; the captured "Pedir" request confirmed the payload is
          // just {campaign_id, reward_id} and that an unlinked account fails with
          // a 400 INVALID_CLAIM (not an auth error). X-Client-Token is harmless.
          headers: { "content-type": "application/json", "X-Client-Token": KICK_CLIENT_TOKEN },
          body: JSON.stringify({
            campaign_id: campaign.id,
            reward_id: reward.id,
            claim_id: reward.claimId,
          }),
        },
        this.emit,
      );
      const outcome = this.claimCapability.classify(response, campaign);
      if (outcome.kind === "claimed") return true;
      if (outcome.kind === "link_required") {
        this.claimCapability.suppress?.(campaign, reward, outcome.url);
        this.warnAccountNotLinked(campaign, reward, outcome.url);
      }
      return false;
    } catch (error) {
      // Kick accrues watch progress before the account is linked, but rejects
      // the claim until you connect the org account. Turn that into actionable
      // guidance instead of a raw error, and swallow it so the scheduler does
      // not back the whole platform off over an unlinked campaign.
      if (campaign.accountLinked === false) {
        const outcome = this.claimCapability.classify(undefined, campaign);
        if (outcome.kind === "link_required") {
          this.claimCapability.suppress?.(campaign, reward, outcome.url);
          this.warnAccountNotLinked(campaign, reward, outcome.url);
        } else {
          this.warnAccountNotLinked(campaign, reward);
        }
        return false;
      }
      throw error;
    }
  }

  private warnAccountNotLinked(campaign: DropCampaign, reward: DropReward, responseUrl?: string): void {
    const url = responseUrl ?? safeHttpsUrl(campaign.accountLinkUrl);
    const where = url ? ` at ${url}` : campaign.name ? ` for ${campaign.name}` : "";
    diagnostic(this.emit, "warn", `Cannot claim "${reward.name}" yet — link your Kick account${where} to claim this campaign's drops.`, "kick");
  }

  prepareWatchTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>) {
    return this.watchTabPort.openPinnedMutedTab(channel, session, options);
  }

  stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
    return this.watchTabPort.stopWatchTab(session, options);
  }

  // Tabless farming via Kick's viewer WebSocket (see KickWatcher). Reuses this
  // adapter's in-page fetcher for the token exchange and channel lookups.
  supportsTabless = true;

  createTablessWatcher(): TablessWatchController {
    return new KickWatcher({
      fetcher: this.fetcher,
      createWebSocket: this.webSocketFactory,
    });
  }

  private async checkChannelFromPage(
    channel: ChannelCandidate,
    campaign: DropCampaign | undefined,
    originalError: unknown,
  ): Promise<ChannelCheck> {
    const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
    diagnostic(this.emit, "debug", `Kick API channel check failed for ${channel.username}, falling back to the channel page: ${originalMessage}`, "kick");
    try {
      const page = await this.fetcher.fetchJson<{ html?: string }>(channel.url, undefined, this.emit);
      const html = page.html ?? "";
      const live = parseBooleanField(html, ["is_live", "isLive", "live"]) ?? html.includes("livestream");
      const actualCategoryId = parseCategoryId(html);
      const expectedCategoryId = campaign ? campaign.categoryId : channel.categoryId;
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
        live: false,
        categoryMatches: false,
        reason: originalError instanceof Error ? originalError.message : "Kick channel check failed",
        candidate: channel,
      };
    }
  }
}

function affirmativelyLinkedCampaignIds(input: unknown): Set<string> {
  const root = input != null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const buckets = [root.data, root.progress, root.campaigns, root.active, root.current, root.completed];
  if (root.data != null && typeof root.data === "object" && !Array.isArray(root.data)) {
    const data = root.data as Record<string, unknown>;
    buckets.push(data.progress, data.campaigns, data.active, data.current, data.completed);
  }
  const ids = new Set<string>();
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const progress = entry as Record<string, unknown>;
      if (progress.user_app_connected !== true) continue;
      const id = progress.campaign_id ?? progress.drop_campaign_id ?? progress.id;
      if (id != null) ids.add(String(id));
    }
  }
  return ids;
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
