import { describe, expect, it } from "vitest";
import type { DropCampaign } from "@lurkloot/shared/models";
import { gameItemsFromCampaigns } from "../../popup-ui/src/viewModels";

const t = (key: string): string => key;

describe("popup category icons", () => {
  it("preserves campaign category artwork in active-drop suggestions", () => {
    const campaign: DropCampaign = {
      id: "fortnite-drops",
      platform: "twitch",
      name: "Fortnite Drops",
      categoryId: "33214",
      gameName: "Fortnite",
      gameImageUrl: "https://art.example/fortnite.jpg",
      status: "active",
      rewards: [],
    };

    expect(gameItemsFromCampaigns([campaign], t)).toEqual([
      expect.objectContaining({
        id: "33214",
        name: "Fortnite",
        imageUrl: "https://art.example/fortnite.jpg",
      }),
    ]);
  });

  it("keeps the synthetic no-category suggestion on the initials fallback", () => {
    const campaign: DropCampaign = {
      id: "uncategorized-drops",
      platform: "kick",
      name: "Event Drops",
      gameImageUrl: "https://art.example/unused.jpg",
      status: "active",
      rewards: [],
    };

    expect(gameItemsFromCampaigns([campaign], t)[0]).not.toHaveProperty("imageUrl");
  });
});
