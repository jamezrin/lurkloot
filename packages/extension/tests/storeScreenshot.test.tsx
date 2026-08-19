import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCREENSHOT_VARIANTS, StoreScreenshot, screenshotVariant, variantShowsPopup } from "@lurkloot/popup-ui";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mountShot(id: string, childText?: string) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <StoreScreenshot variant={screenshotVariant(id)} locale="en">
        {childText ? <div data-testid="live-popup">{childText}</div> : null}
      </StoreScreenshot>,
    );
  });
  await waitForCatalog();
  return container;
}

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

describe("store screenshot cameras", () => {
  it("renders extras cards and no live popup chrome", async () => {
    const container = await mountShot("extras", "LIVE_POPUP");
    expect(container.textContent).toContain("More than drops.");
    expect(container.textContent).toContain("also claimed for you");
    expect(container.textContent).toContain("Idle watchlist");
    expect(container.textContent).not.toContain("LIVE_POPUP");
  });

  it("renders the four easy steps", async () => {
    const container = await mountShot("easy");
    expect(container.textContent).toContain("That easy.");
    expect(container.textContent).toContain("Install");
    expect(container.textContent).toContain("Pin it");
    expect(container.textContent).toContain("Enable a platform");
    expect(container.textContent).toContain("Profit");

    const stepsRow = container.querySelector('[data-layout="steps"] div.absolute.flex.gap-7');
    expect(stepsRow).not.toBeNull();
    const className = stepsRow?.getAttribute("class") ?? "";
    expect(className).not.toContain("inset-inline-[7%]");
    expect(className).toMatch(/\bstart-\[7%\]/);
    expect(className).toMatch(/\bend-\[7%\]/);
  });

  it("places the live popup inside hero and settings cameras", async () => {
    const hero = await mountShot("drops", "LIVE_POPUP");
    expect(hero.textContent).toContain("Farm drops while you do anything else.");
    expect(hero.textContent).toContain("LIVE_POPUP");
    const settings = await mountShot("settings", "LIVE_POPUP");
    expect(settings.textContent).toContain("Farm exactly how you want.");
    expect(settings.textContent).toContain("LIVE_POPUP");
  });

  it("keeps updated as type-only", async () => {
    const container = await mountShot("updated", "LIVE_POPUP");
    expect(container.textContent).toContain("Featureful. Always updated.");
    expect(container.textContent).toContain("open to ideas");
    expect(container.textContent).not.toContain("LIVE_POPUP");
  });
});
