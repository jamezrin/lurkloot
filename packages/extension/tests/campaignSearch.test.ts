import { describe, expect, it } from "vitest";
import { filterCampaigns } from "../../popup-ui/src/campaignSearch";
import type { CampaignView, GameItem } from "../../popup-ui/src/types";

function campaign(overrides: Partial<CampaignView> & { id: string }): CampaignView {
  return {
    gameId: "game-a",
    title: "Some campaign",
    status: "active",
    linked: true,
    excluded: false,
    starts: "2026-01-01T00:00:00.000Z",
    ends: "2026-01-02T00:00:00.000Z",
    channels: [],
    thumbnail: "",
    tint: "",
    rewards: [],
    hasWatchRewards: true,
    hasSubscriptionRewards: false,
    ...overrides,
  };
}

function reward(name: string) {
  return {
    id: name,
    name,
    requiredMinutes: 60,
    requirement: "watch" as const,
    obtained: false,
    art: "",
    tint: "",
  };
}

const gameMap: Record<string, GameItem> = {
  "game-a": { id: "game-a", name: "Marge de sécurité", short: "MDS", accent: "" },
  "game-b": { id: "game-b", name: "Palworld", short: "PW", accent: "" },
};

describe("filterCampaigns", () => {
  const campaigns = [
    campaign({ id: "a", title: "Deadline safety margin", gameId: "game-a", rewards: [reward("Emote pack")] }),
    campaign({ id: "b", title: "Frostbite drops", gameId: "game-b", rewards: [reward("Rare skin")] }),
  ];

  it("returns every campaign for an empty or blank query", () => {
    expect(filterCampaigns(campaigns, gameMap, "")).toEqual(campaigns);
    expect(filterCampaigns(campaigns, gameMap, "   ")).toEqual(campaigns);
  });

  it("matches by campaign title", () => {
    expect(filterCampaigns(campaigns, gameMap, "deadline").map((c) => c.id)).toEqual(["a"]);
  });

  it("matches by game/category name, case and diacritic insensitive", () => {
    expect(filterCampaigns(campaigns, gameMap, "securite").map((c) => c.id)).toEqual(["a"]);
    expect(filterCampaigns(campaigns, gameMap, "PALWORLD").map((c) => c.id)).toEqual(["b"]);
  });

  it("matches by reward name", () => {
    expect(filterCampaigns(campaigns, gameMap, "rare skin").map((c) => c.id)).toEqual(["b"]);
  });

  it("requires every whitespace-separated token to match, in any order", () => {
    expect(filterCampaigns(campaigns, gameMap, "safety margin").map((c) => c.id)).toEqual(["a"]);
    expect(filterCampaigns(campaigns, gameMap, "margin safety").map((c) => c.id)).toEqual(["a"]);
    expect(filterCampaigns(campaigns, gameMap, "safety unrelated")).toEqual([]);
  });

  it("returns no matches when nothing satisfies the query", () => {
    expect(filterCampaigns(campaigns, gameMap, "nonexistent")).toEqual([]);
  });

  it("tolerates a campaign whose game id is missing from the game map", () => {
    const orphan = [campaign({ id: "c", title: "Orphan campaign", gameId: "missing-game" })];
    expect(filterCampaigns(orphan, gameMap, "orphan").map((c) => c.id)).toEqual(["c"]);
    expect(filterCampaigns(orphan, gameMap, "missing-game")).toEqual([]);
  });
});
