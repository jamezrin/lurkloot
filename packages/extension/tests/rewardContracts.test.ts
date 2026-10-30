import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@lurkloot/shared/events";
import { safeHttpsUrl } from "@lurkloot/shared/rewardEvents";
import {
  isActivityTimelineEvent,
  rewardCountKey,
  tallyKey,
} from "@lurkloot/shared/farmingSessions";

function pointsEvent(channelId: string): ActivityEvent {
  return {
    category: "activity",
    code: "points_earned",
    level: "info",
    platform: "twitch",
    data: { channelId, reason: "WATCH", amount: 50 },
  };
}

const dropClaimed: ActivityEvent = {
  category: "activity",
  code: "reward_claimed",
  level: "info",
  platform: "twitch",
  data: {
    campaignId: "c",
    campaignName: "Campaign",
    rewardId: "r",
    rewardName: "Hat",
    method: "automatic",
  },
};

const cardObtained: ActivityEvent = {
  category: "activity",
  code: "reward_obtained",
  level: "info",
  platform: "kick",
  data: { kind: "challenge_card", source: { platform: "kick" }, rarity: "legendary" },
};

describe("reward event contracts", () => {
  it("keeps only https image URLs", () => {
    expect(safeHttpsUrl("https://files.kick.com/a.png")).toBe("https://files.kick.com/a.png");
    expect(safeHttpsUrl(" https://files.kick.com/a.png ")).toBe("https://files.kick.com/a.png");
    expect(safeHttpsUrl("http://x/a.png")).toBeUndefined();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpsUrl("not a url")).toBeUndefined();
    expect(safeHttpsUrl(42)).toBeUndefined();
    expect(safeHttpsUrl("https://user:pass@files.kick.com/a.png")).toBeUndefined();
  });

  it("keeps tab open and close events out of the activity timeline", () => {
    expect(isActivityTimelineEvent({ category: "activity", code: "page_context_opened" })).toBe(
      false,
    );
    expect(isActivityTimelineEvent({ category: "activity", code: "page_context_closed" })).toBe(
      false,
    );
    expect(isActivityTimelineEvent({ category: "diagnostic" })).toBe(false);
    expect(isActivityTimelineEvent({ category: "activity", code: "reward_claimed" })).toBe(true);
  });

  it("tallies points per channel and counts listed rewards by kind", () => {
    expect(tallyKey(pointsEvent("123"))).toBe("channel_points:123");
    expect(tallyKey(dropClaimed)).toBeUndefined();
    expect(rewardCountKey(dropClaimed)).toBe("drop");
    expect(rewardCountKey(cardObtained)).toBe("challenge_card");
    expect(rewardCountKey(pointsEvent("123"))).toBeUndefined();
  });
});
