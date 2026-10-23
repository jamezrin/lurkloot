import { describe, expect, it } from "vitest";
import { createDemoPopupAdapter } from "@lurkloot/popup-ui";
import type { ActivityPage, RuntimeSnapshot } from "@lurkloot/shared/messages";

const snapshot = (scenario?: "default" | "tour") =>
  createDemoPopupAdapter({ scenario }).send<RuntimeSnapshot>({ type: "getSnapshot" });
const activity = (scenario: "default" | "tour", platform: "twitch" | "kick") =>
  createDemoPopupAdapter({ scenario }).send<ActivityPage>({
    type: "getActivity",
    platform,
    category: "activity",
  });

describe("tour demo scenario", () => {
  it("hides tips and puts unlinked campaigns last", async () => {
    const { settings, state } = await snapshot("tour");
    expect(settings.showTips).toBe(false);
    expect(settings.platform.twitch.unlinkedCampaigns).toBe("last");
    expect(
      state.campaigns.twitch.some((c) => c.accountLinked === false && c.status === "active"),
    ).toBe(true);
    expect(settings.campaignPins.length).toBeGreaterThan(0);
    expect(settings.platform.twitch.favouriteCategories.length).toBeGreaterThan(0);
  });

  it("covers completed and expired campaigns", async () => {
    const { state } = await snapshot("tour");
    const twitch = state.campaigns.twitch;
    expect(
      twitch.some((c) => c.rewards.length > 0 && c.rewards.every((r) => r.status === "claimed")),
    ).toBe(true);
    expect(twitch.some((c) => c.status === "expired")).toBe(true);
  });

  it("carries extension summaries and a Kick streak", async () => {
    const { state } = await snapshot("tour");
    expect(state.twitchExtensions?.nopixel).toBeDefined();
    expect(state.twitchExtensions?.fortnite).toBeDefined();
    const { settings } = await snapshot("tour");
    expect(settings.twitchExtensions.nopixel.enabled).toBe(true);
    expect(settings.twitchExtensions.fortnite.enabled).toBe(true);
    expect(state.accountProgress?.kick?.progress?.streakDays).toBeGreaterThan(0);
  });

  it.each(["twitch", "kick"] as const)("returns localizable %s activity", async (platform) => {
    const page = await activity("tour", platform);
    expect(page.events.length).toBeGreaterThanOrEqual(3);
    for (const event of page.events) {
      expect(event.category).toBe("activity");
      expect("legacy" in event).toBe(false);
      expect((event as { code?: string }).code).toBeTruthy();
    }
  });

  it("leaves the default scenario unchanged", async () => {
    const { settings, state } = await snapshot();
    expect(state.twitchExtensions).toBeUndefined();
    expect(settings.twitchExtensions.nopixel.enabled).toBe(false);
    expect(settings.twitchExtensions.fortnite.enabled).toBe(false);
    expect(settings.platform.twitch.unlinkedCampaigns).toBe("include");
    expect((await activity("default", "twitch")).events).toEqual([]);
  });
});
