import { describe, expect, it } from "vitest";
import type { DropCampaign, EngineSettings } from "@lurkloot/shared/models";
import { mergeEngineSettings } from "@lurkloot/shared/settings";
import { campaignRankTier, rankCampaigns } from "@lurkloot/shared/ranking";

const hour = 60 * 60 * 1000;
const now = Date.parse("2026-09-20T00:00:00.000Z");

function campaign(id: string, patch: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id,
    platform: "twitch",
    name: id,
    status: "active",
    rewards: [],
    ...patch,
  };
}

// Platform blocks are given as partials; mergeEngineSettings fills the rest.
function settings(patch: Record<string, unknown> = {}): EngineSettings {
  return mergeEngineSettings(patch as Partial<EngineSettings>);
}

function ids(campaigns: DropCampaign[]): string[] {
  return campaigns.map((entry) => entry.id);
}

const endingSoon = campaign("ending-soon", { endsAt: new Date(now + 2 * hour).toISOString(), gameName: "Rust" });
const endingLate = campaign("ending-late", { endsAt: new Date(now + 200 * hour).toISOString(), gameName: "Warframe" });
const scarce = campaign("scarce", { endsAt: new Date(now + 100 * hour).toISOString(), gameName: "Delta Force", allowedChannels: ["one"] });

describe("rankCampaigns", () => {
  it("ranks by the ending-soonest strategy when nothing is pinned or favourite", () => {
    const ranked = rankCampaigns([endingLate, scarce, endingSoon], settings());
    expect(ids(ranked)).toEqual(["ending-soon", "scarce", "ending-late"]);
  });

  it("ranks by fewest channels under the lowest-availability strategy", () => {
    const ranked = rankCampaigns([endingSoon, endingLate, scarce], settings({ priorityMode: "lowest_availability" }));
    expect(ids(ranked)).toEqual(["scarce", "ending-soon", "ending-late"]);
  });

  it("puts pinned campaigns first, in pin order", () => {
    const ranked = rankCampaigns([endingSoon, endingLate, scarce], settings({ campaignPins: ["ending-late", "scarce"] }));
    expect(ids(ranked)).toEqual(["ending-late", "scarce", "ending-soon"]);
  });

  it("ranks favourite games above the strategy and below pins", () => {
    const ranked = rankCampaigns([endingSoon, endingLate, scarce], settings({
      campaignPins: ["ending-late"],
      platform: { twitch: { favouriteCategories: [{ id: "delta", name: "Delta Force" }] } },
    }));
    expect(ids(ranked)).toEqual(["ending-late", "scarce", "ending-soon"]);
  });

  it("keeps favourite games in the order they were starred", () => {
    const ranked = rankCampaigns([endingSoon, endingLate, scarce], settings({
      platform: {
        twitch: {
          favouriteCategories: [
            { id: "warframe", name: "Warframe" },
            { id: "delta", name: "Delta Force" },
          ],
        },
      },
    }));
    expect(ids(ranked)).toEqual(["ending-late", "scarce", "ending-soon"]);
  });

  it("never ranks a blocked game as a favourite", () => {
    const ranked = rankCampaigns([endingSoon, scarce], settings({
      platform: {
        twitch: {
          favouriteCategories: [{ id: "delta", name: "Delta Force" }],
          blockedCategories: [{ id: "delta", name: "Delta Force" }],
        },
      },
    }));
    expect(ids(ranked)).toEqual(["ending-soon", "scarce"]);
  });

  it("breaks ties by name so the order is stable", () => {
    const later = campaign("b-campaign", { name: "Beta", endsAt: new Date(now + hour).toISOString() });
    const earlier = campaign("a-campaign", { name: "Alpha", endsAt: new Date(now + hour).toISOString() });
    expect(ids(rankCampaigns([later, earlier], settings()))).toEqual(["a-campaign", "b-campaign"]);
  });

  it("sorts a malformed end time like a missing one, keeping the tie-breakers", () => {
    const broken = campaign("broken", { name: "Zeta", endsAt: "not a date" });
    const missing = campaign("missing", { name: "Alpha" });
    // Both score as "no deadline", so the name tie-break decides rather than a
    // NaN comparison silently leaving the order to the sort implementation.
    expect(ids(rankCampaigns([broken, missing], settings()))).toEqual(["missing", "broken"]);
    expect(ids(rankCampaigns([missing, broken], settings()))).toEqual(["missing", "broken"]);
    expect(ids(rankCampaigns([broken, endingSoon], settings()))).toEqual(["ending-soon", "broken"]);
  });

  it("reports which tier ranked a campaign", () => {
    const configured = settings({
      campaignPins: ["ending-late"],
      platform: { twitch: { favouriteCategories: [{ id: "delta", name: "Delta Force" }] } },
    });
    expect(campaignRankTier(endingLate, configured)).toBe("pinned");
    expect(campaignRankTier(scarce, configured)).toBe("favourite");
    expect(campaignRankTier(endingSoon, configured)).toBe("strategy");
  });

  it("ranks a newly discovered campaign of a favourite game above older campaigns", () => {
    const configured = settings({ platform: { twitch: { favouriteCategories: [{ id: "delta", name: "Delta Force" }] } } });
    const flashDrop = campaign("flash", { gameName: "Delta Force", endsAt: new Date(now + 500 * hour).toISOString() });
    expect(ids(rankCampaigns([endingSoon, flashDrop], configured))).toEqual(["flash", "ending-soon"]);
  });
});
