import { describe, expect, it, vi } from "vitest";
import type { PageFetcher } from "../src/platforms/adapter";
import { KickAdapter } from "../src/platforms/kick";
import { TwitchAdapter } from "../src/platforms/twitch";
import type { DropCampaign, DropReward, ExtensionSettings } from "../src/core/models";
import { chooseCampaignDecision } from "../src/core/scheduler";
import { DEFAULT_SETTINGS } from "../src/core/settings";

function jsonFetcher(handler: (url: string, init?: RequestInit) => unknown): PageFetcher {
  const fetchJson = vi.fn(async (url: string, init?: RequestInit): Promise<unknown> => handler(url, init));
  return {
    fetchJson: fetchJson as PageFetcher["fetchJson"],
  };
}

function operation(init?: RequestInit): string {
  return JSON.parse(String(init?.body)).operationName;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("KickAdapter", () => {
  it("discovers campaigns, merges nested progress, and lists category streams", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/campaigns") {
        return {
          data: [{
            id: 1,
            name: "Kick Campaign",
            status: "active",
            category: { id: 99, name: "Game" },
            rewards: [{ id: 10, name: "Reward", required_minutes: 60 }],
          }],
        };
      }
      if (url === "https://web.kick.com/api/v1/drops/progress") {
        return {
          data: [{
            id: 1,
            status: "in progress",
            rewards: [{ id: 10, progress: 0.5, required_units: 60 }],
          }],
        };
      }
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        const params = new URL(url).searchParams;
        expect(params.get("sort")).toBe("viewer_count_desc");
        expect(params.get("category_id")).toBe("99");
        return {
          data: {
            livestreams: [{
              channel: { slug: "creator" },
              category: { id: 99, name: "Game" },
              viewer_count: 123,
              session_title: "Drops",
            }],
          },
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);

    const campaigns = await adapter.readProgress(await adapter.discoverCampaigns());
    const candidates = await adapter.listCandidateChannels(campaigns[0]);

    expect(campaigns[0].rewards[0].watchedMinutes).toBe(30);
    expect(campaigns[0].rewards[0].status).toBe("in_progress");
    expect(candidates[0]).toMatchObject({ username: "creator", viewerCount: 123, title: "Drops" });
  });

  it("lists general live streams for site-wide Kick campaigns", async () => {
    let requestedUrl = "";
    const fetcher = jsonFetcher((url) => {
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        requestedUrl = url;
        return {
          data: {
            livestreams: [{
              channel: { slug: "anyone-live" },
              category: { id: 77, name: "Any Game" },
              viewer_count: 321,
              session_title: "Site-wide drops",
            }],
          },
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);

    const candidates = await adapter.listCandidateChannels({
      id: "site-wide",
      platform: "kick",
      name: "Site-wide Drop",
      status: "active",
      rewards: [],
      isGeneralDrop: true,
    });

    expect(new URL(requestedUrl).searchParams.has("category_id")).toBe(false);
    expect(candidates[0]).toMatchObject({
      username: "anyone-live",
      categoryId: "77",
      categoryName: "Any Game",
      viewerCount: 321,
    });
  });

  it("can select a site-wide Kick campaign candidate without enforcing a category", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        return { data: { livestreams: [{ channel: { slug: "creator" }, category: { id: 7, name: "Game" } }] } };
      }
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { id: 10, livestream: { id: 20, is_live: true, categories: [{ id: 8, name: "Different Game" }] } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);
    const settings: ExtensionSettings = {
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    };

    const decision = await chooseCampaignDecision(
      "kick",
      [{
        id: "site-wide",
        platform: "kick",
        name: "Site-wide Drop",
        status: "active",
        rewards: [{ id: "reward", name: "Reward", requiredMinutes: 30, watchedMinutes: 0, status: "locked" }],
        isGeneralDrop: true,
      }],
      settings,
      adapter,
    );

    expect(decision.action).toBe("watch");
    expect(decision.channel).toMatchObject({ username: "creator", categoryId: "8", categoryName: "Different Game" });
  });

  it("still enforces category matching for category-specific Kick campaigns", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url.startsWith("https://web.kick.com/api/v1/livestreams")) {
        return { data: { livestreams: [{ channel: { slug: "creator" }, category: { id: 99, name: "Expected Game" } }] } };
      }
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { id: 10, livestream: { id: 20, is_live: true, categories: [{ id: 100, name: "Wrong Game" }] } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);

    const decision = await chooseCampaignDecision(
      "kick",
      [{
        id: "category-drop",
        platform: "kick",
        name: "Category Drop",
        status: "active",
        categoryId: "99",
        rewards: [{ id: "reward", name: "Reward", requiredMinutes: 30, watchedMinutes: 0, status: "locked" }],
        isGeneralDrop: true,
      }],
      { ...DEFAULT_SETTINGS, running: true },
      adapter,
    );

    expect(decision.action).toBe("idle");
  });

  it("checks channel category and claims rewards through the page-context API", async () => {
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { livestream: { is_live: true, category: { id: 99, name: "Game" }, viewer_count: 456, session_title: "Live now" } };
      }
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({ campaign_id: "campaign", reward_id: "reward" });
        return { success: true };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);
    const campaign = { id: "campaign", categoryId: "99" } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    await expect(adapter.checkChannel({ platform: "kick", username: "creator", url: "https://kick.com/creator" }, campaign))
      .resolves.toMatchObject({
        live: true,
        categoryMatches: true,
        candidate: { categoryId: "99", categoryName: "Game", viewerCount: 456, title: "Live now" },
      });
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(true);
  });

  it("treats a Kick claim as successful only on a positive response signal", async () => {
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;
    const claimWith = (body: unknown) => new KickAdapter(jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") return body;
      throw new Error(`Unexpected URL ${url}`);
    })).claimReward(campaign, reward);

    await expect(claimWith({ message: "Success", data: { id: 1 } })).resolves.toBe(true);
    await expect(claimWith({ success: true })).resolves.toBe(true);
    // HTTP 200 with a non-success body must not be reported as a claim.
    await expect(claimWith({ message: "Reward not available", data: null })).resolves.toBe(false);
    await expect(claimWith({})).resolves.toBe(false);
  });

  it("reads category and viewer count from the new `categories` array shape", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        return { livestream: { is_live: true, categories: [{ id: 13, name: "Rust" }], viewer_count: 164, session_title: "Live" } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const check = await new KickAdapter(fetcher).checkChannel({ platform: "kick", username: "creator", url: "https://kick.com/creator" });
    expect(check.live).toBe(true);
    expect(check.candidate.viewerCount).toBe(164);
    expect(check.candidate.categoryName).toBe("Rust");
  });

  it("falls back to Kick channel page data when the channel API fails", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        throw new Error("Kick API unavailable");
      }
      if (url === "https://kick.com/creator") {
        return { html: '{"livestream":{"is_live":true,"category":{"id":99,"name":"Game"}}}' };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "kick", username: "creator", url: "https://kick.com/creator" },
      { categoryId: "99" } as DropCampaign,
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      reason: "Kick API check failed; used channel page fallback",
      candidate: { categoryId: "99" },
    });
  });

  it("treats Kick channel validation as invalid when API and page fallback both fail", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        throw new Error("Kick API unavailable");
      }
      if (url === "https://kick.com/creator") {
        throw new Error("Kick page unavailable");
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "kick", username: "creator", url: "https://kick.com/creator" },
      { categoryId: "99" } as DropCampaign,
    )).resolves.toMatchObject({
      live: false,
      categoryMatches: false,
      reason: "Kick API unavailable",
    });
  });
});

describe("TwitchAdapter", () => {
  it("discovers active dashboard campaigns through detail GQL and merges inventory progress", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        expect(requestBody(init).variables).toMatchObject({ fetchRewardCampaigns: false });
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 60, dropInstanceID: "claim", isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        expect(requestBody(init).variables).toMatchObject({ fetchRewardCampaigns: false });
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "campaign", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        expect(requestBody(init).variables).toMatchObject({ channelLogin: "user-id", dropID: "campaign" });
        return {
          data: {
            dropCampaign: {
              id: "campaign",
              name: "Twitch Campaign",
              game: { id: "game", slug: "game-slug", displayName: "Game" },
              timeBasedDrops: [{
                id: "drop",
                requiredMinutesWatched: 60,
                benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
              }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    const campaigns = await adapter.discoverCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Twitch Campaign", isGeneralDrop: true });
    expect(campaigns[0].rewards[0]).toMatchObject({ status: "claimable", claimId: "claim" });
  });

  it("falls back to inventory campaigns when Twitch campaign details hash is stale", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Inventory Campaign",
                  game: { id: "game", slug: "game-slug", displayName: "Game" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 20, dropInstanceID: "claim", isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              login: "viewer",
              dropCampaigns: [{ id: "campaign", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inventory Campaign", status: "active" });
    expect(campaigns[0].rewards[0]).toMatchObject({ watchedMinutes: 20, status: "in_progress", claimId: "claim" });
  });

  it("keeps Twitch inventory campaigns when the dashboard query returns an empty response", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Inventory Campaign",
                  game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 30,
                    benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") return null;
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inventory Campaign", eligibility: "eligible" });
  });

  it("marks in-progress inventory campaigns the dashboard no longer lists active as expired", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [
                  {
                    id: "active",
                    name: "Active Campaign",
                    timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
                  },
                  {
                    id: "ended",
                    name: "Ended Campaign",
                    timeBasedDrops: [{ id: "ended-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
                  },
                ],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "active", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return {
          data: {
            dropCampaign: {
              id: "active",
              name: "Active Campaign",
              timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, benefitEdges: [{ benefit: { id: "b", name: "Reward" } }] }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(campaigns.find((campaign) => campaign.id === "active")).toMatchObject({ status: "active", eligibility: "eligible" });
    expect(campaigns.find((campaign) => campaign.id === "ended")).toMatchObject({ status: "expired", eligibility: "expired" });
  });

  it("keeps an ended inventory campaign visible while it still has a claimable reward", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [
                  {
                    id: "active",
                    name: "Active Campaign",
                    timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
                  },
                  {
                    id: "ended",
                    name: "Ended Campaign",
                    timeBasedDrops: [{ id: "ended-drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 60, dropInstanceID: "claim" } }],
                  },
                ],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "active", status: "ACTIVE", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return {
          data: {
            dropCampaign: {
              id: "active",
              name: "Active Campaign",
              timeBasedDrops: [{ id: "active-drop", requiredMinutesWatched: 60, benefitEdges: [{ benefit: { id: "b", name: "Reward" } }] }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    const ended = campaigns.find((campaign) => campaign.id === "ended");
    expect(ended).toMatchObject({ status: "active", eligibility: "eligible" });
    expect(ended?.rewards[0]).toMatchObject({ status: "claimable" });
  });

  it("uses the inventory user id for Twitch details and keeps unlinked campaigns visible", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return { data: { currentUser: { id: "numeric-user-id", inventory: { dropCampaignsInProgress: [] } } } };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              login: "viewer-login",
              dropCampaigns: [{ id: "campaign", status: "ACTIVE", self: { isAccountConnected: false } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        expect(requestBody(init).variables).toMatchObject({ channelLogin: "numeric-user-id", dropID: "campaign" });
        return {
          data: {
            user: {
              dropCampaign: {
                id: "campaign",
                name: "Unlinked Campaign",
                status: "ACTIVE",
                accountLinkURL: "https://link",
                self: { isAccountConnected: false },
                game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                timeBasedDrops: [{
                  id: "drop",
                  requiredMinutesWatched: 30,
                  benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(campaigns[0]).toMatchObject({
      id: "campaign",
      accountLinked: false,
      eligibility: "account_not_linked",
    });
  });

  it("retries Twitch campaign discovery with reward campaign variables when default responses are empty", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      const variables = requestBody(init).variables as { fetchRewardCampaigns?: boolean; dropID?: string };
      if (op === "Inventory") {
        return variables.fetchRewardCampaigns
          ? { data: { currentUser: { id: "user-id", inventory: { dropCampaignsInProgress: [] } } } }
          : { data: { currentUser: { inventory: { dropCampaignsInProgress: [] } } } };
      }
      if (op === "ViewerDropsDashboard") {
        return variables.fetchRewardCampaigns
          ? { data: { currentUser: { dropCampaigns: [{ id: "campaign", status: "ACTIVE" }] } } }
          : { data: { currentUser: { dropCampaigns: [] } } };
      }
      if (op === "DropCampaignDetails") {
        expect(variables.dropID).toBe("campaign");
        return {
          data: {
            dropCampaign: {
              id: "campaign",
              name: "Fallback Campaign",
              status: "ACTIVE",
              game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
              timeBasedDrops: [{
                id: "drop",
                requiredMinutesWatched: 30,
                benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
              }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Fallback Campaign", eligibility: "eligible" });
  });

  it("discovers upcoming Twitch dashboard campaigns without making them farmable", async () => {
    const startsAt = "2999-01-01T00:00:00.000Z";
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return { data: { currentUser: { inventory: { dropCampaignsInProgress: [] } } } };
      }
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              login: "viewer",
              dropCampaigns: [{ id: "future", status: "UPCOMING", self: { isAccountConnected: true } }],
            },
          },
        };
      }
      if (op === "DropCampaignDetails") {
        return {
          data: {
            user: {
              dropCampaign: {
                id: "future",
                name: "Future Campaign",
                status: "UPCOMING",
                startAt: startsAt,
                endAt: "2999-01-02T00:00:00.000Z",
                game: { id: "game", slug: "game-slug", displayName: "Game" },
                timeBasedDrops: [{
                  id: "drop",
                  startAt: startsAt,
                  endAt: "2999-01-02T00:00:00.000Z",
                  requiredMinutesWatched: 30,
                  benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(campaigns[0]).toMatchObject({
      id: "future",
      status: "upcoming",
      eligibility: "upcoming",
    });
  });

  it("retries transient GQL failures once", async () => {
    let attempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      attempts += 1;
      const op = operation(init);
      if (op === "ChannelPointsContext" && attempts === 1) {
        return { errors: [{ message: "service unavailable" }] };
      }
      if (op === "ChannelPointsContext") {
        return {
          data: {
            community: {
              channel: {
                id: "channel-id",
                self: { communityPoints: { availableClaim: { id: "claim-id" } } },
              },
            },
          },
        };
      }
      if (op === "ClaimCommunityPoints") {
        return { data: { claimCommunityPoints: { status: "CLAIMED" } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
      .resolves.toBe(true);
    expect(attempts).toBe(3);
  });

  it("unwraps array-wrapped Twitch GQL responses from the batched endpoint", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        // Twitch answers with a one-entry array even for a single operation.
        return [{
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Array Campaign",
                  game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 30,
                    benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                  }],
                }],
              },
            },
          },
        }];
      }
      if (op === "ViewerDropsDashboard") return [null];
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Array Campaign", eligibility: "eligible" });
  });

  it("retries PersistedQueryNotFound from an array-wrapped Twitch GQL response with an inline query", async () => {
    let inventoryAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        inventoryAttempts += 1;
        if (inventoryAttempts === 1) {
          expect(requestBody(init).query).toBeUndefined();
          return [{ errors: [{ message: "PersistedQueryNotFound" }] }];
        }
        expect(String(requestBody(init).query)).toContain("dropCampaignsInProgress");
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  name: "Inline Campaign",
                  game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 30,
                    benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "ViewerDropsDashboard") return [null];
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(inventoryAttempts).toBe(2);
    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inline Campaign", eligibility: "eligible" });
  });

  it("does not use inline fallback for non-persisted-query Twitch errors", async () => {
    let inventoryAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        inventoryAttempts += 1;
        return [{ errors: [{ message: "permission denied" }] }];
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(new TwitchAdapter(fetcher).discoverCampaigns()).rejects.toThrow("permission denied");
    expect(inventoryAttempts).toBe(1);
  });

  it("retries channel points context with an inline query when the persisted hash is stale", async () => {
    let contextAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "ChannelPointsContext") {
        contextAttempts += 1;
        if (contextAttempts === 1) return { errors: [{ message: "PersistedQueryNotFound" }] };
        expect(String(requestBody(init).query)).toContain("availableClaim");
        return {
          data: {
            community: {
              channel: {
                id: "channel-id",
                self: { communityPoints: { availableClaim: { id: "claim-id" } } },
              },
            },
          },
        };
      }
      if (op === "ClaimCommunityPoints") {
        return { data: { claimCommunityPoints: { status: "CLAIMED" } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(new TwitchAdapter(fetcher).claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
      .resolves.toBe(true);
    expect(contextAttempts).toBe(2);
  });

  it("uses the TwitchDropsMiner-proven persisted hash for the Inventory query", async () => {
    let inventoryHash: string | undefined;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        inventoryHash = (requestBody(init).extensions as { persistedQuery?: { sha256Hash?: string } })
          ?.persistedQuery?.sha256Hash;
        return { data: { currentUser: { id: "user-id", inventory: { dropCampaignsInProgress: [] } } } };
      }
      if (op === "ViewerDropsDashboard") return { data: { currentUser: { dropCampaigns: [] } } };
      throw new Error(`Unexpected op ${op}`);
    });

    await new TwitchAdapter(fetcher).discoverCampaigns();

    expect(inventoryHash).toBe("d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b");
  });

  it("surfaces Twitch's top-level {error,message} auth failures", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "Inventory") return { error: "Unauthorized", message: "invalid OAuth token" };
      throw new Error(`Unexpected op ${operation(init)}`);
    });

    await expect(new TwitchAdapter(fetcher).discoverCampaigns())
      .rejects.toThrow("Unauthorized: invalid OAuth token");
  });

  it("reports unusable array-wrapped Twitch GQL responses as empty", async () => {
    for (const empty of [[], [null]] as const) {
      const adapter = new TwitchAdapter(jsonFetcher((_url, init) => {
        if (operation(init) === "ChannelPointsContext") return empty;
        throw new Error(`Unexpected op ${operation(init)}`);
      }));

      await expect(adapter.claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
        .rejects.toThrow("ChannelPointsContext persisted query returned an empty Twitch GQL response");
    }
  });

  it("surfaces the page fetcher's __twitchGqlError diagnostic envelope", async () => {
    const adapter = new TwitchAdapter(jsonFetcher((_url, init) => {
      if (operation(init) === "Inventory") {
        return { __twitchGqlError: "returned an unusable response; status=200; body=null" };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    }));

    await expect(adapter.discoverCampaigns())
      .rejects.toThrow("Inventory: returned an unusable response; status=200; body=null");
  });

  it("reports null Twitch GQL responses with the operation name", async () => {
    const adapter = new TwitchAdapter(jsonFetcher((_url, init) => {
      if (operation(init) === "ChannelPointsContext") return null;
      throw new Error(`Unexpected op ${operation(init)}`);
    }));

    await expect(adapter.claimChannelPoints({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }))
      .rejects.toThrow("ChannelPointsContext persisted query returned an empty Twitch GQL response");
  });

  it("maps stream info checks to live/category state via an inline query", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      expect(operation(init)).toBe("StreamInfo");
      const body = JSON.parse(String(init?.body));
      // Inline query is used instead of a persisted hash, which rotates and breaks.
      expect(body.query).toContain("viewersCount");
      expect(body.extensions?.persistedQuery).toBeUndefined();
      // Public query runs anonymously; logged-in GQL calls without integrity are rejected.
      expect(init?.credentials).toBe("omit");
      return { data: { user: { displayName: "Creator", stream: { viewersCount: 789, game: { id: "game", name: "Game" } } } } };
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { categoryId: "game" } as DropCampaign,
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      candidate: { categoryId: "game", categoryName: "Game", viewerCount: 789, displayName: "Creator" },
    });
  });

  it("lists Twitch drop-enabled streams through the slug directory query", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      expect(operation(init)).toBe("DirectoryPage_Game");
      expect(requestBody(init).variables).toMatchObject({
        slug: "fortnite",
        options: {
          systemFilters: ["DROPS_ENABLED"],
          includeRestricted: ["SUB_ONLY_LIVE"],
          freeformTags: null,
          sort: "VIEWER_COUNT",
        },
      });
      return {
        data: {
          game: {
            streams: {
              edges: [{
                node: {
                  title: "FNCS",
                  viewersCount: 34513,
                  broadcaster: {
                    login: "faxuty",
                    displayName: "faxuty",
                    profileImageURL: "https://image",
                  },
                },
              }],
            },
          },
        },
      };
    });
    const adapter = new TwitchAdapter(fetcher);

    const candidates = await adapter.listCandidateChannels({
      id: "campaign",
      platform: "twitch",
      name: "FNCS Summit | Finals",
      slug: "fortnite",
      gameName: "Fortnite",
      categoryId: "33214",
      status: "active",
      rewards: [],
      isGeneralDrop: true,
    });

    expect(candidates[0]).toMatchObject({
      username: "faxuty",
      displayName: "faxuty",
      viewerCount: 34513,
      title: "FNCS",
      campaignId: "campaign",
      categoryId: "33214",
    });
  });

  it("falls back to Twitch channel page data when stream info GQL fails", async () => {
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://gql.twitch.tv/gql" && operation(init) === "StreamInfo") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      if (url === "https://www.twitch.tv/creator") {
        return { html: '{"isLiveBroadcast":true,"game":{"id":"game","name":"Game"}}' };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { categoryId: "game" } as DropCampaign,
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      reason: "Twitch GQL check failed; used channel page fallback",
      candidate: { categoryId: "game" },
    });
  });

  it("treats Twitch channel validation as invalid when GQL and page fallback both fail", async () => {
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://gql.twitch.tv/gql" && operation(init) === "StreamInfo") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      if (url === "https://www.twitch.tv/creator") {
        throw new Error("Twitch page unavailable");
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { categoryId: "game" } as DropCampaign,
    )).resolves.toMatchObject({
      live: false,
      categoryMatches: false,
      reason: "PersistedQueryNotFound",
    });
  });

  it("merges current watched drop progress for the active Twitch session", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 10, isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 42 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);
    const campaigns: DropCampaign[] = [{
      id: "campaign",
      platform: "twitch",
      name: "Campaign",
      status: "active",
      rewards: [{ id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 0, status: "locked" }],
    }];

    const progress = await adapter.readProgress(campaigns, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    });

    expect(progress[0].rewards[0]).toMatchObject({
      watchedMinutes: 42,
      status: "in_progress",
      isCurrentReward: true,
    });
  });

  it("claims a Twitch reward with the real drop-instance id", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        expect(requestBody(init).variables).toMatchObject({ input: { dropInstanceID: "instance-id" } });
        return { data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } } };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = new TwitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(true);
    // A valid integrity token is ensured before the claim is sent.
    expect(ensureIntegrity).toHaveBeenCalledTimes(1);
  });

  it("does not call Twitch or ensure integrity, and reports not claim-ready, when the drop-instance id is missing", async () => {
    const fetcher = jsonFetcher(() => {
      throw new Error("should not fetch without a claim id");
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = new TwitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" } as DropReward;

    expect(adapter.isClaimReady(reward)).toBe(false);
    expect(adapter.isClaimReady({ ...reward, claimId: "instance-id" })).toBe(true);
    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(false);
    expect(ensureIntegrity).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected Twitch claim status as an error without retrying", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        return { data: { claimDropRewards: { status: "INELIGIBLE" } } };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = new TwitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).rejects.toThrow(/status=INELIGIBLE/);
    // A non-integrity failure must not trigger a refresh + retry.
    expect(ensureIntegrity).toHaveBeenCalledTimes(1);
  });

  it("refreshes the integrity token and retries once when the first claim fails an integrity check", async () => {
    let claimAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        claimAttempts += 1;
        if (claimAttempts === 1) return { error: "failed integrity check" };
        return { data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } } };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    const ensureIntegrity = vi.fn(async () => true);
    const adapter = new TwitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(true);
    expect(claimAttempts).toBe(2);
    // Once before the first attempt, once to force a fresh token before the retry.
    expect(ensureIntegrity).toHaveBeenCalledTimes(2);
  });

  it("reports a clear error when an integrity token cannot be refreshed", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "DropsPage_ClaimDropRewards") {
        return { error: "failed integrity check" };
      }
      throw new Error(`Unexpected op ${operation(init)}`);
    });
    // No token can be captured (e.g. logged out / no tab can be opened).
    const ensureIntegrity = vi.fn(async () => false);
    const adapter = new TwitchAdapter(fetcher, ensureIntegrity);
    const reward = { id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable", claimId: "instance-id" } as DropReward;

    await expect(adapter.claimReward({ id: "campaign" } as DropCampaign, reward))
      .rejects.toThrow(/Keep a logged-in twitch\.tv tab open/);
  });

  it("reconstructs the drop-instance id for a watched-complete drop with no self edge", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              inventory: {
                dropCampaignsInProgress: [{
                  id: "campaign",
                  timeBasedDrops: [{
                    id: "drop",
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 30, isClaimed: false },
                  }],
                }],
              },
            },
          },
        };
      }
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 60 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);
    const campaigns: DropCampaign[] = [{
      id: "campaign",
      platform: "twitch",
      name: "Campaign",
      status: "active",
      rewards: [{ id: "drop", name: "Reward", requiredMinutes: 60, watchedMinutes: 0, status: "locked" }],
    }];

    const progress = await adapter.readProgress(campaigns, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    });

    // Reconstructed deterministically as userID#campaignID#dropID so the drop is
    // still claimable even though Twitch hasn't returned the self edge yet.
    expect(progress[0].rewards[0]).toMatchObject({ status: "claimable", isCurrentReward: true, claimId: "user-id#campaign#drop" });
    expect(adapter.isClaimReady(progress[0].rewards[0])).toBe(true);
  });
});
