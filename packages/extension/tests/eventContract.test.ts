import { describe, expect, expectTypeOf, it } from "vitest";
import type { EngineEvent, StoredEngineEvent } from "@lurkloot/shared/events";

describe("engine event contract", () => {
  it("discriminates activity payloads by code", () => {
    const event: EngineEvent = {
      category: "activity",
      code: "farming_stopped",
      level: "info",
      platform: "twitch",
      data: {
        campaignId: "campaign",
        campaignName: "Campaign",
        rewardId: "reward",
        rewardName: "Reward",
        reason: "runtime_restart",
      },
    };
    expectTypeOf(event).toMatchTypeOf<EngineEvent>();
    expect(event.code).toBe("farming_stopped");
  });

  it("adds persistence metadata only to stored events", () => {
    expectTypeOf<StoredEngineEvent>().toMatchTypeOf<EngineEvent & { id: string; at: string }>();
  });
});
