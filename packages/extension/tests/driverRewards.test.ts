import { describe, expect, it } from "vitest";
import { driverRewardEvent } from "../src/extensions/rewardEvents";

describe("Twitch Extension reward events", () => {
  it("reports an opened NoPixel pack with its per-edition counts", () => {
    expect(
      driverRewardEvent("nopixel", "buddha", {
        type: "pack",
        cardCount: 3,
        editions: { normal: 2, gold: 1 },
      }),
    ).toEqual({
      category: "activity",
      code: "reward_obtained",
      level: "info",
      platform: "twitch",
      data: {
        kind: "extension_pack",
        source: { platform: "twitch", extension: "nopixel" },
        channel: "buddha",
        amount: 3,
        details: [
          { key: "edition_normal", value: 2 },
          { key: "edition_gold", value: 1 },
        ],
      },
    });
  });

  it("reports a giveaway entry and a capture", () => {
    expect(driverRewardEvent("nopixel", "buddha", { type: "giveaway" }).data).toEqual({
      kind: "extension_giveaway",
      source: { platform: "twitch", extension: "nopixel" },
      channel: "buddha",
    });
    expect(
      driverRewardEvent("fortnite", "summit1g", { type: "capture", collectableId: "sprite" }).data,
    ).toEqual({
      kind: "extension_capture",
      source: { platform: "twitch", extension: "fortnite" },
      channel: "summit1g",
      itemId: "sprite",
    });
  });
});
