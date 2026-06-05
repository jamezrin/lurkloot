import { describe, expect, it } from "vitest";
import { mergeKickProgress, parseKickCampaigns } from "../src/platforms/kickParser";
import { campaignHasClaimableReward, mergeTwitchCampaignProgress, parseTwitchInventory, withCampaignStatus } from "../src/platforms/twitchParser";

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
});

describe("Twitch parsers", () => {
  it("normalizes inventory campaigns with ACL and claim ids", () => {
    const campaigns = parseTwitchInventory({
      data: {
        currentUser: {
          inventory: {
            dropCampaignsInProgress: [{
              id: "abc",
              name: "Twitch Drops",
              game: { id: "game", name: "Game" },
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
