import { describe, expect, it } from "vitest";
import { SCREENSHOT_VARIANTS, screenshotVariant, variantShowsPopup } from "@lurkloot/popup-ui";

describe("store screenshot variants", () => {
  it("resolves canonical ids and aliases to the locked layouts", () => {
    expect(screenshotVariant("drops").layout).toBe("hero");
    expect(screenshotVariant("twitch-drops")).toBe(screenshotVariant("drops"));
    expect(screenshotVariant("kick-drops")).toBe(screenshotVariant("drops"));
    expect(screenshotVariant("extras").layout).toBe("extras");
    expect(screenshotVariant("idle-watchlist")).toBe(screenshotVariant("extras"));
    expect(screenshotVariant("easy").layout).toBe("steps");
    expect(screenshotVariant("settings").layout).toBe("settings");
    expect(screenshotVariant("updated").layout).toBe("updated");
    expect(screenshotVariant("activity")).toBe(screenshotVariant("updated"));
    expect(screenshotVariant(null).layout).toBe("hero");
    expect(screenshotVariant("nope").layout).toBe("hero");
  });

  it("only hero and settings mount a live popup", () => {
    expect(variantShowsPopup(screenshotVariant("drops"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("settings"))).toBe(true);
    expect(variantShowsPopup(screenshotVariant("extras"))).toBe(false);
    expect(variantShowsPopup(screenshotVariant("easy"))).toBe(false);
    expect(variantShowsPopup(screenshotVariant("updated"))).toBe(false);
  });

  it("keeps popup shots at Twitch drops or settings views", () => {
    const drops = screenshotVariant("drops");
    const settings = screenshotVariant("settings");
    if (!variantShowsPopup(drops) || !variantShowsPopup(settings)) throw new Error("expected popup shots");
    expect(drops.platform).toBe("twitch");
    expect(drops.view).toBe("drops");
    expect(settings.view).toBe("settings");
  });

  it("exports five canonical layouts", () => {
    expect(Object.keys(SCREENSHOT_VARIANTS)).toEqual(expect.arrayContaining([
      "drops", "extras", "easy", "settings", "updated",
      "twitch-drops", "kick-drops", "idle-watchlist", "activity",
    ]));
  });
});
