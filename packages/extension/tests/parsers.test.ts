import { describe, expect, it } from "vitest";
import { mergeKickProgress, parseKickCampaigns } from "@lurkloot/core/kick/parser";
import { campaignHasClaimableReward, mergeTwitchCampaignProgress, parseTwitchInventory, withCampaignStatus } from "@lurkloot/core/twitch/parser";

describe("Kick parsers", () => {
  it("normalizes campaigns and merges progress", () => {
    const campaigns = parseKickCampaigns({
      data: [{
        id: 10,
        name: "Kick Drops",
        category_id: 42,
        channels: [{ slug: "creator" }],
        rewards: [{ id: 99, name: "Skin", required_minutes: 30 }],
      }],
    });

    const merged = mergeKickProgress(campaigns, {
      progress: [{
        campaign_id: 10,
        reward_id: 99,
        watched_minutes: 30,
        claim_id: "claim-99",
      }],
    });

    expect(merged[0].allowedChannels).toEqual(["creator"]);
    expect(merged[0].connectionUrls).toEqual(["https://kick.com/creator"]);
    expect(merged[0].rewards[0].status).toBe("claimable");
    expect(merged[0].rewards[0].claimId).toBe("claim-99");
    expect(merged[0].rewards[0].isWatchBased).toBe(true);
  });

  it("resolves relative reward image paths to absolute ext.kick.com URLs", () => {
    const campaigns = parseKickCampaigns({
      data: [{
        id: 1,
        rewards: [
          { id: "rel", image_url: "drops/reward-image/abc.png", required_units: 60 },
          { id: "slashed", image_url: "/drops/reward-image/def.png", required_units: 60 },
          { id: "absolute", image_url: "https://files.kick.com/x.png", required_units: 60 },
          { id: "none", required_units: 60 },
        ],
      }],
    });

    const [rel, slashed, absolute, none] = campaigns[0].rewards;
    expect(rel.imageUrl).toBe("https://ext.kick.com/drops/reward-image/abc.png");
    expect(slashed.imageUrl).toBe("https://ext.kick.com/drops/reward-image/def.png");
    expect(absolute.imageUrl).toBe("https://files.kick.com/x.png");
    expect(none.imageUrl).toBeUndefined();
  });

  it("merges campaign-level Kick progress with nested rewards", () => {
    const campaigns = parseKickCampaigns({
      data: [{
        id: "campaign",
        status: "active",
        category: { id: "cat", name: "Game" },
        rewards: [{ id: "reward", name: "Reward", required_minutes: 100 }],
      }],
    });

    const merged = mergeKickProgress(campaigns, {
      data: [{
        id: "campaign",
        status: "in progress",
        category: { id: "cat2", name: "Updated Game" },
        rewards: [{ id: "reward", progress: 0.25, required_units: 100 }],
      }],
    });

    expect(merged[0].categoryId).toBe("cat2");
    expect(merged[0].gameName).toBe("Updated Game");
    expect(merged[0].rewards[0].watchedMinutes).toBe(25);
    expect(merged[0].rewards[0].status).toBe("in_progress");
  });

  it("uses the campaign-level progress_units counter for tiered Kick rewards", () => {
    // Mirrors the live /api/v1/drops/progress shape: one cumulative counter,
    // tiered rewards sharing it, no per-reward minutes or claim_id.
    const campaigns = parseKickCampaigns({
      data: [{
        id: "01CAMPAIGN",
        status: "active",
        category: { id: 13, name: "Rust", slug: "rust" },
        channels: [],
        rewards: [
          { id: "r1", name: "Box", required_units: 120 },
          { id: "r2", name: "Crossbow", required_units: 240 },
        ],
      }],
    });

    const merged = mergeKickProgress(campaigns, {
      data: [{
        id: "01CAMPAIGN",
        status: "active",
        user_app_connected: true,
        progress_units: 150,
        rewards: [
          { id: "r1", claimed: true, progress: 1, required_units: 120 },
          { id: "r2", claimed: false, progress: 0.625, required_units: 240 },
        ],
      }],
    });

    expect(merged[0].accountLinked).toBe(true);
    // Cumulative 150 min: first tier (120) complete and claimed, second (240) partway.
    expect(merged[0].rewards[0].watchedMinutes).toBe(120);
    expect(merged[0].rewards[0].status).toBe("claimed");
    expect(merged[0].rewards[1].watchedMinutes).toBe(150);
    expect(merged[0].rewards[1].status).toBe("in_progress");
  });

  it("gates a Kick campaign when the account app is not connected and surfaces the link URL", () => {
    const campaigns = parseKickCampaigns({
      data: [{ id: "c", status: "active", connect_url: "https://accounts.krafton.com/auth/kick/callback", rewards: [{ id: "r", required_units: 60 }] }],
    });
    // connect_url from the campaigns endpoint becomes the account-link URL.
    expect(campaigns[0].accountLinkUrl).toBe("https://accounts.krafton.com/auth/kick/callback");

    const merged = mergeKickProgress(campaigns, {
      data: [{ id: "c", user_app_connected: false, connect_url: "https://kick.facepunch.com", progress_units: 0, rewards: [{ id: "r", required_units: 60 }] }],
    });
    expect(merged[0].accountLinked).toBe(false);
    // The progress endpoint's connect_url wins when present (it is the live one).
    expect(merged[0].accountLinkUrl).toBe("https://kick.facepunch.com");
  });

  it("does not mark a first-party KICK drop unlinked when there is no connect URL", () => {
    // Football/ED'S-style drops report user_app_connected:false with an empty
    // connect_url — there is nothing to link, so they must stay linked. They do
    // carry an info `url` that should be surfaced.
    const campaigns = parseKickCampaigns({
      data: [{ id: "c", status: "active", connect_url: "", url: "https://about.kick.com/news-and-press/9-football_drop", rewards: [{ id: "r", required_units: 60 }] }],
    });
    expect(campaigns[0].url).toBe("https://about.kick.com/news-and-press/9-football_drop");

    const merged = mergeKickProgress(campaigns, {
      data: [{ id: "c", user_app_connected: false, connect_url: "", progress_units: 0, rewards: [{ id: "r", required_units: 60 }] }],
    });
    expect(merged[0].accountLinked).toBe(true);
  });

  it("normalizes bucketed Kick campaign and progress responses", () => {
    const campaigns = parseKickCampaigns({
      data: {
        active: [{
          id: "active-campaign",
          title: "Active Drops",
          category: { id: "game", name: "Game", slug: "game" },
          drops: [{ id: "reward", title: "Reward", minutes_required: 80 }],
        }],
        upcoming: [{
          id: "future-campaign",
          title: "Future Drops",
          start_date: "2999-01-01T00:00:00.000Z",
          rewards: [{ id: "future-reward", required_minutes: 30 }],
        }],
        expired: [{
          id: "expired-campaign",
          title: "Expired Drops",
          rewards: [{ id: "expired-reward", required_minutes: 30 }],
        }],
        completed: [{
          id: "completed-campaign",
          title: "Completed Drops",
          rewards: [{ id: "completed-reward", required_minutes: 30 }],
        }],
      },
    });

    const merged = mergeKickProgress(campaigns, {
      data: {
        current: [{
          campaign_id: "active-campaign",
          reward_id: "reward",
          percentage: 50,
        }],
      },
    });

    expect(merged.map((campaign) => campaign.id)).toEqual(["active-campaign", "future-campaign"]);
    expect(merged[0]).toMatchObject({
      status: "active",
      categoryId: "game",
      gameName: "Game",
      slug: "game",
      isGeneralDrop: true,
    });
    expect(merged[0].rewards[0]).toMatchObject({
      watchedMinutes: 40,
      status: "in_progress",
    });
    expect(merged[1].status).toBe("upcoming");
  });

  it("filters ended Kick campaigns from discovery", () => {
    const campaigns = parseKickCampaigns({
      data: {
        campaigns: [{
          id: "active-campaign",
          status: "active",
          endsAt: "2999-01-01T00:00:00.000Z",
          rewards: [{ id: "active-reward", required_minutes: 30 }],
        }, {
          id: "ended-status",
          status: "ended",
          rewards: [{ id: "ended-reward", required_minutes: 30 }],
        }, {
          id: "past-end",
          status: "active",
          endAt: "2020-01-01T00:00:00.000Z",
          rewards: [{ id: "past-reward", required_minutes: 30 }],
        }, {
          id: "finished-status",
          status: "finished",
          rewards: [{ id: "finished-reward", required_minutes: 30 }],
        }],
      },
    });

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["active-campaign"]);
  });

  it("treats whole-number Kick progress values as percentages", () => {
    const campaigns = parseKickCampaigns([{
      id: "campaign",
      rewards: [{ id: "reward", required_minutes: 200 }],
    }]);

    const merged = mergeKickProgress(campaigns, [{
      campaign_id: "campaign",
      reward_id: "reward",
      progress: 25,
    }]);

    expect(merged[0].rewards[0].watchedMinutes).toBe(50);
    expect(merged[0].rewards[0].status).toBe("in_progress");
  });

  it("reads Kick reward durations from required_units", () => {
    const campaigns = parseKickCampaigns({
      data: [{
        id: "campaign",
        status: "active",
        rewards: [{ id: "reward", name: "Reward", required_units: 90 }],
      }],
    });

    expect(campaigns[0].rewards[0].requiredMinutes).toBe(90);
  });

  it("marks zero-duration Kick rewards as non-watch rewards", () => {
    const campaigns = parseKickCampaigns({
      data: [{
        id: "campaign",
        rewards: [
          { id: "missing-duration" },
          { id: "zero-duration", required_units: 0 },
        ],
      }],
    });

    expect(campaigns[0].rewards).toMatchObject([
      { requirement: "action", isWatchBased: false },
      { requirement: "action", isWatchBased: false },
    ]);
  });

  it("classifies positive-duration Kick rewards as watch rewards", () => {
    const campaigns = parseKickCampaigns({
      data: [{
        id: "campaign",
        rewards: [{ id: "watch", required_units: 30 }],
      }],
    });

    expect(campaigns[0].rewards[0]).toMatchObject({
      requirement: "watch",
      isWatchBased: true,
    });
  });
});

describe("Twitch parsers", () => {
  it("classifies subscription-only campaigns as waiting for a qualifying subscription", () => {
    const campaigns = parseTwitchInventory([{
      id: "subscription-campaign",
      name: "Jubilee Badge",
      timeBasedDrops: [{ id: "subscription", name: "Jubilee Badge", requiredMinutesWatched: 0, requiredSubs: 1 }],
    }]);

    expect(campaigns[0]).toMatchObject({
      eligibility: "waiting_for_subscription",
      eligibilityReason: "Waiting for a qualifying subscription",
    });
    expect(campaigns[0].rewards[0]).toMatchObject({
      requirement: "subscription",
      requiredSubs: 1,
      isWatchBased: false,
    });
  });

  it("classifies unknown zero-minute rewards as action-gated with no farmable rewards", () => {
    const campaigns = parseTwitchInventory([{
      id: "action-campaign",
      timeBasedDrops: [{ id: "purchase", name: "Purchase Reward" }],
    }]);

    expect(campaigns[0].rewards[0]).toMatchObject({
      requirement: "action",
      isWatchBased: false,
    });
    expect(campaigns[0].eligibility).toBe("no_rewards");
  });

  it("marks claimed subscription-only campaigns completed", () => {
    const campaigns = parseTwitchInventory([{
      id: "claimed-subscription-campaign",
      timeBasedDrops: [{
        id: "subscription",
        requiredSubs: 1,
        self: { isClaimed: true },
      }],
    }]);

    expect(campaigns[0].rewards[0]).toMatchObject({
      requirement: "subscription",
      status: "claimed",
    });
    expect(campaigns[0].status).toBe("completed");
    expect(campaigns[0].eligibility).toBe("completed");
  });

  it("keeps only watch-based rewards in mixed campaigns", () => {
    const campaigns = parseTwitchInventory([{
      id: "mixed-campaign",
      name: "Detroit Badge Drop",
      timeBasedDrops: [
        { id: "subscription", name: "Detroit Blue LED", requiredMinutesWatched: 0, requiredSubs: 1 },
        { id: "watch", name: "Android Triangle", requiredMinutesWatched: 60 },
        { id: "combined", name: "Watch and Subscribe", requiredMinutesWatched: 60, requiredSubs: 1 },
      ],
    }]);

    expect(campaigns[0].rewards.filter((reward) => reward.isWatchBased !== false).map((reward) => reward.id)).toEqual(["watch"]);
    expect(campaigns[0].rewards.find((reward) => reward.id === "combined")).toMatchObject({
      requirement: "subscription",
      requiredSubs: 1,
      isWatchBased: false,
      status: "locked",
    });
    expect(campaigns[0].eligibility).toBe("eligible");
  });

  it("does not farm a mixed watch-and-subscription reward without a real claim instance", () => {
    const campaigns = parseTwitchInventory([{
      id: "mixed-only",
      self: { isAccountConnected: true },
      timeBasedDrops: [{
        id: "combined",
        requiredMinutesWatched: 60,
        requiredSubs: 1,
        self: { currentMinutesWatched: 60 },
      }],
    }]);

    expect(campaigns[0].eligibility).toBe("waiting_for_subscription");
    expect(campaigns[0].rewards[0]).toMatchObject({
      requirement: "subscription",
      isWatchBased: false,
      status: "in_progress",
      claimId: undefined,
    });
  });

  it("makes an obtained mixed-requirement reward claimable with Twitch's real instance id", () => {
    const campaigns = parseTwitchInventory([{
      id: "mixed-obtained",
      timeBasedDrops: [{
        id: "combined",
        requiredMinutesWatched: 60,
        requiredSubs: 1,
        self: { currentMinutesWatched: 60, dropInstanceID: "mixed-instance" },
      }],
    }]);

    expect(campaigns[0].rewards[0]).toMatchObject({
      isWatchBased: false,
      status: "claimable",
      claimId: "mixed-instance",
    });
  });

  it("keeps linked native badge and emote watch rewards farmable", () => {
    const campaigns = parseTwitchInventory([{
      id: "native-rewards",
      self: { isAccountConnected: true },
      timeBasedDrops: [
        {
          id: "badge",
          requiredMinutesWatched: 30,
          benefitEdges: [{ benefit: { id: "badge-benefit", distributionType: "BADGE" } }],
        },
        {
          id: "emote",
          requiredMinutesWatched: 60,
          benefitEdges: [{ benefit: { id: "emote-benefit", distributionType: "EMOTE" } }],
        },
      ],
    }]);

    expect(campaigns[0].eligibility).toBe("eligible");
    expect(campaigns[0].rewards).toMatchObject([
      { benefitType: "BADGE", isWatchBased: true },
      { benefitType: "EMOTE", isWatchBased: true },
    ]);
  });

  it("does not bypass account linking for unconfirmed native reward payloads", () => {
    const campaigns = parseTwitchInventory([{
      id: "unlinked-native",
      self: { isAccountConnected: false },
      accountLinkURL: "https://example.test/connect",
      timeBasedDrops: [{
        id: "badge",
        requiredMinutesWatched: 30,
        benefitEdges: [{ benefit: { id: "badge-benefit", distributionType: "BADGE" } }],
      }],
    }]);

    expect(campaigns[0].eligibility).toBe("account_not_linked");
  });

  it("treats a URL-less disconnected Twitch campaign as linked", () => {
    const campaigns = parseTwitchInventory([{
      id: "url-less-ewc-like",
      self: { isAccountConnected: false },
      timeBasedDrops: [{ id: "drop", requiredMinutesWatched: 60 }],
    }]);

    expect(campaigns[0]).toMatchObject({
      accountLinked: true,
      eligibility: "eligible",
    });
  });

  it("treats an empty-link disconnected Twitch campaign as linked", () => {
    const campaigns = parseTwitchInventory([{
      id: "empty-link-ewc-like",
      self: { isAccountConnected: false },
      accountLinkURL: "",
      timeBasedDrops: [{ id: "drop", requiredMinutesWatched: 60 }],
    }]);

    expect(campaigns[0]).toMatchObject({
      accountLinked: true,
      eligibility: "eligible",
    });
  });

  it("ignores Twitch-hosted account links for disconnected Twitch campaigns", () => {
    const campaigns = parseTwitchInventory([{
      id: "twitch-link-ewc-like",
      self: { isAccountConnected: false },
      accountLinkURL: "https://www.twitch.tv/drops/inventory",
      timeBasedDrops: [{ id: "drop", requiredMinutesWatched: 60 }],
    }]);

    expect(campaigns[0]).toMatchObject({
      accountLinked: true,
      accountLinkUrl: undefined,
      eligibility: "eligible",
    });
  });

  it("keeps a genuine disconnected Twitch campaign unlinked when it provides a link URL", () => {
    const campaigns = parseTwitchInventory([{
      id: "genuine-unlinked",
      self: { isAccountConnected: false },
      accountLinkURL: "https://example.test/connect",
      timeBasedDrops: [{ id: "drop", requiredMinutesWatched: 60 }],
    }]);

    expect(campaigns[0]).toMatchObject({
      accountLinked: false,
      accountLinkUrl: "https://example.test/connect",
      eligibility: "account_not_linked",
    });
  });

  it("does not unlock a watch reward whose paid prerequisite was excluded", () => {
    const campaigns = parseTwitchInventory([{
      id: "paid-prerequisite-campaign",
      timeBasedDrops: [
        { id: "subscription", requiredMinutesWatched: 0, requiredSubs: 1 },
        { id: "watch", requiredMinutesWatched: 60, preconditionDrops: [{ id: "subscription" }] },
      ],
    }]);

    expect(campaigns[0].rewards).toHaveLength(2);
    expect(campaigns[0].rewards.find((reward) => reward.id === "watch")?.preconditionsMet).toBe(false);
  });

  it("makes an obtained subscription reward claimable only with Twitch's real instance id", () => {
    const campaigns = parseTwitchInventory([{
      id: "subscription-campaign",
      timeBasedDrops: [{
        id: "subscription",
        requiredMinutesWatched: 0,
        requiredSubs: 1,
        self: { dropInstanceID: "subscription-instance" },
      }],
    }]);

    expect(campaigns[0].rewards[0]).toMatchObject({
      isWatchBased: false,
      status: "claimable",
      claimId: "subscription-instance",
    });
  });

  it("does not call a Twitch-confirmed claimable subscription reward waiting", () => {
    const [campaign] = parseTwitchInventory([{
      id: "claimable-subscription-campaign",
      timeBasedDrops: [{
        id: "subscription",
        requiredSubs: 1,
        self: { dropInstanceID: "subscription-instance" },
      }],
    }]);

    expect(campaign.status).toBe("active");
    expect(campaign.eligibility).toBe("no_rewards");
    expect(campaign.eligibilityReason).not.toContain("Waiting");
    expect(campaign.rewards[0].status).toBe("claimable");
  });

  it("does not synthesize a claim id for subscription rewards", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          id: "user-id",
          inventory: {
            dropCampaignsInProgress: [{
              id: "subscription-campaign",
              timeBasedDrops: [{
                id: "subscription",
                requiredSubs: 1,
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0].rewards[0]).toMatchObject({
      requirement: "subscription",
      status: "locked",
      claimId: undefined,
    });
  });

  it("normalizes inventory campaigns with ACL and claim ids", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            dropCampaignsInProgress: [{
              id: "abc",
              name: "Twitch Drops",
              game: { id: "game", name: "Game" },
              detailsURL: "https://www.twitch.tv/drops/campaigns/abc",
              allow: { channels: [{ login: "Streamer" }] },
              timeBasedDrops: [{
                id: "drop",
                name: "Cape",
                startAt: "2026-05-01T00:00:00.000Z",
                endAt: "2026-06-01T00:00:00.000Z",
                requiredMinutesWatched: 60,
                benefitEdges: [{ benefit: { id: "benefit", name: "Cape", imageAssetURL: "https://image", distributionType: "DIRECT_ENTITLEMENT" } }],
                self: { currentMinutesWatched: 60, dropInstanceID: "instance" },
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0].allowedChannels).toEqual(["streamer"]);
    expect(campaigns[0].connectionUrls).toEqual(["https://www.twitch.tv/streamer"]);
    expect(campaigns[0].url).toBe("https://www.twitch.tv/drops/campaigns/abc");
    expect(campaigns[0].rewards[0].imageUrl).toBe("https://image");
    expect(campaigns[0].rewards[0].status).toBe("claimable");
    expect(campaigns[0].rewards[0].claimId).toBe("instance");
  });

  it("reconstructs the claim id as userID#campaignID#dropID when Twitch omits the self edge id", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          id: "user-id",
          inventory: {
            dropCampaignsInProgress: [{
              id: "abc",
              name: "Twitch Drops",
              game: { id: "game", name: "Game" },
              timeBasedDrops: [{
                id: "drop",
                name: "Cape",
                requiredMinutesWatched: 60,
                self: { currentMinutesWatched: 60, isClaimed: false },
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0].rewards[0].status).toBe("claimable");
    expect(campaigns[0].rewards[0].claimId).toBe("user-id#abc#drop");
  });

  it("falls back to no claim id only when the current user id is unknown", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            dropCampaignsInProgress: [{
              id: "abc",
              name: "Twitch Drops",
              game: { id: "game", name: "Game" },
              timeBasedDrops: [{
                id: "drop",
                name: "Cape",
                requiredMinutesWatched: 60,
                self: { currentMinutesWatched: 60, isClaimed: false },
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0].rewards[0].status).toBe("claimable");
    expect(campaigns[0].rewards[0].claimId).toBeUndefined();
  });

  it("treats a Twitch reward as claimed when its benefit is already owned, regardless of award time", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            gameEventDrops: [{
              benefit: { id: "shared-benefit" },
              lastAwardedAt: "2026-05-15T12:00:00.000Z",
            }],
            dropCampaignsInProgress: [{
              id: "abc",
              name: "Twitch Drops",
              startAt: "2026-06-01T00:00:00.000Z",
              endAt: "2026-07-01T00:00:00.000Z",
              timeBasedDrops: [{
                id: "drop",
                name: "Cape",
                startAt: "2026-06-01T00:00:00.000Z",
                endAt: "2026-07-01T00:00:00.000Z",
                requiredMinutesWatched: 60,
                benefitEdges: [{ benefit: { id: "shared-benefit", name: "Cape" } }],
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0].rewards[0].status).toBe("claimed");
    expect(campaigns[0].status).toBe("completed");
  });

  it("treats a Twitch reward as claimed via owned benefit even when self reports isClaimed false", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            gameEventDrops: [{
              id: "owned-benefit",
              name: "Canned Tomatoes",
              lastAwardedAt: "2026-06-15T12:00:00.000Z",
            }],
            dropCampaignsInProgress: [{
              id: "arc",
              name: "Update 1.29.0",
              timeBasedDrops: [{
                id: "drop",
                name: "Canned Tomatoes",
                requiredMinutesWatched: 120,
                benefitEdges: [{ benefit: { id: "owned-benefit", name: "Canned Tomatoes" } }],
                self: { currentMinutesWatched: 0, isClaimed: false },
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0].rewards[0].status).toBe("claimed");
    expect(campaigns[0].status).toBe("completed");
    expect(campaigns[0].eligibility).toBe("completed");
  });

  it("infers a Twitch reward is claimed from a matching benefit awarded during the drop window", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            gameEventDrops: [{
              benefit: { id: "benefit" },
              lastAwardedAt: "2026-06-15T12:00:00.000Z",
            }],
            dropCampaignsInProgress: [{
              id: "abc",
              name: "Twitch Drops",
              startAt: "2026-06-01T00:00:00.000Z",
              endAt: "2026-07-01T00:00:00.000Z",
              timeBasedDrops: [{
                id: "drop",
                name: "Cape",
                requiredMinutesWatched: 60,
                benefitEdges: [{ benefit: { id: "benefit", name: "Cape" } }],
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0].rewards[0].status).toBe("claimed");
    expect(campaigns[0].status).toBe("completed");
  });

  it("normalizes reward campaigns nested directly under Twitch inventory", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            dropCampaigns: [{
              id: "campaign",
              name: "Inventory Reward Campaign",
              status: "ACTIVE",
              game: { id: "game", slug: "fortnite", displayName: "Fortnite" },
              timeBasedDrops: [{
                id: "drop",
                requiredMinutesWatched: 30,
                benefitEdges: [{ benefit: { id: "benefit", name: "Back Bling" } }],
              }],
            }],
          },
        },
      },
    });

    expect(campaigns[0]).toMatchObject({
      id: "campaign",
      name: "Inventory Reward Campaign",
      gameName: "Fortnite",
      eligibility: "eligible",
    });
  });

  it("merges Twitch inventory progress into campaign details", () => {
    const details = parseTwitchInventory([{
      id: "campaign",
      name: "Details",
      game: { slug: "game-slug", displayName: "Game" },
      timeBasedDrops: [{
        id: "drop",
        name: "Reward",
        requiredMinutesWatched: 120,
        benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
      }],
    }]);

    const merged = mergeTwitchCampaignProgress(details, {
      data: {
        currentUser: {
          inventory: {
            dropCampaignsInProgress: [{
              id: "campaign",
              timeBasedDrops: [{
                id: "drop",
                requiredMinutesWatched: 120,
                self: { currentMinutesWatched: 45, dropInstanceID: "claim-id", isClaimed: false },
              }],
            }],
          },
        },
      },
    });

    expect(merged[0].isGeneralDrop).toBe(true);
    expect(merged[0].connectionUrls?.[0]).toContain("/directory/category/game-slug");
    expect(merged[0].rewards[0].watchedMinutes).toBe(45);
    expect(merged[0].rewards[0].status).toBe("in_progress");
  });

  it("marks a tracked campaign completed when its benefit is owned but it dropped out of in-progress", () => {
    const details = parseTwitchInventory([{
      id: "campaign",
      name: "Update 1.29.0",
      timeBasedDrops: [{
        id: "drop",
        name: "Canned Tomatoes",
        requiredMinutesWatched: 120,
        benefitEdges: [{ benefit: { id: "owned-benefit", name: "Canned Tomatoes" } }],
      }],
    }]);

    const merged = mergeTwitchCampaignProgress(details, {
      data: {
        currentUser: {
          inventory: {
            gameEventDrops: [{ id: "owned-benefit", name: "Canned Tomatoes", lastAwardedAt: "2026-06-15T12:00:00.000Z" }],
            dropCampaignsInProgress: [],
          },
        },
      },
    });

    expect(merged[0].rewards[0].status).toBe("claimed");
    expect(merged[0].rewards[0].watchedMinutes).toBe(120);
    expect(merged[0].status).toBe("completed");
    expect(merged[0].eligibility).toBe("completed");
  });

  it("does not treat an old owned benefit as the current campaign's subscription reward", () => {
    const [campaign] = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            gameEventDrops: [{ id: "reused-benefit", lastAwardedAt: "2025-06-15T12:00:00.000Z" }],
            dropCampaignsInProgress: [{
              id: "current-subscription-campaign",
              timeBasedDrops: [{
                id: "current-subscription-drop",
                requiredSubs: 1,
                benefitEdges: [{ benefit: { id: "reused-benefit", name: "Returning Reward" } }],
                self: { isClaimed: false },
              }],
            }],
          },
        },
      },
    });

    expect(campaign.status).toBe("active");
    expect(campaign.eligibility).toBe("waiting_for_subscription");
    expect(campaign.rewards[0]).toMatchObject({
      requirement: "subscription",
      status: "locked",
      watchedMinutes: 0,
    });
  });

  it("keeps a mixed campaign active when only its watch reward is claimed", () => {
    const details = parseTwitchInventory([{
      id: "mixed-campaign",
      timeBasedDrops: [{
        id: "watch",
        requiredMinutesWatched: 30,
      }, {
        id: "subscription",
        requiredSubs: 1,
      }],
    }]);

    const merged = mergeTwitchCampaignProgress(details, [{
      id: "mixed-campaign",
      timeBasedDrops: [{
        id: "watch",
        requiredMinutesWatched: 30,
        self: { currentMinutesWatched: 30, isClaimed: true },
      }, {
        id: "subscription",
        requiredSubs: 1,
      }],
    }]);

    expect(merged[0].status).toBe("active");
    expect(merged[0].eligibility).toBe("eligible");
    expect(merged[0].rewards).toMatchObject([
      { requirement: "watch", status: "claimed" },
      { requirement: "subscription", status: "locked" },
    ]);
  });

  it("completes a mixed campaign when every tracked reward is claimed", () => {
    const details = parseTwitchInventory([{
      id: "mixed-campaign",
      timeBasedDrops: [{
        id: "watch",
        requiredMinutesWatched: 30,
      }, {
        id: "subscription",
        requiredSubs: 1,
      }],
    }]);

    const merged = mergeTwitchCampaignProgress(details, [{
      id: "mixed-campaign",
      timeBasedDrops: [{
        id: "watch",
        requiredMinutesWatched: 30,
        self: { currentMinutesWatched: 30, isClaimed: true },
      }, {
        id: "subscription",
        requiredSubs: 1,
        self: { isClaimed: true },
      }],
    }]);

    expect(merged[0].status).toBe("completed");
    expect(merged[0].eligibility).toBe("completed");
    expect(merged[0].rewards.every((reward) => reward.status === "claimed")).toBe(true);
  });

  it("evaluates Twitch reward preconditions from claimed prior drops", () => {
    const campaigns = parseTwitchInventory([{
      id: "campaign",
      name: "Chain",
      timeBasedDrops: [{
        id: "first",
        name: "First",
        requiredMinutesWatched: 30,
        self: { currentMinutesWatched: 30, isClaimed: true },
      }, {
        id: "second",
        name: "Second",
        requiredMinutesWatched: 60,
        preconditionDrops: [{ id: "first" }],
      }],
    }]);

    expect(campaigns[0].rewards[1].preconditionsMet).toBe(true);
  });

  it("marks all-claimed Twitch campaigns as completed and not eligible", () => {
    const campaigns = parseTwitchInventory([{
      id: "campaign",
      name: "Done",
      status: "ACTIVE",
      timeBasedDrops: [{
        id: "drop",
        requiredMinutesWatched: 30,
        self: { currentMinutesWatched: 30, isClaimed: true },
      }],
    }]);

    expect(campaigns[0].status).toBe("completed");
    expect(campaigns[0].eligibility).toBe("completed");
  });

  it("preserves upcoming and no-reward Twitch campaign states", () => {
    const campaigns = parseTwitchInventory([{
      id: "future",
      name: "Future",
      status: "UPCOMING",
      startAt: "2999-01-01T00:00:00.000Z",
      endAt: "2999-01-02T00:00:00.000Z",
      timeBasedDrops: [{
        id: "drop",
        requiredMinutesWatched: 30,
      }],
    }, {
      id: "empty",
      name: "Empty",
      status: "ACTIVE",
      timeBasedDrops: [],
    }]);

    expect(campaigns[0].status).toBe("upcoming");
    expect(campaigns[0].eligibility).toBe("upcoming");
    expect(campaigns[1].status).toBe("active");
    expect(campaigns[1].eligibility).toBe("no_rewards");
  });

  it("downgrades a campaign status and re-derives eligibility with withCampaignStatus", () => {
    const [campaign] = parseTwitchInventory([{
      id: "campaign",
      name: "Campaign",
      timeBasedDrops: [{ id: "drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
    }]);
    expect(campaign.status).toBe("active");
    expect(campaign.eligibility).toBe("eligible");

    const expired = withCampaignStatus(campaign, "expired");
    expect(expired.status).toBe("expired");
    expect(expired.eligibility).toBe("expired");
    expect(expired.eligibilityReason).toBe("Campaign has ended");
    // original is untouched
    expect(campaign.status).toBe("active");
  });

  it("re-derives subscription eligibility with withCampaignStatus", () => {
    const [campaign] = parseTwitchInventory([{
      id: "subscription-campaign",
      timeBasedDrops: [{ id: "subscription", requiredSubs: 1 }],
    }]);

    const active = withCampaignStatus(campaign, "active");

    expect(active.eligibility).toBe("waiting_for_subscription");
    expect(active.eligibilityReason).toBe("Waiting for a qualifying subscription");
  });

  it("keeps an active-status fallback completed when every reward is claimed", () => {
    const [campaign] = parseTwitchInventory([{
      id: "claimed-mixed-campaign",
      timeBasedDrops: [
        { id: "watch", requiredMinutesWatched: 60, self: { isClaimed: true } },
        { id: "subscription", requiredSubs: 1, self: { isClaimed: true } },
      ],
    }]);

    const active = withCampaignStatus(campaign, "active");

    expect(active.eligibility).toBe("completed");
    expect(active.eligibilityReason).toBe("All rewards are claimed");
  });

  it("detects claimable rewards with campaignHasClaimableReward", () => {
    const [inProgress] = parseTwitchInventory([{
      id: "in-progress",
      name: "In progress",
      timeBasedDrops: [{ id: "drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 20 } }],
    }]);
    const [claimable] = parseTwitchInventory([{
      id: "claimable",
      name: "Claimable",
      timeBasedDrops: [{ id: "drop", requiredMinutesWatched: 60, self: { currentMinutesWatched: 60 } }],
    }]);

    expect(campaignHasClaimableReward(inProgress)).toBe(false);
    expect(campaignHasClaimableReward(claimable)).toBe(true);
  });
});
