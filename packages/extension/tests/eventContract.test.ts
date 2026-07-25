import { describe, expect, expectTypeOf, it } from "vitest";
import type { EngineEvent, StoredEngineEvent } from "@lurkloot/shared/events";
import type { PlatformAuthHealth } from "@lurkloot/shared/models";

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

  it("types safe authentication health and durable transitions", () => {
    const health: PlatformAuthHealth = {
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
    };
    const event: EngineEvent = {
      category: "activity",
      code: "auth_health_changed",
      level: "error",
      platform: "kick",
      data: { from: "checking", to: health.status, reason: health.reasonCode },
    };

    expectTypeOf(health).toMatchTypeOf<PlatformAuthHealth>();
    expectTypeOf(event).toMatchTypeOf<EngineEvent>();
  });

  it("types critical failure detection and clearing", () => {
    const detected: EngineEvent = {
      category: "activity",
      code: "critical_failure_detected",
      level: "error",
      platform: "kick",
      data: { reason: "page_context_churn" },
    };
    const cleared: EngineEvent = {
      category: "activity",
      code: "critical_failure_cleared",
      level: "info",
      platform: "kick",
      data: { reason: "page_context_churn" },
    };

    expectTypeOf(detected).toMatchTypeOf<EngineEvent>();
    expectTypeOf(cleared).toMatchTypeOf<EngineEvent>();
  });
});
