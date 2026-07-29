import { describe, expect, it, vi } from "vitest";
import type { PageFetcher, PlatformAdapter } from "@lurkloot/core/adapter";
import { createKickClaimCapability, createKickFetcher, KickAdapter, KickClaimState } from "@lurkloot/core/kick";
import { fetchTwitchInBackgroundWith, KickWafBlockedError } from "@lurkloot/core/tabs";
import { readFileSync } from "node:fs";
import { TwitchAdapter, TwitchDiscoveryState } from "@lurkloot/core/twitch";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { DropCampaign, DropReward, ExtensionSettings } from "@lurkloot/shared/models";
import { chooseCampaignDecision } from "@lurkloot/core/scheduler";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { resolveCompatibility } from "@lurkloot/core";
import { SafeFetchError, type SafeFetchFailureKind } from "@lurkloot/core/fetchError";

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

function twitchInventory(campaignIds: string[], userId = "user-id"): unknown {
  return {
    data: {
      currentUser: {
        id: userId,
        inventory: {
          dropCampaignsInProgress: campaignIds.map((id) => ({
            id,
            name: "Inventory Campaign",
            game: { id: "game", slug: "game-slug", displayName: "Game" },
            timeBasedDrops: [{
              id: `${id}-drop`,
              requiredMinutesWatched: 60,
              self: { currentMinutesWatched: 20, isClaimed: false },
              benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
            }],
          })),
        },
      },
    },
  };
}

function twitchDashboard(campaignIds: string[], userId = "user-id"): unknown {
  return {
    data: {
      currentUser: {
        id: userId,
        login: "viewer",
        dropCampaigns: campaignIds.map((id) => ({ id, status: "ACTIVE", self: { isAccountConnected: true } })),
      },
    },
  };
}

function twitchCampaignDetails(dropID: string): unknown {
  return {
    data: {
      dropCampaign: {
        id: dropID,
        name: `Campaign ${dropID}`,
        game: { id: "game", slug: "game-slug", displayName: "Game" },
        timeBasedDrops: [{
          id: `${dropID}-drop`,
          requiredMinutesWatched: 60,
          benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
        }],
      },
    },
  };
}

function kickCampaigns(campaignId = "campaign", rewardId = "reward"): unknown {
  return {
    data: [{
      id: campaignId,
      name: "Kick Campaign",
      status: "active",
      rewards: [{
        id: rewardId,
        name: "Reward",
        required_minutes: 1,
      }],
    }],
  };
}

describe("KickAdapter", () => {
  it("starts Kick campaign and progress requests concurrently", async () => {
    let campaignStarted = false;
    let progressStarted = false;
    const adapter = new KickAdapter(jsonFetcher(async (url) => {
      if (url.endsWith("/drops/campaigns")) {
        campaignStarted = true;
        await vi.waitFor(() => expect(progressStarted).toBe(true));
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
      if (url.endsWith("/drops/progress")) {
        progressStarted = true;
        await vi.waitFor(() => expect(campaignStarted).toBe(true));
        return {
          data: [{
            id: 1,
            status: "in progress",
            rewards: [{ id: 10, progress: 0.5, required_units: 60 }],
          }],
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    const campaigns = await adapter.refreshCampaigns();

    expect(campaigns[0]?.rewards[0]?.watchedMinutes).toBe(30);
  });

  it("keeps Kick campaigns when concurrent progress refresh fails", async () => {
    const events: EngineEvent[] = [];
    const adapter = new KickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) {
        return {
          data: [{
            id: 1,
            name: "Kick Campaign",
            status: "active",
            rewards: [{ id: 10, name: "Reward", required_minutes: 60 }],
          }],
        };
      }
      throw new Error("progress unavailable");
    }), undefined, undefined, (event) => events.push(event));

    const campaigns = await adapter.refreshCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      level: "warn",
      message: expect.stringContaining("using last-known progress"),
    }));
  });

  it("propagates Kick progress authentication failures during refresh", async () => {
    const failure = new SafeFetchError({ kind: "authentication_rejected", status: 401 });
    const adapter = new KickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) return { data: [] };
      throw failure;
    }));

    await expect(adapter.refreshCampaigns()).rejects.toBe(failure);
  });

  it("propagates Kick campaign discovery failures during refresh", async () => {
    const failure = new Error("campaigns unavailable");
    const adapter = new KickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/progress")) return { data: [] };
      throw failure;
    }));

    await expect(adapter.refreshCampaigns()).rejects.toBe(failure);
  });

  it("passes the auth probe signal to the Kick identity request", async () => {
    const abort = new AbortController();
    const emit = vi.fn();
    const fetchJson = vi.fn(async () => ({ id: 42 }));
    const fetcher = { fetchJson: fetchJson as PageFetcher["fetchJson"] };

    await new KickAdapter(fetcher, undefined, undefined, emit).checkAuthHealth(abort.signal);

    expect(fetchJson).toHaveBeenCalledWith(
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
      emit,
    );
  });

  it("does not swallow authentication failures while refreshing progress", async () => {
    const failure = new SafeFetchError({ kind: "authentication_rejected", status: 401 });
    const adapter = new KickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) return { data: [] };
      throw failure;
    }));

    await expect(adapter.refreshCampaigns()).rejects.toBe(failure);
  });

  it("does not swallow security-policy failures while claiming challenges", async () => {
    const failure = new SafeFetchError({ kind: "security_policy_blocked", status: 403, reference: "safe-ref" });
    const adapter = new KickAdapter(jsonFetcher((url) => {
      if (url.endsWith("/gamification/challenges")) {
        return { data: [{ id: "daily", claimed_at: null, recurrence: "daily", condition: { progress: 1, threshold: 1 } }] };
      }
      throw failure;
    }));

    await expect(adapter.claimChallenges()).rejects.toBe(failure);
  });

  it.each([
    ["authentication_rejected", "invalid_credentials", "credentials_rejected", "authInvalidCredentials"],
    ["security_policy_blocked", "blocked", "security_policy_blocked", "authSecurityPolicyBlocked"],
    ["network_error", "unavailable", "network_unavailable", "authNetworkUnavailable"],
    ["http_error", "unavailable", "platform_unavailable", "authPlatformUnavailable"],
  ] as const)("maps %s account probe failures to %s", async (kind, status, reasonCode, key) => {
    const fetcher = jsonFetcher(() => {
      throw new SafeFetchError({
        kind: kind as SafeFetchFailureKind,
        status: kind === "network_error" ? undefined : kind === "authentication_rejected" ? 401 : 403,
        reason: kind === "security_policy_blocked" ? "Request blocked by security policy." : undefined,
        reference: kind === "security_policy_blocked" ? "9e4db7e3" : undefined,
      });
    });

    const health = await new KickAdapter(fetcher).checkAuthHealth();

    expect(health).toMatchObject({ status, reasonCode, message: { key } });
    expect(health.message?.values?.reference).toBe(kind === "security_policy_blocked" ? "9e4db7e3" : undefined);
    expect(Date.parse(health.checkedAt ?? "")).not.toBeNaN();
  });

  it("does not copy unknown account probe errors into health state", async () => {
    const fetcher = jsonFetcher(() => { throw new Error("token=secret-value"); });

    const health = await new KickAdapter(fetcher).checkAuthHealth();

    expect(health).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    });
    expect(JSON.stringify(health)).not.toContain("secret-value");
  });

  it("uses the automatic Kick claim capability selected by compatibility resolution", async () => {
    let claimPosts = 0;
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/automatic" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const compatibility = resolveCompatibility(DEFAULT_SETTINGS.compatibility, {
      host: "extension",
      twitchIdentity: "web",
    }).compatibility.kick;
    const adapter = new KickAdapter(fetcher, undefined, undefined, undefined, { compatibility });
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);

    expect(compatibility.claim).toBe("kick-claim-v2");
    expect(claimPosts).toBe(1);
    expect(reward.claimGuidance).toEqual({ kind: "link_required", url: "https://accounts.example/automatic" });
  });

  it("keeps an explicit Kick claim v1 adapter campaign-only for its lifetime", async () => {
    let claimPosts = 0;
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/ignored" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const compatibility = resolveCompatibility({
      ...DEFAULT_SETTINGS.compatibility,
      kick: { ...DEFAULT_SETTINGS.compatibility.kick, claimLinkHandling: "kick-claim-v1" },
    }, { host: "extension", twitchIdentity: "web" }).compatibility.kick;
    const adapter = new KickAdapter(fetcher, undefined, undefined, undefined, { compatibility });
    const campaign = { id: "campaign", accountLinked: true } as DropCampaign;
    const reward = { id: "reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    compatibility.claim = "kick-claim-v2";
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);

    expect(compatibility.claim).toBe("kick-claim-v2");
    expect(claimPosts).toBe(2);
    expect(reward.claimGuidance).toBeUndefined();
  });

  it("keeps adapter diagnostics scoped to the supplied emitter", async () => {
    const failingFetcher = jsonFetcher((url) => {
      if (url.endsWith("/drops/campaigns")) return { data: [] };
      throw new Error("progress unavailable");
    });
    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    const firstAdapter = new KickAdapter(failingFetcher, undefined, undefined, (event) => first.push(event));
    const secondAdapter = new KickAdapter(failingFetcher, undefined, undefined, (event) => second.push(event));

    await firstAdapter.refreshCampaigns();
    await secondAdapter.refreshCampaigns();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
  });

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

    const campaigns = await adapter.refreshCampaigns();
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
      { ...DEFAULT_SETTINGS },
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

    await expect(adapter.checkChannel(
      { platform: "kick", username: "creator", url: "https://kick.com/creator" },
      { campaign },
    ))
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

  it("classifies Kick claim v2 link guidance from supported response fields", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = { id: "campaign" } as DropCampaign;

    expect(capability.classify({ connect_url: "https://accounts.example/link" }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/link" });
    expect(capability.classify({ connectUrl: "https://accounts.example/camel" }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/camel" });
    expect(capability.classify({ data: { connect_url: "https://accounts.example/nested" } }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/nested" });
    expect(capability.classify({ data: { connectUrl: "https://accounts.example/nested-camel" } }, campaign))
      .toEqual({ kind: "link_required", url: "https://accounts.example/nested-camel" });
  });

  it("rejects unsafe, malformed, and arbitrarily nested Kick claim v2 guidance", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = { id: "campaign" } as DropCampaign;

    for (const response of [
      { connect_url: "not a URL" },
      { connect_url: "https://user:pass@accounts.example/link" },
      { connectUrl: "javascript:alert(1)" },
      { data: { connect_url: "data:text/plain,hello" } },
      { data: { connectUrl: 42 } },
      { error: { connect_url: "https://accounts.example/too-deep" } },
      { data: { error: { connectUrl: "https://accounts.example/too-deep" } } },
    ]) {
      expect(capability.classify(response, campaign)).toEqual({ kind: "not_claimed" });
    }
  });

  it("classifies normal Kick claim success independently of link guidance", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = { id: "campaign" } as DropCampaign;

    expect(capability.classify({ message: "Success", data: { id: 1 } }, campaign)).toEqual({ kind: "claimed" });
    expect(capability.classify({ success: true }, campaign)).toEqual({ kind: "claimed" });
    expect(capability.classify({}, campaign)).toEqual({ kind: "not_claimed" });
  });

  it("suppresses repeated link-required claims until refreshed progress explicitly confirms linking", async () => {
    let claimPosts = 0;
    let progress: unknown = { data: [{ campaign_id: "campaign" }] };
    const events: EngineEvent[] = [];
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/link?state=opaque-secret#fragment" };
      }
      if (url === "https://web.kick.com/api/v1/drops/campaigns") return kickCampaigns();
      if (url === "https://web.kick.com/api/v1/drops/progress") return progress;
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher, undefined, undefined, (event) => events.push(event));
    const campaign = {
      id: "campaign",
      platform: "kick",
      name: "Campaign",
      status: "active",
      // Stale last-known metadata must not count as refreshed affirmative evidence.
      accountLinked: true,
      rewards: [{ id: "reward", name: "Reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 }],
    } as DropCampaign;
    const reward = campaign.rewards[0];

    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    await expect(adapter.claimReward(campaign, reward)).resolves.toBe(false);
    expect(claimPosts).toBe(1);
    expect(reward.claimGuidance).toEqual({
      kind: "link_required",
      url: "https://accounts.example/link?state=opaque-secret#fragment",
    });
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("opaque-secret");
    expect(serializedEvents).not.toContain("/link");

    const ambiguous = await adapter.refreshCampaigns();
    await expect(adapter.claimReward(ambiguous[0], ambiguous[0].rewards[0])).resolves.toBe(false);
    expect(claimPosts).toBe(1);

    progress = { data: [{ campaign_id: "campaign", user_app_connected: true, progress_units: 1 }] };
    const linked = await adapter.refreshCampaigns();
    expect(linked[0].accountLinked).toBe(true);
    expect(linked[0].claimGuidance).toBeUndefined();
    expect(linked[0].rewards[0].claimGuidance).toBeUndefined();
    await expect(adapter.claimReward(linked[0], linked[0].rewards[0])).resolves.toBe(false);
    expect(claimPosts).toBe(2);
  });

  it("cleans all campaign suppressions after affirmative linking, including absent rewards", () => {
    const capability = createKickClaimCapability("kick-claim-v2");
    const campaign = {
      id: "campaign",
      rewards: [
        { id: "present", status: "claimable" },
        { id: "removed", status: "claimable" },
      ],
    } as DropCampaign;
    capability.suppress?.(campaign, campaign.rewards[0], "https://accounts.example/present");
    capability.suppress?.(campaign, campaign.rewards[1], "https://accounts.example/removed");

    const refreshed = [{ ...campaign, rewards: [campaign.rewards[0]] }];
    capability.reconcileProgress?.(refreshed, new Set(["campaign"]));

    expect(capability.isSuppressed?.(campaign, campaign.rewards[0])).toBe(false);
    expect(capability.isSuppressed?.(campaign, campaign.rewards[1])).toBe(false);
  });

  it("clears v2 suppression from a bare-array affirmative progress response", async () => {
    let claimPosts = 0;
    let progress: unknown = [{ campaign_id: "campaign" }];
    const adapter = new KickAdapter(jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connect_url: "https://accounts.example/link" };
      }
      if (url === "https://web.kick.com/api/v1/drops/campaigns") return kickCampaigns();
      if (url === "https://web.kick.com/api/v1/drops/progress") return progress;
      throw new Error(`Unexpected URL ${url}`);
    }));
    const campaign = {
      id: "campaign",
      rewards: [{ id: "reward", status: "claimable" }],
    } as DropCampaign;

    await adapter.claimReward(campaign, campaign.rewards[0]);
    progress = [{ campaign_id: "campaign", user_app_connected: true, progress_units: 1 }];
    const refreshed = await adapter.refreshCampaigns();
    await adapter.claimReward(refreshed[0], refreshed[0].rewards[0]);

    expect(claimPosts).toBe(2);
  });

  it("shares link-required suppression across fresh adapters but lets a new host state retry", async () => {
    let claimPosts = 0;
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return { connectUrl: "https://accounts.example/link" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", name: "Reward", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;

    const state = new KickClaimState();
    await new KickAdapter(fetcher, undefined, undefined, undefined, { claimState: state }).claimReward(campaign, reward);
    await new KickAdapter(fetcher, undefined, undefined, undefined, { claimState: state }).claimReward(campaign, reward);

    expect(claimPosts).toBe(1);

    state.clear();
    await new KickAdapter(fetcher, undefined, undefined, undefined, { claimState: state }).claimReward(campaign, reward);

    expect(claimPosts).toBe(2);

    await new KickAdapter(fetcher, undefined, undefined, undefined, { claimState: new KickClaimState() }).claimReward(campaign, reward);

    expect(claimPosts).toBe(3);
  });

  it("keeps Kick claim v1 limited to campaign account-link metadata", () => {
    const capability = createKickClaimCapability("kick-claim-v1");

    expect(capability.classify(
      { connect_url: "https://accounts.example/ignored" },
      { id: "campaign", accountLinked: true } as DropCampaign,
    )).toEqual({ kind: "not_claimed" });
    expect(capability.classify(
      { message: "Reward not available" },
      { id: "campaign", accountLinked: false, accountLinkUrl: "https://accounts.example/from-campaign" } as DropCampaign,
    )).toEqual({ kind: "link_required", url: "https://accounts.example/from-campaign" });
    expect(capability.classify(
      { message: "Reward not available" },
      { id: "campaign", accountLinked: false, accountLinkUrl: "javascript:alert(1)" } as DropCampaign,
    )).toEqual({ kind: "not_claimed" });
  });

  it("guides the user to link instead of erroring when an unlinked Kick claim is rejected", async () => {
    const reward = { id: "reward", name: "Spray", status: "claimable", requiredMinutes: 1, watchedMinutes: 1 } as DropReward;
    let rejectionPosts = 0;
    const rejecting = () => new KickAdapter(jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        rejectionPosts += 1;
        throw new Error("403 Forbidden");
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    // Unlinked campaign: the rejection is swallowed (no platform backoff) and reported as a non-claim.
    const unlinked = rejecting();
    const unlinkedCampaign = { id: "c", accountLinked: false, accountLinkUrl: "https://accounts.krafton.com/x" } as DropCampaign;
    await expect(unlinked.claimReward(unlinkedCampaign, reward)).resolves.toBe(false);
    await expect(unlinked.claimReward(unlinkedCampaign, reward)).resolves.toBe(false);
    expect(rejectionPosts).toBe(1);

    // Linked campaign: a genuine claim error still propagates for the scheduler to handle.
    await expect(
      rejecting().claimReward({ id: "c", accountLinked: true } as DropCampaign, reward),
    ).rejects.toThrow("403");

    await expect(
      rejecting().claimReward({ id: "c", accountLinked: false, accountLinkUrl: "https://user:pass@accounts.example/x" } as DropCampaign, reward),
    ).rejects.toThrow("403");
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
    const abort = new AbortController();
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://kick.com/api/v2/channels/creator") {
        throw new Error("Kick API unavailable");
      }
      if (url === "https://kick.com/creator") {
        expect(init?.signal).toBe(abort.signal);
        return { html: '{"livestream":{"is_live":true,"category":{"id":99,"name":"Game"}}}' };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new KickAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "kick", username: "creator", url: "https://kick.com/creator" },
      { campaign: { categoryId: "99" } as DropCampaign, signal: abort.signal },
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
      { campaign: { categoryId: "99" } as DropCampaign },
    )).resolves.toMatchObject({
      live: false,
      categoryMatches: false,
      reason: "Kick API unavailable",
    });
  });

  it("searches categories and maps id/name/banner image", async () => {
    const fetcher = jsonFetcher((url) => {
      expect(url.startsWith("https://kick.com/api/search")).toBe(true);
      expect(new URL(url).searchParams.get("searched_word")).toBe("rust");
      // Shape confirmed live: { channels, categories, livestreams }.
      return {
        channels: [{ id: 1, slug: "rustimba" }],
        categories: [
          { id: 13, category_id: 1, name: "Rust", slug: "rust", banner: { src: "https://files.kick.com/rust.webp" } },
          { id: 13, name: "Rust dup" },
          { id: "", name: "blank" },
        ],
      };
    });

    await expect(new KickAdapter(fetcher).searchCategories("rust")).resolves.toEqual([
      { id: "13", name: "Rust", imageUrl: "https://files.kick.com/rust.webp" },
    ]);
  });

  it("returns no categories for a blank query without fetching", async () => {
    const fetcher = jsonFetcher(() => { throw new Error("should not fetch"); });
    await expect(new KickAdapter(fetcher).searchCategories("   ")).resolves.toEqual([]);
  });

  it("claims only completed, unclaimed Kick challenges", async () => {
    const claimed: string[] = [];
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return {
          data: [
            { id: "done", recurrence: "daily", claimed_at: null, condition: { progress: 60, threshold: 60 } },
            { id: "already", recurrence: "daily", claimed_at: "2026-07-17T23:39:02Z", condition: { progress: 60, threshold: 60 } },
            { id: "partial", recurrence: "daily", claimed_at: null, condition: { progress: 30, threshold: 60 } },
          ],
        };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/done/claim") {
        expect(init?.method).toBe("POST");
        claimed.push("done");
        return { data: { challenge_id: "done", winner: { id: "card", rarity: "legendary" } } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const adapter = new KickAdapter(fetcher);

    await expect(adapter.claimChallenges!()).resolves.toEqual([
      { id: "done", rarity: "legendary", recurrence: "daily" },
    ]);
    expect(claimed).toEqual(["done"]);
  });

  it("reports an unknown rarity when the Kick claim response omits a winner", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return { data: [{ id: "done", recurrence: "weekly", claimed_at: null, condition: { progress: 5, threshold: 5 } }] };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/done/claim") return { message: "success" };
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(new KickAdapter(fetcher).claimChallenges!()).resolves.toEqual([
      { id: "done", rarity: "unknown", recurrence: "weekly" },
    ]);
  });

  it("keeps claiming Kick challenges after one claim fails", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return {
          data: [
            { id: "bad", recurrence: "daily", claimed_at: null, condition: { progress: 1, threshold: 1 } },
            { id: "good", recurrence: "daily", claimed_at: null, condition: { progress: 1, threshold: 1 } },
          ],
        };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/bad/claim") throw new Error("boom");
      if (url === "https://web.kick.com/api/v1/gamification/challenges/good/claim") {
        return { data: { winner: { rarity: "common" } } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(new KickAdapter(fetcher).claimChallenges!()).resolves.toEqual([
      { id: "good", rarity: "common", recurrence: "daily" },
    ]);
  });

  it("returns nothing when Kick reports no challenges", async () => {
    const fetcher = jsonFetcher(() => ({}));
    await expect(new KickAdapter(fetcher).claimChallenges!()).resolves.toEqual([]);
  });
});

describe("createKickFetcher (background-first, tab fallback)", () => {
  it("uses the service-worker result and never touches the page tab when the background fetch succeeds", async () => {
    const background = vi.fn(async () => ({ data: "from-sw" }));
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const onBackgroundSuccess = vi.fn(async () => undefined);
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onBackgroundSuccess, onPageFallback });

    const result = await fetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns");

    expect(result).toEqual({ data: "from-sw" });
    expect(background).toHaveBeenCalledTimes(1);
    expect(pageFetch).not.toHaveBeenCalled();
    expect(onBackgroundSuccess).toHaveBeenCalledWith("web.kick.com", expect.any(Function));
    expect(onPageFallback).not.toHaveBeenCalled();
  });

  it("falls back to the page tab when the background fetch is WAF-blocked", async () => {
    const background = vi.fn(async () => { throw new KickWafBlockedError("HTTP 403 Forbidden"); });
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onPageFallback });

    const result = await fetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns", { method: "GET" });

    expect(result).toEqual({ data: "from-tab" });
    expect(background).toHaveBeenCalledTimes(1);
    // The same url + init are forwarded to the fallback unchanged.
    expect(pageFetch).toHaveBeenCalledWith("https://web.kick.com/api/v1/drops/campaigns", { method: "GET" });
    expect(onPageFallback).toHaveBeenCalledWith("web.kick.com", expect.any(Function));
  });

  it("does not enter page fallback for an already-aborted request", async () => {
    const reason = new Error("auth deadline elapsed");
    const abort = new AbortController();
    abort.abort(reason);
    const background = vi.fn(async () => {
      throw new KickWafBlockedError("background rejected after deadline");
    });
    const pageFetch = vi.fn(async () => ({ id: 42 }));
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onPageFallback });

    await expect(fetcher.fetchJson(
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
    )).rejects.toBe(reason);

    expect(pageFetch).not.toHaveBeenCalled();
    expect(onPageFallback).not.toHaveBeenCalled();
  });

  it("does not enter page fallback when an in-flight background request is aborted", async () => {
    const reason = new Error("auth deadline elapsed");
    const abort = new AbortController();
    let backgroundStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      backgroundStarted = resolve;
    });
    const background = vi.fn(async (_url: string, init?: RequestInit) => {
      backgroundStarted();
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new KickWafBlockedError("background rejected after deadline");
    });
    const pageFetch = vi.fn(async () => ({ id: 42 }));
    const onPageFallback = vi.fn(async () => undefined);
    const fetcher = createKickFetcher({ background, pageFetch, onPageFallback });

    const request = fetcher.fetchJson(
      "https://kick.com/api/v1/user",
      { signal: abort.signal },
    );
    await started;
    abort.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(pageFetch).not.toHaveBeenCalled();
    expect(onPageFallback).not.toHaveBeenCalled();
  });

  it("records fallback before page execution even when the page request fails", async () => {
    const order: string[] = [];
    const fetcher = createKickFetcher({
      background: async () => { throw new KickWafBlockedError("blocked"); },
      onPageFallback: async () => { order.push("fallback"); },
      pageFetch: async () => {
        order.push("page");
        throw new Error("page unavailable");
      },
    });

    await expect(fetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns"))
      .rejects.toThrow("page unavailable");
    expect(order).toEqual(["fallback", "page"]);
  });

  it("keeps fallback diagnostics free of request details and raw errors", async () => {
    const events: EngineEvent[] = [];
    const fetcher = createKickFetcher({
      background: async () => { throw new Error("token=secret-value"); },
      pageFetch: async () => ({ ok: true }),
    });

    await fetcher.fetchJson("https://web.kick.com/api/private?token=secret-value", undefined, (event) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: "diagnostic", platform: "kick" });
    expect(events[0].category === "diagnostic" ? events[0].message : "").toContain("web.kick.com");
    expect(events[0].category === "diagnostic" ? events[0].message : "").not.toContain("secret-value");

    events.length = 0;
    await fetcher.fetchJson("not-a-url-secret-value", undefined, (event) => events.push(event));
    expect(events[0].category === "diagnostic" ? events[0].message : "").toContain("unknown-host");
    expect(events[0].category === "diagnostic" ? events[0].message : "").not.toContain("secret-value");
  });

  it("does not turn lifecycle bookkeeping failures into request failures or extra fallbacks", async () => {
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const backgroundFetcher = createKickFetcher({
      background: async () => ({ data: "from-sw" }),
      pageFetch,
      onBackgroundSuccess: async () => { throw new Error("bookkeeping failed"); },
    });

    await expect(backgroundFetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns"))
      .resolves.toEqual({ data: "from-sw" });
    expect(pageFetch).not.toHaveBeenCalled();

    const fallbackFetcher = createKickFetcher({
      background: async () => { throw new KickWafBlockedError("blocked"); },
      pageFetch,
      onPageFallback: async () => { throw new Error("bookkeeping failed"); },
    });
    await expect(fallbackFetcher.fetchJson("https://web.kick.com/api/v1/drops/campaigns"))
      .resolves.toEqual({ data: "from-tab" });
  });

  it("also falls back on a non-WAF background error", async () => {
    const background = vi.fn(async () => { throw new Error("boom"); });
    const pageFetch = vi.fn(async () => ({ data: "from-tab" }));
    const fetcher = createKickFetcher({ background, pageFetch });

    await expect(fetcher.fetchJson("https://kick.com/api/v2/channels/x")).resolves.toEqual({ data: "from-tab" });
    expect(pageFetch).toHaveBeenCalledTimes(1);
  });
});

describe("TwitchAdapter", () => {
  it("refreshes Twitch campaigns with one inventory request", async () => {
    let inventoryCalls = 0;
    const adapter = new TwitchAdapter(jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as
        | Record<string, unknown>
        | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) =>
          twitchCampaignDetails(String((entry.variables as { dropID?: string }).dropID)));
      }
      if (body.operationName === "Inventory") {
        inventoryCalls += 1;
        return twitchInventory(["campaign"]);
      }
      return twitchDashboard(["campaign"]);
    }));

    await adapter.refreshCampaigns();

    expect(inventoryCalls).toBe(1);
  });

  it("merges active Twitch session progress without repeating inventory", async () => {
    let inventoryCalls = 0;
    let currentDropCalls = 0;
    const adapter = new TwitchAdapter(jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as
        | Record<string, unknown>
        | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) =>
          twitchCampaignDetails(String((entry.variables as { dropID?: string }).dropID)));
      }
      if (body.operationName === "Inventory") {
        inventoryCalls += 1;
        return twitchInventory(["campaign"]);
      }
      if (body.operationName === "ViewerDropsDashboard") return twitchDashboard(["campaign"]);
      if (body.operationName === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id" } } };
      }
      if (body.operationName === "DropCurrentSessionContext") {
        currentDropCalls += 1;
        return {
          data: {
            currentUser: {
              dropCurrentSession: {
                dropID: "campaign-drop",
                currentMinutesWatched: 42,
              },
            },
          },
        };
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    }));

    const campaigns = await adapter.refreshCampaigns({
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      channel: {
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      },
    } as never);

    expect(inventoryCalls).toBe(1);
    expect(currentDropCalls).toBe(1);
    expect(campaigns[0]?.rewards[0]?.watchedMinutes).toBe(42);
  });

  it("passes the auth probe signal to the Twitch CurrentUser request", async () => {
    const abort = new AbortController();
    const emit = vi.fn();
    const fetchJson = vi.fn(async () => ({ data: { currentUser: { id: "u" } } }));
    const fetcher = { fetchJson: fetchJson as PageFetcher["fetchJson"] };

    await new TwitchAdapter(fetcher, undefined, undefined, undefined, emit).checkAuthHealth(abort.signal);

    expect(fetchJson).toHaveBeenCalledWith(
      "https://gql.twitch.tv/gql",
      expect.objectContaining({ signal: abort.signal }),
      emit,
    );
  });

  it("reports healthy only when the authenticated CurrentUser probe returns a user", async () => {
    const ensureIntegrity = vi.fn(async () => true);
    const fetcher = jsonFetcher((_url, init) => {
      expect(operation(init)).toBe("CurrentUser");
      expect(requestBody(init).query).toContain("currentUser { id }");
      return { data: { currentUser: { id: "private-user-id" } } };
    });

    await expect(new TwitchAdapter(fetcher, ensureIntegrity).checkAuthHealth()).resolves.toEqual({
      status: "healthy",
      checkedAt: expect.any(String),
      message: { key: "authHealthy" },
    });
    expect(ensureIntegrity).not.toHaveBeenCalled();
  });

  it.each([
    { data: { currentUser: null } },
    { data: {} },
    { data: { user: { id: "public-user-id" } } },
  ])("rejects a completed response without authenticated identity: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "invalid_credentials",
      checkedAt: expect.any(String),
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
  });

  it.each([
    { error: "Unauthorized", message: "OAuth token is invalid" },
    { errors: [{ message: "Unauthenticated" }] },
    { errors: [{ message: "The OAuth token was invalid" }] },
  ])("classifies explicit Twitch credential rejection as invalid: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "invalid_credentials",
      checkedAt: expect.any(String),
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
  });

  it.each([
    [401, "Unauthorized", "invalid_credentials", "credentials_rejected", "authInvalidCredentials"],
    [503, "Service Unavailable", "unavailable", "platform_unavailable", "authPlatformUnavailable"],
  ] as const)("classifies background HTTP %i without treating it as a network failure", async (status, statusText, healthStatus, reasonCode, messageKey) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(status === 401 ? "OAuth token rejected" : "upstream unavailable", { status, statusText }),
    );
    const cookieApi = {
      cookies: {
        get: vi.fn(async ({ name }: { name: string }) => name === "auth-token" ? { value: "secret" } : null),
      },
    };
    const fetcher: PageFetcher = {
      fetchJson: (url, init) => fetchTwitchInBackgroundWith(cookieApi, url, init),
    };

    try {
      await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
        status: healthStatus,
        checkedAt: expect.any(String),
        reasonCode,
        message: { key: messageKey },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("classifies request transport failure as network unavailability", async () => {
    const fetcher = jsonFetcher(() => {
      throw new TypeError("Failed to fetch secret-url");
    });

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "unavailable",
      checkedAt: expect.any(String),
      reasonCode: "network_unavailable",
      message: { key: "authNetworkUnavailable" },
    });
  });

  it.each([
    { errors: [{ message: "service unavailable" }] },
    { error: "Service Unavailable", message: "upstream failed" },
    null,
  ])("classifies Twitch response failure as platform unavailability: %j", async (response) => {
    const fetcher = jsonFetcher(() => response);

    await expect(new TwitchAdapter(fetcher).checkAuthHealth()).resolves.toEqual({
      status: "unavailable",
      checkedAt: expect.any(String),
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    });
  });

  it("declares the post-claim handoff capability for Twitch only", () => {
    // Reading a capability must not touch the network.
    const fetcher = jsonFetcher(() => {
      throw new Error("unexpected fetch");
    });

    // Read through the interface: the capability is optional there, and Kick's
    // concrete class deliberately does not declare it at all.
    const twitch: PlatformAdapter = new TwitchAdapter(fetcher);
    const kick: PlatformAdapter = new KickAdapter(fetcher);

    expect(twitch.supportsPostClaimHandoff).toBe(true);
    expect(kick.supportsPostClaimHandoff).toBeUndefined();
  });

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

    const campaigns = await adapter.refreshCampaigns();

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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inventory Campaign", status: "active" });
    expect(campaigns[0].rewards[0]).toMatchObject({ watchedMinutes: 20, status: "in_progress", claimId: "claim" });
  });

  it("batches Twitch campaign detail operations in bounded groups", async () => {
    const campaignIds = Array.from({ length: 41 }, (_, index) => `campaign-${index}`);
    const detailBatchSizes: number[] = [];
    let activeDetailBatches = 0;
    let peakDetailBatches = 0;
    const emit = vi.fn();
    const fetcher = jsonFetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        detailBatchSizes.push(body.length);
        activeDetailBatches += 1;
        peakDetailBatches = Math.max(peakDetailBatches, activeDetailBatches);
        await Promise.resolve();
        activeDetailBatches -= 1;
        return body.map((entry) => twitchCampaignDetails(String(
          (entry.variables as { dropID?: string }).dropID,
        )));
      }
      if (body.operationName === "Inventory") return twitchInventory([]);
      if (body.operationName === "ViewerDropsDashboard") return twitchDashboard(campaignIds);
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });

    const campaigns = await new TwitchAdapter(
      fetcher,
      undefined,
      undefined,
      undefined,
      emit,
    ).refreshCampaigns();

    expect(campaigns).toHaveLength(41);
    expect(detailBatchSizes).toEqual([20, 20, 1]);
    expect(peakDetailBatches).toBeLessThanOrEqual(2);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      message: expect.stringMatching(/^Twitch campaign details finished in \d+ms \(41 operations: 3 batch requests, 0 single fallbacks\)$/),
    }));
  });

  it("starts Twitch inventory and dashboard discovery requests concurrently", async () => {
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    let dashboardStarted = false;
    const fetcher = jsonFetcher(async (_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        await inventoryGate;
        return twitchInventory([]);
      }
      if (op === "ViewerDropsDashboard") {
        dashboardStarted = true;
        return twitchDashboard([]);
      }
      throw new Error(`Unexpected operation ${op}`);
    });
    const discovery = new TwitchAdapter(fetcher).refreshCampaigns();

    try {
      await vi.waitFor(() => expect(dashboardStarted).toBe(true));
    } finally {
      releaseInventory();
    }
    await expect(discovery).resolves.toEqual([]);
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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns[0]).toMatchObject({ id: "campaign", name: "Inventory Campaign", eligibility: "eligible" });
  });

  it("keeps a campaign whose details request fails once it has been seen successfully", async () => {
    let failing: string | undefined;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["a", "b"]);
      if (op === "DropCampaignDetails") {
        const dropID = String((requestBody(init).variables as Record<string, unknown>).dropID);
        if (dropID === failing) throw new Error("service unavailable");
        return twitchCampaignDetails(dropID);
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const events: EngineEvent[] = [];
    const discoveryState = new TwitchDiscoveryState();
    const firstAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState });

    expect((await firstAdapter.refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["a", "b"]);
    failing = "b";
    const secondAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }, (event) => events.push(event));
    const campaigns = await secondAdapter.refreshCampaigns();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["a", "b"]);
    expect(events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("b"))).toBe(true);
  });

  it("omits a campaign whose details request fails before it was ever seen, but records it", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["a", "b"]);
      if (op === "DropCampaignDetails") {
        const dropID = String((requestBody(init).variables as Record<string, unknown>).dropID);
        if (dropID === "b") throw new Error("service unavailable");
        return twitchCampaignDetails(dropID);
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const events: EngineEvent[] = [];
    const adapter = new TwitchAdapter(fetcher, undefined, undefined, undefined, (event) => events.push(event));

    const campaigns = await adapter.refreshCampaigns();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["a"]);
    expect(events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("b"))).toBe(true);
  });

  it("still propagates auth failures from a campaign details request", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["a"]);
      if (op === "DropCampaignDetails") {
        throw new SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "rejected" });
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(new TwitchAdapter(fetcher).refreshCampaigns()).rejects.toThrow(SafeFetchError);
  });

  it("keeps not-yet-started campaigns when the dashboard request fails after a successful one", async () => {
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("service unavailable");
        return twitchDashboard(["a"]);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const events: EngineEvent[] = [];
    const discoveryState = new TwitchDiscoveryState();
    const firstAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState });

    expect((await firstAdapter.refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["a"]);
    dashboardFails = true;
    const secondAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }, (event) => events.push(event));
    const campaigns = await secondAdapter.refreshCampaigns();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["a"]);
    expect(events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("dashboard"))).toBe(true);

    dashboardFails = false;
    expect((await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["a"]);
  });

  it("does not retain dashboard campaigns when the dashboard genuinely returns none", async () => {
    let dashboardIds = ["campaign"];
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("service unavailable");
        return twitchDashboard(dashboardIds);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();
    const firstAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState });

    expect((await firstAdapter.refreshCampaigns()).map((campaign) => campaign.id)).toEqual(["campaign"]);
    dashboardIds = [];
    const secondAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState });
    const campaigns = await secondAdapter.refreshCampaigns();

    expect(campaigns).toEqual([]);

    dashboardFails = true;
    const thirdAdapter = new TwitchAdapter(fetcher, undefined, undefined, { discoveryState });
    const failedCampaigns = await thirdAdapter.refreshCampaigns();

    expect(failedCampaigns).toEqual([]);
  });

  it("keeps a successful empty first dashboard authoritative when the reward-campaign fallback fails", async () => {
    let refresh = 1;
    let fallbackDashboard = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") {
        if (refresh === 1) return twitchDashboard(["retained"]);
        if (fallbackDashboard) throw new Error("reward-campaign dashboard unavailable");
        fallbackDashboard = true;
        return twitchDashboard([]);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["retained"]);
    refresh = 2;

    const campaigns = await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

    expect(campaigns).toEqual([]);
  });

  it("keeps a successful empty dashboard authoritative when the reward-campaign inventory fallback fails", async () => {
    let refresh = 1;
    let fallbackInventoryFails = false;
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      const variables = requestBody(init).variables as { fetchRewardCampaigns?: boolean };
      if (op === "Inventory") {
        if (fallbackInventoryFails && variables.fetchRewardCampaigns) {
          throw new Error("reward-campaign inventory unavailable");
        }
        return twitchInventory([]);
      }
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("dashboard unavailable");
        return twitchDashboard(refresh === 1 ? ["retained"] : []);
      }
      if (op === "DropCampaignDetails") {
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["retained"]);
    refresh = 2;
    fallbackInventoryFails = true;

    await expect(new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .resolves.toEqual([]);

    fallbackInventoryFails = false;
    dashboardFails = true;
    await expect(new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .resolves.toEqual([]);
  });

  it("still propagates authentication failures from the reward-campaign inventory fallback", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      const variables = requestBody(init).variables as { fetchRewardCampaigns?: boolean };
      if (op === "Inventory") {
        if (variables.fetchRewardCampaigns) {
          throw new SafeFetchError({ kind: "authentication_rejected", status: 401, reason: "rejected" });
        }
        return twitchInventory([]);
      }
      if (op === "ViewerDropsDashboard") return twitchDashboard([]);
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(new TwitchAdapter(fetcher).refreshCampaigns()).rejects.toThrow(SafeFetchError);
  });

  it("does not reuse discovery retained for another authenticated Twitch user", async () => {
    let userId = "user-a";
    let dashboardFails = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([], userId);
      if (op === "ViewerDropsDashboard") {
        if (dashboardFails) throw new Error("dashboard unavailable");
        return twitchDashboard(["user-a-campaign"], userId);
      }
      if (op === "DropCampaignDetails") {
        if (dashboardFails) throw new Error("details unavailable");
        return twitchCampaignDetails(String((requestBody(init).variables as Record<string, unknown>).dropID));
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["user-a-campaign"]);
    userId = "user-b";
    dashboardFails = true;

    const campaigns = await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

    expect(campaigns).toEqual([]);
  });

  it("does not reuse campaign details retained for another authenticated Twitch user", async () => {
    let userId = "user-a";
    let detailsFail = false;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([], userId);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["shared-campaign-id"], userId);
      if (op === "DropCampaignDetails") {
        if (detailsFail) throw new Error("details unavailable");
        return twitchCampaignDetails("shared-campaign-id");
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["shared-campaign-id"]);
    userId = "user-b";
    detailsFail = true;

    const campaigns = await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns();

    expect(campaigns).toEqual([]);
  });

  it("marks inventory campaigns expired when a successful dashboard contains only ended campaigns", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory(["ended"]);
      if (op === "ViewerDropsDashboard") {
        return {
          data: {
            currentUser: {
              id: "user-id",
              login: "viewer",
              dropCampaigns: [{ id: "ended", status: "EXPIRED" }],
            },
          },
        };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ id: "ended", status: "expired", eligibility: "expired" });
  });

  it("does not reuse retained campaign details after Twitch authoritatively returns no campaign", async () => {
    let detailResponse: "campaign" | "missing" | "failure" = "campaign";
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["campaign"]);
      if (op === "DropCampaignDetails") {
        if (detailResponse === "failure") throw new Error("details unavailable");
        if (detailResponse === "missing") return { data: { dropCampaign: null } };
        return twitchCampaignDetails("campaign");
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const discoveryState = new TwitchDiscoveryState();

    expect((await new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .map((campaign) => campaign.id)).toEqual(["campaign"]);
    detailResponse = "missing";
    await expect(new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .resolves.toEqual([]);
    detailResponse = "failure";

    await expect(new TwitchAdapter(fetcher, undefined, undefined, { discoveryState }).refreshCampaigns())
      .resolves.toEqual([]);
  });

  it("prunes expired retained campaign details during a later write", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-07-26T12:00:00.000Z");
      const discoveryState = new TwitchDiscoveryState();
      const details = (discoveryState as unknown as {
        campaignDetailsByDropId: Map<string, unknown>;
      }).campaignDetailsByDropId;

      discoveryState.rememberCampaignDetails("expired", { id: "expired" });
      vi.setSystemTime("2026-07-26T12:31:00.000Z");
      discoveryState.rememberCampaignDetails("fresh", { id: "fresh" });

      expect([...details.keys()]).toEqual(["fresh"]);
    } finally {
      vi.useRealTimers();
    }
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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

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

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

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

    await expect(new TwitchAdapter(fetcher).refreshCampaigns()).rejects.toThrow("permission denied");
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

  it("keeps the v1 inventory hash, variables, inline fallback, and parser paired", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/twitch-inventory-v1.json", import.meta.url), "utf8"));
    const inventoryBodies: Record<string, unknown>[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        const body = requestBody(init);
        inventoryBodies.push(body);
        return inventoryBodies.length === 1
          ? { errors: [{ message: "PersistedQueryNotFound" }] }
          : fixture;
      }
      if (op === "ViewerDropsDashboard") return { data: { currentUser: { dropCampaigns: [] } } };
      throw new Error(`Unexpected op ${op}`);
    });

    const campaigns = await new TwitchAdapter(fetcher).refreshCampaigns();

    expect(inventoryBodies).toHaveLength(2);
    expect(inventoryBodies[0]).toMatchObject({
      variables: { fetchRewardCampaigns: false },
      extensions: { persistedQuery: { sha256Hash: "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b" } },
    });
    expect(inventoryBodies[1]).toMatchObject({
      variables: { fetchRewardCampaigns: false },
      query: expect.stringContaining("dropCampaignsInProgress"),
    });
    expect(campaigns.map((campaign) => campaign.id)).toEqual(["active-campaign", "owned-campaign"]);
  });

  it("constructs the resolved inventory capability once and reuses it for requests, fallback, and parsing", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/twitch-inventory-v1.json", import.meta.url), "utf8"));
    const events: EngineEvent[] = [];
    let inventorySelectionReads = 0;
    const compatibility = {
      profile: "twitch-2026-07" as const,
      heartbeat: "twitch-heartbeat-spade-v1" as const,
      get inventory() {
        inventorySelectionReads += 1;
        return "twitch-inventory-v1" as const;
      },
    };
    let inventoryAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory") {
        inventoryAttempts += 1;
        return inventoryAttempts === 1
          ? { errors: [{ message: "PersistedQueryNotFound" }] }
          : fixture;
      }
      if (op === "ViewerDropsDashboard") return { data: { currentUser: { dropCampaigns: [] } } };
      throw new Error(`Unexpected op ${op}`);
    });

    const adapter = new TwitchAdapter(
      fetcher,
      undefined,
      undefined,
      { compatibility },
      (event) => events.push(event),
    );
    const campaigns = await adapter.refreshCampaigns();

    expect(inventorySelectionReads).toBe(1);
    expect(campaigns.map((campaign) => campaign.id)).toEqual(["active-campaign", "owned-campaign"]);
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      message: expect.stringContaining("twitch-inventory-v1"),
    }));
  });

  it("surfaces Twitch's top-level {error,message} auth failures", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      if (operation(init) === "Inventory") return { error: "Unauthorized", message: "invalid OAuth token" };
      throw new Error(`Unexpected op ${operation(init)}`);
    });

    await expect(new TwitchAdapter(fetcher).refreshCampaigns())
      .rejects.toMatchObject({
        failure: { kind: "authentication_rejected", status: 401 },
      });
  });

  it("guides signed-out users when inventory returns a null current user", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "Inventory" || op === "ViewerDropsDashboard") {
        return { data: { currentUser: null } };
      }
      throw new Error(`Unexpected op ${op}`);
    });

    await expect(new TwitchAdapter(fetcher).refreshCampaigns())
      .rejects.toThrow("Twitch did not return a logged-in current user; open twitch.tv and confirm you are signed in");
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

    await expect(adapter.refreshCampaigns())
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
      { campaign: { categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      candidate: { categoryId: "game", categoryName: "Game", viewerCount: 789, displayName: "Creator" },
    });
  });

  it("confirms the selected campaign is available on the Twitch channel", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game", name: "Game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        expect(requestBody(init).variables).toEqual({ channelID: "channel-id" });
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator", isAclMatch: true },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: true,
      candidate: { channelId: "channel-id" },
    });
  });

  it("rejects a Twitch channel that explicitly does not offer the selected campaign", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        return { data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "other" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: false,
      reason: "Twitch campaign is not available on this channel",
    });
  });

  it("falls back to live/category validation when Twitch campaign availability is unavailable", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") throw new Error("availability unavailable");
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: undefined,
    });
  });

  it("treats malformed Twitch campaign availability as a soft fallback", async () => {
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        return { data: { channel: { id: "channel-id" } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: true,
      categoryMatches: true,
      campaignMatches: undefined,
    });
  });

  it("retries stale Twitch campaign availability hashes with an inline query", async () => {
    let availabilityAttempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      if (op === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
      }
      if (op === "DropsHighlightService_AvailableDrops") {
        availabilityAttempts += 1;
        const body = requestBody(init);
        if (!body.query) return { errors: [{ message: "PersistedQueryNotFound" }] };
        expect(body.query).toContain("viewerDropCampaigns");
        return { data: { channel: { viewerDropCampaigns: [{ id: "campaign" }] } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({ campaignMatches: true });
    expect(availabilityAttempts).toBe(2);
  });

  it("caches positive and negative Twitch campaign availability for a bounded time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
      let availabilityCalls = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "StreamInfo") {
          return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
        }
        if (op === "DropsHighlightService_AvailableDrops") {
          availabilityCalls += 1;
          return { data: { channel: { viewerDropCampaigns: [{ id: "available" }] } } };
        }
        throw new Error(`Unexpected op ${op}`);
      });
      const adapter = new TwitchAdapter(fetcher);
      const candidate = { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" } as const;

      await expect(adapter.checkChannel(candidate, {
        campaign: { id: "available", categoryId: "game" } as DropCampaign,
      }))
        .resolves.toMatchObject({ campaignMatches: true });
      await expect(adapter.checkChannel(candidate, {
        campaign: { id: "missing", categoryId: "game" } as DropCampaign,
      }))
        .resolves.toMatchObject({ campaignMatches: false });
      expect(availabilityCalls).toBe(1);

      vi.advanceTimersByTime(60_001);
      await adapter.checkChannel(candidate, {
        campaign: { id: "available", categoryId: "game" } as DropCampaign,
      });
      expect(availabilityCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("trusts drops-enabled directory liveness and confirms only the selected candidate", async () => {
    const operations: string[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      operations.push(operation(init));
      return { data: { channel: { viewerDropCampaigns: [{ id: "campaign" }] } } };
    });
    const adapter = new TwitchAdapter(fetcher);
    const candidate = {
      platform: "twitch" as const,
      username: "directory-winner",
      url: "https://www.twitch.tv/directory-winner",
      channelId: "winner-id",
      categoryId: "game",
      live: true,
      isAclMatch: false,
    };

    const selection = await adapter.selectCandidateChannel?.(
      [candidate],
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("directory-winner");
    expect(operations).toEqual(["DropsHighlightService_AvailableDrops"]);
  });

  it("batches campaign availability checks for trusted directory candidates", async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => ({
      platform: "twitch" as const,
      username: `directory-${index}`,
      url: `https://www.twitch.tv/directory-${index}`,
      channelId: `channel-${index}`,
      categoryId: "game",
      live: true,
      isAclMatch: false,
    }));
    const availabilityBatchSizes: number[] = [];
    const diagnostics: string[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      const operations = body as Array<Record<string, unknown>>;
      expect(operations.every((entry) =>
        entry.operationName === "DropsHighlightService_AvailableDrops")).toBe(true);
      availabilityBatchSizes.push(operations.length);
      return operations.map((entry) => {
        const channelId = String((entry.variables as { channelID?: string }).channelID);
        return {
          data: {
            channel: {
              viewerDropCampaigns: channelId === "channel-23" ? [{ id: "campaign" }] : [],
            },
          },
        };
      });
    });

    const selection = await new TwitchAdapter(fetcher, undefined, undefined, {}, (event) => {
      if (event.category === "diagnostic") diagnostics.push(event.message);
    }).selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("directory-23");
    expect(availabilityBatchSizes).toEqual([20, 4]);
    expect(diagnostics.some((message) =>
      message.includes("2 AvailableDrops batch requests, 0 AvailableDrops single fallbacks"))).toBe(true);
  });

  it("bounds single AvailableDrops fallbacks when Twitch rejects availability batches", async () => {
    const candidates = Array.from({ length: 24 }, (_, index) => ({
      platform: "twitch" as const,
      username: `directory-${index}`,
      url: `https://www.twitch.tv/directory-${index}`,
      channelId: `channel-${index}`,
      categoryId: "game",
      live: true,
      isAclMatch: false,
    }));
    let activeSingles = 0;
    let maxActiveSingles = 0;
    let singleCalls = 0;
    const fetcher = jsonFetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) throw new Error("batch unavailable");
      expect(body.operationName).toBe("DropsHighlightService_AvailableDrops");
      singleCalls += 1;
      activeSingles += 1;
      maxActiveSingles = Math.max(maxActiveSingles, activeSingles);
      await Promise.resolve();
      activeSingles -= 1;
      return { data: { channel: { viewerDropCampaigns: [] } } };
    });

    await new TwitchAdapter(fetcher).selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(singleCalls).toBe(24);
    expect(maxActiveSingles).toBeLessThanOrEqual(2);
  });

  it("batches ACL StreamInfo and AvailableDrops checks", async () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      platform: "twitch" as const,
      username: `acl-${index}`,
      url: `https://www.twitch.tv/acl-${index}`,
      isAclMatch: true,
    }));
    const streamBatchSizes: number[] = [];
    const availabilityBatchSizes: number[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        const operationName = String(body[0]?.operationName);
        if (operationName === "DropsHighlightService_AvailableDrops") {
          availabilityBatchSizes.push(body.length);
          return body.map(() => ({
            data: { channel: { viewerDropCampaigns: [{ id: "campaign" }] } },
          }));
        }
        expect(operationName).toBe("StreamInfo");
        expect(init?.credentials).toBe("omit");
        streamBatchSizes.push(body.length);
        return body.map((entry) => {
          const username = String((entry.variables as { channel?: string }).channel);
          return {
            data: {
              user: {
                id: `${username}-id`,
                displayName: username,
                stream: { id: `${username}-broadcast`, game: { id: "game", name: "Game" } },
              },
            },
          };
        });
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    const selection = await adapter.selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("acl-0");
    expect(streamBatchSizes).toEqual([20, 5]);
    expect(availabilityBatchSizes).toEqual([20, 5]);
  });

  it("bounds single StreamInfo fallbacks when Twitch rejects channel batches", async () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      platform: "twitch" as const,
      username: `fallback-${index}`,
      url: `https://www.twitch.tv/fallback-${index}`,
      isAclMatch: true,
    }));
    let activeSingles = 0;
    let maxActiveSingles = 0;
    let singleCalls = 0;
    const diagnostics: string[] = [];
    const fetcher = jsonFetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) throw new Error("batch unavailable");
      if (body.operationName === "StreamInfo") {
        singleCalls += 1;
        activeSingles += 1;
        maxActiveSingles = Math.max(maxActiveSingles, activeSingles);
        await Promise.resolve();
        activeSingles -= 1;
        const username = String((body.variables as { channel?: string }).channel);
        return {
          data: {
            user: {
              id: `${username}-id`,
              stream: { id: `${username}-broadcast`, game: { id: "other-game" } },
            },
          },
        };
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });
    const adapter = new TwitchAdapter(fetcher, undefined, undefined, {}, (event) => {
      if (event.category === "diagnostic") diagnostics.push(event.message);
    });

    await adapter.selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(singleCalls).toBe(25);
    expect(maxActiveSingles).toBeLessThanOrEqual(2);
    expect(diagnostics.some((message) =>
      message.includes("25 StreamInfo single fallbacks"))).toBe(true);
  });

  it("checks the next batched candidate after Twitch rejects campaign availability", async () => {
    const candidates = ["first", "second"].map((username) => ({
      platform: "twitch" as const,
      username,
      url: `https://www.twitch.tv/${username}`,
      isAclMatch: true,
    }));
    const availabilityChannels: string[] = [];
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(body)) {
        return body.map((entry) => {
          const username = String((entry.variables as { channel?: string }).channel);
          return {
            data: {
              user: {
                id: `${username}-id`,
                stream: { id: `${username}-broadcast`, game: { id: "game" } },
              },
            },
          };
        });
      }
      if (body.operationName === "DropsHighlightService_AvailableDrops") {
        const channelId = String((body.variables as { channelID?: string }).channelID);
        availabilityChannels.push(channelId);
        return {
          data: {
            channel: {
              viewerDropCampaigns: channelId === "second-id" ? [{ id: "campaign" }] : [],
            },
          },
        };
      }
      throw new Error(`Unexpected operation ${String(body.operationName)}`);
    });

    const selection = await new TwitchAdapter(fetcher).selectCandidateChannel?.(
      candidates,
      { id: "campaign", categoryId: "game" } as DropCampaign,
    );

    expect(selection?.channel?.username).toBe("second");
    expect(availabilityChannels).toEqual(["first-id", "second-id"]);
  });

  it("falls back to Twitch channel page data when stream info GQL fails", async () => {
    const abort = new AbortController();
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://gql.twitch.tv/gql" && operation(init) === "StreamInfo") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      if (url === "https://www.twitch.tv/creator") {
        expect(init?.signal).toBe(abort.signal);
        return { html: '{"isLiveBroadcast":true,"game":{"id":"game","name":"Game"}}' };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { categoryId: "game" } as DropCampaign, signal: abort.signal },
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
      { campaign: { categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: false,
      categoryMatches: false,
      reason: "PersistedQueryNotFound",
    });
  });

  it("treats a Twitch channel as offline when the page fallback shows no live signal", async () => {
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://gql.twitch.tv/gql" && operation(init) === "StreamInfo") {
        return { errors: [{ message: "PersistedQueryNotFound" }] };
      }
      if (url === "https://www.twitch.tv/creator") {
        return { html: "<html><body>nothing recognizable</body></html>" };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    await expect(adapter.checkChannel(
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
      { campaign: { categoryId: "game" } as DropCampaign },
    )).resolves.toMatchObject({
      live: false,
      reason: "Twitch GQL check failed; used channel page fallback",
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

    const progress = await adapter.refreshCampaigns({
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
      if (op === "ViewerDropsDashboard") return twitchDashboard([]);
      if (op === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { id: "channel-id", stream: { game: { id: "game" } } } } };
      }
      if (op === "DropCurrentSessionContext") {
        return { data: { currentUser: { dropCurrentSession: { dropID: "drop", currentMinutesWatched: 60 } } } };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    const adapter = new TwitchAdapter(fetcher);

    const progress = await adapter.refreshCampaigns({
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

  it("searches categories via inline GQL and maps id/name/box art", async () => {
    const fetcher = jsonFetcher((url, init) => {
      expect(url).toBe("https://gql.twitch.tv/gql");
      const body = requestBody(init);
      expect(body.operationName).toBe("SearchCategories");
      expect(body.variables).toMatchObject({ query: "fort" });
      // Sent inline (no persisted hash) so it keeps working without registration.
      expect(typeof body.query).toBe("string");
      return {
        data: {
          searchCategories: {
            edges: [
              { node: { id: "33214", displayName: "Fortnite", boxArtURL: "https://art/fortnite-{width}x{height}.jpg" } },
              { node: { id: "", displayName: "skip-me" } },
            ],
          },
        },
      };
    });

    await expect(new TwitchAdapter(fetcher).searchCategories("fort")).resolves.toEqual([
      { id: "33214", name: "Fortnite", imageUrl: "https://art/fortnite-144x192.jpg" },
    ]);
  });
});

describe("TwitchAdapter client identity", () => {
  const emptyCategories = { data: { searchCategories: { edges: [] } } };

  it("sends an injected non-web Client-ID + matching User-Agent on GQL requests", async () => {
    let captured: RequestInit | undefined;
    const adapter = new TwitchAdapter(
      jsonFetcher((_url, init) => { captured = init; return emptyCategories; }),
      undefined,
      undefined,
      { clientId: "kd1unb4b3q4t58fwlpcbzcbnm76a8fp", userAgent: "Dalvik/android-app" },
    );
    await adapter.searchCategories("rust");
    const headers = captured?.headers as Record<string, string>;
    expect(headers["Client-ID"]).toBe("kd1unb4b3q4t58fwlpcbzcbnm76a8fp");
    expect(headers["User-Agent"]).toBe("Dalvik/android-app");
  });

  it("defaults to the web Client-ID and omits the User-Agent (extension behavior)", async () => {
    let captured: RequestInit | undefined;
    await new TwitchAdapter(jsonFetcher((_url, init) => { captured = init; return emptyCategories; })).searchCategories("rust");
    const headers = captured?.headers as Record<string, string>;
    expect(headers["Client-ID"]).toBe("kimne78kx3ncx6brgo4mv6wki5h1ko");
    expect(headers["User-Agent"]).toBeUndefined();
  });
});

// Twitch can reject an authenticated request with "failed integrity check" even
// while the session is healthy and the captured token has not locally expired.
// Recovery is a single forced refresh plus a single identical retry — never a
// loop, never for anonymous requests, and never for other failure kinds.
describe("TwitchAdapter integrity recovery", () => {
  const INTEGRITY_REJECTION = { error: "failed integrity check" };

  // Models the real callback contract: only a forced request can produce a token
  // different from the one Twitch just rejected.
  function integrityCallback() {
    return vi.fn(async (request?: { forceRefresh?: boolean }) => request?.forceRefresh === true);
  }

  // Rejects the named operation on its first call only, then serves `payload`.
  function rejectFirst(target: string, payload: (init?: RequestInit) => unknown) {
    const attempts = new Map<string, number>();
    const fetcher = jsonFetcher((_url, init) => {
      const op = operation(init);
      attempts.set(op, (attempts.get(op) ?? 0) + 1);
      if (op === target && attempts.get(op) === 1) return INTEGRITY_REJECTION;
      return payload(init);
    });
    return { fetcher, attempts };
  }

  // The refresh bound is only sound if the token it compares against is the one
  // the failed request actually sent. The transport therefore attaches integrity
  // itself and stamps the failure with what it used: re-reading a global in the
  // catch would race a concurrent capture, report a token the request never
  // carried, and — because that token differs from the current one — convince the
  // forced refresh the rejection had already been handled.
  it("reports the integrity token the rejected request actually carried", async () => {
    // A fresh token on every read, so a value snapshotted anywhere other than at
    // send time cannot coincidentally match what went out.
    let minted = 0;
    const currentIntegrity = () => {
      minted += 1;
      return { integrity: `token-${minted}`, deviceId: "device", clientSessionId: "session", expiresAt: Date.now() + 60_000 };
    };
    const sent: Array<string | null> = [];
    const ensureIntegrity = integrityCallback();
    let attempts = 0;
    const fetcher = jsonFetcher((_url, init) => {
      sent.push(new Headers(init?.headers as HeadersInit).get("client-integrity"));
      attempts += 1;
      return attempts === 1 ? INTEGRITY_REJECTION : { data: { currentUser: { id: "u" } } };
    });

    await new TwitchAdapter(fetcher, ensureIntegrity, undefined, { currentIntegrity }).checkAuthHealth();

    expect(sent[0]).toBe("token-1");
    expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
      forceRefresh: true,
      reason: "rejection_recovery",
      rejectedToken: sent[0],
    }));
  });

  it("sends the integrity trio together so the replayed token stays bound to its identity", async () => {
    const currentIntegrity = () => ({
      integrity: "bound-token",
      deviceId: "bound-device",
      clientSessionId: "bound-session",
      expiresAt: Date.now() + 60_000,
    });
    let seen: Headers | undefined;
    const fetcher = jsonFetcher((_url, init) => {
      seen = new Headers(init?.headers as HeadersInit);
      return { data: { currentUser: { id: "u" } } };
    });

    await new TwitchAdapter(fetcher, undefined, undefined, { currentIntegrity }).checkAuthHealth();

    expect(seen?.get("client-integrity")).toBe("bound-token");
    expect(seen?.get("x-device-id")).toBe("bound-device");
    expect(seen?.get("client-session-id")).toBe("bound-session");
  });

  describe("safe authenticated reads", () => {
    const dropID = (init?: RequestInit) =>
      String((requestBody(init).variables as Record<string, unknown>).dropID);

    const discoveryPayload = (init?: RequestInit) => {
      const op = operation(init);
      if (op === "Inventory") return twitchInventory([]);
      if (op === "ViewerDropsDashboard") return twitchDashboard(["campaign"]);
      if (op === "DropCampaignDetails") return twitchCampaignDetails(dropID(init));
      throw new Error(`Unexpected op ${op}`);
    };

    it.each(["ViewerDropsDashboard", "Inventory", "DropCampaignDetails"])(
      "refreshes integrity once and retries %s once during discovery",
      async (target) => {
        const ensureIntegrity = integrityCallback();
        const { fetcher, attempts } = rejectFirst(target, discoveryPayload);

        const campaigns = await new TwitchAdapter(fetcher, ensureIntegrity).refreshCampaigns();

        expect(campaigns.map((campaign) => campaign.id)).toEqual(["campaign"]);
        expect(ensureIntegrity).toHaveBeenCalledOnce();
        expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
          forceRefresh: true,
          reason: "rejection_recovery",
        }));
        expect(attempts.get(target)).toBe(2);
      },
    );

    it("recovers the dashboard without warning about retained campaigns", async () => {
      const events: EngineEvent[] = [];
      const ensureIntegrity = integrityCallback();
      const { fetcher } = rejectFirst("ViewerDropsDashboard", discoveryPayload);

      const campaigns = await new TwitchAdapter(
        fetcher,
        ensureIntegrity,
        undefined,
        {},
        (event) => events.push(event),
      ).refreshCampaigns();

      expect(campaigns.map((campaign) => campaign.id)).toEqual(["campaign"]);
      expect(events).not.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("reusing the last campaign list"),
      }));
    });

    it("falls back to retained campaigns when the forced refresh fails", async () => {
      const events: EngineEvent[] = [];
      const ensureIntegrity = vi.fn(async () => false);
      let dashboardAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "Inventory") return twitchInventory([]);
        if (op === "ViewerDropsDashboard") {
          dashboardAttempts += 1;
          return INTEGRITY_REJECTION;
        }
        if (op === "DropCampaignDetails") return twitchCampaignDetails(dropID(init));
        throw new Error(`Unexpected op ${op}`);
      });

      await new TwitchAdapter(fetcher, ensureIntegrity, undefined, {}, (event) => events.push(event))
        .refreshCampaigns();

      // Discovery makes two dashboard requests when both lists come back empty
      // (the second asks for reward campaigns). Each gets one refresh attempt
      // and, because the refresh failed, no retry at all.
      expect(ensureIntegrity).toHaveBeenCalledTimes(2);
      expect(ensureIntegrity.mock.calls).toEqual([
        [expect.objectContaining({ forceRefresh: true, reason: "rejection_recovery" })],
        [expect.objectContaining({ forceRefresh: true, reason: "rejection_recovery" })],
      ]);
      expect(dashboardAttempts).toBe(2);
      expect(events).toContainEqual(expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("reusing the last campaign list"),
      }));
    });

    it("stops after one retry when the refreshed token is rejected again", async () => {
      const ensureIntegrity = integrityCallback();
      let dashboardAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "Inventory") return twitchInventory([]);
        if (op === "ViewerDropsDashboard") {
          dashboardAttempts += 1;
          return INTEGRITY_REJECTION;
        }
        throw new Error(`Unexpected op ${op}`);
      });

      await new TwitchAdapter(fetcher, ensureIntegrity).refreshCampaigns();

      // Two dashboard requests, each bounded to exactly one refresh and one
      // retry — the second rejection is never refreshed or replayed again.
      expect(ensureIntegrity).toHaveBeenCalledTimes(2);
      expect(dashboardAttempts).toBe(4);
    });

    it("does not enter integrity recovery for a generic dashboard failure", async () => {
      const ensureIntegrity = integrityCallback();
      let dashboardAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "Inventory") return twitchInventory([]);
        if (op === "ViewerDropsDashboard") {
          dashboardAttempts += 1;
          throw new Error("dashboard unavailable");
        }
        throw new Error(`Unexpected op ${op}`);
      });

      await new TwitchAdapter(fetcher, ensureIntegrity).refreshCampaigns();

      // Both dashboard requests fail generically: no refresh, and no replay of
      // either request.
      expect(ensureIntegrity).not.toHaveBeenCalled();
      expect(dashboardAttempts).toBe(2);
    });

    it("refreshes integrity once and retries DirectoryPage_Game once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("DirectoryPage_Game", () => ({
        data: {
          game: {
            streams: {
              edges: [{ node: { broadcaster: { login: "Creator", displayName: "Creator" }, viewersCount: 5 } }],
            },
          },
        },
      }));

      const candidates = await new TwitchAdapter(fetcher, ensureIntegrity)
        .listCandidateChannels({ id: "campaign", slug: "game-slug" } as DropCampaign);

      expect(candidates.map((candidate) => candidate.username)).toEqual(["creator"]);
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
      expect(attempts.get("DirectoryPage_Game")).toBe(2);
    });

    it("refreshes integrity once and retries DropsHighlightService_AvailableDrops once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("DropsHighlightService_AvailableDrops", (init) => {
        const op = operation(init);
        if (op === "StreamInfo") {
          return { data: { user: { id: "channel-id", displayName: "Creator", stream: { id: "b", game: { id: "game" } } } } };
        }
        if (op === "DropsHighlightService_AvailableDrops") {
          return { data: { channel: { viewerDropCampaigns: [{ id: "campaign" }] } } };
        }
        throw new Error(`Unexpected op ${op}`);
      });

      const check = await new TwitchAdapter(fetcher, ensureIntegrity).checkChannel(
        { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
        { campaign: { id: "campaign", categoryId: "game" } as DropCampaign },
      );

      expect(check.campaignMatches).toBe(true);
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
      expect(attempts.get("DropsHighlightService_AvailableDrops")).toBe(2);
    });

    it.each(["VideoPlayerStreamInfoOverlayChannel", "DropCurrentSessionContext"])(
      "refreshes integrity once and retries %s once while merging session progress",
      async (target) => {
        const ensureIntegrity = integrityCallback();
        const { fetcher, attempts } = rejectFirst(target, (init) => {
          const op = operation(init);
          if (op === "Inventory") return twitchInventory(["campaign"]);
          if (op === "ViewerDropsDashboard") return twitchDashboard([]);
          if (op === "VideoPlayerStreamInfoOverlayChannel") return { data: { user: { id: "channel-id" } } };
          if (op === "DropCurrentSessionContext") {
            return { data: { currentUser: { dropCurrentSession: { dropID: "campaign-drop", currentMinutesWatched: 42 } } } };
          }
          throw new Error(`Unexpected op ${op}`);
        });
        const progressed = await new TwitchAdapter(fetcher, ensureIntegrity).refreshCampaigns({
          platform: "twitch",
          status: "watching",
          offlineChecks: 0,
          channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
        } as never);

        expect(progressed[0]?.rewards[0]?.watchedMinutes).toBe(42);
        expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
          forceRefresh: true,
          reason: "rejection_recovery",
        }));
        expect(attempts.get(target)).toBe(2);
      },
    );

    it("refreshes integrity once and retries the authenticated CurrentUser probe once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("CurrentUser", () => ({
        data: { currentUser: { id: "user-id" } },
      }));

      const health = await new TwitchAdapter(fetcher, ensureIntegrity).checkAuthHealth();

      expect(health.status).toBe("healthy");
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
      expect(attempts.get("CurrentUser")).toBe(2);
    });
  });

  describe("anonymous reads", () => {
    it.each([
      ["StreamInfo", (adapter: TwitchAdapter) => adapter.checkChannel({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" })],
      ["SearchCategories", (adapter: TwitchAdapter) => adapter.searchCategories("rust")],
    ])("keeps %s anonymous and never acquires integrity", async (target, run) => {
      const ensureIntegrity = integrityCallback();
      let captured: RequestInit | undefined;
      let attempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        if (operation(init) !== target) throw new Error(`Unexpected op ${operation(init)}`);
        captured = init;
        attempts += 1;
        return INTEGRITY_REJECTION;
      });

      await run(new TwitchAdapter(fetcher, ensureIntegrity)).catch(() => undefined);

      expect(captured?.credentials).toBe("omit");
      expect(ensureIntegrity).not.toHaveBeenCalled();
      // Anonymous requests must not be replayed by integrity recovery.
      expect(attempts).toBe(1);
    });
  });

  describe("mutations", () => {
    const reward = {
      id: "drop",
      name: "Reward",
      requiredMinutes: 60,
      watchedMinutes: 60,
      status: "claimable",
      claimId: "instance-id",
    } as DropReward;

    it("forces a genuinely fresh token before retrying a rejected drop claim", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("DropsPage_ClaimDropRewards", () => ({
        data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } },
      }));

      await expect(new TwitchAdapter(fetcher, ensureIntegrity)
        .claimReward({ id: "campaign" } as DropCampaign, reward)).resolves.toBe(true);

      expect(attempts.get("DropsPage_ClaimDropRewards")).toBe(2);
      // Proactive fast path first, then an explicit forced refresh.
      expect(ensureIntegrity.mock.calls).toEqual([
        [{ signal: undefined }],
        [{
          forceRefresh: true,
          reason: "rejection_recovery",
          rejectedToken: undefined,
          signal: undefined,
        }],
      ]);
    });

    it("recovers the channel-points context through the safe-read path", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("ChannelPointsContext", (init) => {
        const op = operation(init);
        if (op === "ChannelPointsContext") {
          return { data: { community: { channel: { id: "channel-id", self: { communityPoints: { availableClaim: { id: "claim-id" } } } } } } };
        }
        if (op === "ClaimCommunityPoints") return { data: { claimCommunityPoints: { status: "SUCCESS" } } };
        throw new Error(`Unexpected op ${op}`);
      });

      await expect(new TwitchAdapter(fetcher, ensureIntegrity).claimChannelPoints({
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      })).resolves.toBe(true);

      expect(attempts.get("ChannelPointsContext")).toBe(2);
      expect(ensureIntegrity).toHaveBeenCalledWith(expect.objectContaining({
        forceRefresh: true,
        reason: "rejection_recovery",
      }));
    });

    it("ensures integrity before the channel-points mutation and retries it exactly once", async () => {
      const ensureIntegrity = integrityCallback();
      const { fetcher, attempts } = rejectFirst("ClaimCommunityPoints", (init) => {
        const op = operation(init);
        if (op === "ChannelPointsContext") {
          return { data: { community: { channel: { id: "channel-id", self: { communityPoints: { availableClaim: { id: "claim-id" } } } } } } };
        }
        if (op === "ClaimCommunityPoints") return { data: { claimCommunityPoints: { status: "SUCCESS" } } };
        throw new Error(`Unexpected op ${op}`);
      });

      await expect(new TwitchAdapter(fetcher, ensureIntegrity).claimChannelPoints({
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      })).resolves.toBe(true);

      expect(attempts.get("ClaimCommunityPoints")).toBe(2);
      expect(ensureIntegrity.mock.calls).toEqual([
        [{ signal: undefined }],
        [{
          forceRefresh: true,
          reason: "rejection_recovery",
          rejectedToken: undefined,
          signal: undefined,
        }],
      ]);
    });

    it("propagates a second channel-points rejection without a third attempt", async () => {
      const ensureIntegrity = integrityCallback();
      let claimAttempts = 0;
      const fetcher = jsonFetcher((_url, init) => {
        const op = operation(init);
        if (op === "ChannelPointsContext") {
          return { data: { community: { channel: { id: "channel-id", self: { communityPoints: { availableClaim: { id: "claim-id" } } } } } } };
        }
        if (op === "ClaimCommunityPoints") {
          claimAttempts += 1;
          return INTEGRITY_REJECTION;
        }
        throw new Error(`Unexpected op ${op}`);
      });

      await expect(new TwitchAdapter(fetcher, ensureIntegrity).claimChannelPoints({
        platform: "twitch",
        username: "creator",
        url: "https://www.twitch.tv/creator",
      })).rejects.toThrow(/integrity/i);

      expect(claimAttempts).toBe(2);
    });
  });
});
