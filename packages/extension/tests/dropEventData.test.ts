import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import {
  campaignRewardData,
  challengeRewardData,
  claimChannel,
  claimReadyRewards,
} from "@lurkloot/core/rewardClaims";

function reward(overrides: Partial<DropReward> = {}): DropReward {
  return {
    id: "reward",
    name: "Golden Pickaxe",
    imageUrl: "https://static-cdn.jtvnw.net/reward.png",
    requiredMinutes: 60,
    watchedMinutes: 60,
    status: "claimable",
    claimId: "claim",
    ...overrides,
  };
}

function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "campaign",
    platform: "twitch",
    name: "Season 12 Drops",
    gameName: "Rust",
    gameImageUrl: "https://static-cdn.jtvnw.net/ttv-boxart/rust.jpg",
    url: "https://www.twitch.tv/drops/campaigns?dropID=campaign",
    status: "active",
    rewards: [reward()],
    ...overrides,
  };
}

describe("drop event data", () => {
  it("carries the campaign's game name and box art", () => {
    expect(campaignRewardData(campaign(), reward())).toEqual({
      campaignId: "campaign",
      campaignName: "Season 12 Drops",
      rewardId: "reward",
      rewardName: "Golden Pickaxe",
      rewardImageUrl: "https://static-cdn.jtvnw.net/reward.png",
      campaignUrl: "https://www.twitch.tv/drops/campaigns?dropID=campaign",
      gameName: "Rust",
      gameImageUrl: "https://static-cdn.jtvnw.net/ttv-boxart/rust.jpg",
    });
  });

  it("drops a box art URL that is not https", () => {
    const data = campaignRewardData(
      campaign({ gameImageUrl: "http://insecure/rust.jpg" }),
      reward(),
    );
    expect(data).not.toHaveProperty("gameImageUrl");
    expect(data.gameName).toBe("Rust");
  });

  it("reports the game on an automatic claim", async () => {
    const adapter = {
      platform: "twitch",
      claimReward: async () => true,
    } as unknown as PlatformAdapter;
    const result = await claimReadyRewards(adapter, [campaign()], new Set());
    expect(result.events).toEqual([
      expect.objectContaining({
        claimed: true,
        gameName: "Rust",
        gameImageUrl: "https://static-cdn.jtvnw.net/ttv-boxart/rust.jpg",
      }),
    ]);
  });

  it("names the channel only when the watch session was on the claimed campaign", () => {
    const channel = {
      platform: "twitch" as const,
      username: "shroud",
      displayName: "Shroud",
      url: "https://www.twitch.tv/shroud",
    };
    expect(
      claimChannel({ status: "watching", campaignId: "campaign", channel } as never, "campaign"),
    ).toBe("Shroud");
    expect(
      claimChannel({ status: "watching", campaignId: "other", channel } as never, "campaign"),
    ).toBeUndefined();
    expect(claimChannel({ status: "idle" } as never, "campaign")).toBeUndefined();
  });

  it("names a challenge card and its kind when the art says them", () => {
    expect(
      challengeRewardData("kick", {
        id: "c",
        rarity: "uncommon",
        recurrence: "daily",
        cardName: "Aloo",
        cardType: "emote",
      }),
    ).toEqual({
      kind: "challenge_card",
      source: { platform: "kick" },
      rarity: "uncommon",
      name: "Aloo",
      details: [
        { key: "recurrence", value: "daily" },
        { key: "cardType", value: "emote" },
      ],
    });
  });
});
