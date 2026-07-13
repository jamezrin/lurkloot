import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DropCampaign } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { PlatformSettingsGroup } from "../../popup-ui/src/settingsPlatform";
import { gameItemsFromCampaigns } from "../../popup-ui/src/viewModels";

const t = (key: string): string => key;

describe("popup category icons", () => {
  function renderSelectedCategory(imageUrl?: string): string {
    const settings = mergeSettings(undefined);
    settings.platform.twitch.farmAllCategories = false;
    settings.platform.twitch.categories = [{
      id: "33214",
      name: "Fort Night",
      ...(imageUrl ? { imageUrl } : {}),
    }];

    return renderToStaticMarkup(createElement(PlatformSettingsGroup, {
      platform: "twitch",
      suggestions: [],
      settings,
      onFarmAllCategoriesChange: () => {},
      onCategoriesChange: () => {},
      onSearchCategories: async () => [],
      onExcludedChannelsChange: () => {},
    }));
  }

  it("renders selected category artwork as a rounded-square image", () => {
    const markup = renderSelectedCategory("https://art.example/fortnite.jpg");

    expect(markup).toContain('src="https://art.example/fortnite.jpg"');
    expect(markup).toContain("h-8 w-8");
    expect(markup).toContain("rounded-lg");
  });

  it("keeps initials when selected category artwork is absent", () => {
    const markup = renderSelectedCategory();

    expect(markup).not.toContain("<img");
    expect(markup).toContain(">FN</span>");
  });

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
