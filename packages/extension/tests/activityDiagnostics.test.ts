import { describe, expect, it } from "vitest";
import type { ActivityEvent, EngineEvent } from "@lurkloot/shared/events";
import { activityDiagnostic, withActivityDiagnostics } from "@lurkloot/core/activityDiagnostics";

const TARGET = {
  campaignId: "campaign-1",
  campaignName: "Summer Campaign",
  rewardId: "reward-1",
  rewardName: "Golden Hat",
};

const EVENTS = {
  farming_started: {
    category: "activity",
    code: "farming_started",
    level: "info",
    platform: "twitch",
    data: { ...TARGET, channel: "SomeStreamer" },
  },
  farming_stopped: {
    category: "activity",
    code: "farming_stopped",
    level: "warn",
    platform: "twitch",
    data: { ...TARGET, reason: "channel_offline" },
  },
  reward_claimed: {
    category: "activity",
    code: "reward_claimed",
    level: "info",
    platform: "kick",
    data: { ...TARGET, method: "manual" },
  },
  interruption: {
    category: "activity",
    code: "interruption",
    level: "error",
    data: { reason: "platform_error", detail: "HTTP 503 from the drops endpoint" },
  },
  challenge_claimed: {
    category: "activity",
    code: "challenge_claimed",
    level: "info",
    platform: "kick",
    data: { challengeId: "challenge-7", rarity: "rare", recurrence: "daily" },
  },
  page_context_opened: {
    category: "activity",
    code: "page_context_opened",
    level: "info",
    platform: "kick",
    data: { host: "kick.com", reason: "background_rejected" },
  },
  page_context_closed: {
    category: "activity",
    code: "page_context_closed",
    level: "info",
    platform: "kick",
    data: { host: "kick.com", reason: "user_tab_available" },
  },
  auth_health_changed: {
    category: "activity",
    code: "auth_health_changed",
    level: "error",
    platform: "twitch",
    data: { from: "healthy", to: "blocked", reason: "security_policy_blocked" },
  },
  critical_failure_detected: {
    category: "activity",
    code: "critical_failure_detected",
    level: "error",
    platform: "kick",
    data: { reason: "page_context_churn" },
  },
  critical_failure_cleared: {
    category: "activity",
    code: "critical_failure_cleared",
    level: "info",
    platform: "kick",
    data: { reason: "page_context_churn" },
  },
  // `satisfies` keeps each entry's literal type while still failing the build if
  // a new activity code is added without a sample here.
} satisfies Record<ActivityEvent["code"], ActivityEvent>;

describe("activity diagnostics", () => {
  it("describes every activity code in English", () => {
    expect(activityDiagnostic(EVENTS.farming_started).message).toBe(
      'Started farming "Golden Hat" from campaign "Summer Campaign" (campaign campaign-1, reward reward-1) on channel SomeStreamer',
    );
    expect(activityDiagnostic(EVENTS.farming_stopped).message).toBe(
      'Stopped farming "Golden Hat" from campaign "Summer Campaign" (campaign campaign-1, reward reward-1): reason=channel_offline',
    );
    expect(activityDiagnostic(EVENTS.reward_claimed).message).toBe(
      'Claimed "Golden Hat" from campaign "Summer Campaign" (campaign campaign-1, reward reward-1) via manual claim',
    );
    expect(activityDiagnostic(EVENTS.interruption).message).toBe(
      "Farming interrupted: reason=platform_error (HTTP 503 from the drops endpoint)",
    );
    expect(activityDiagnostic(EVENTS.challenge_claimed).message).toBe("Claimed rare daily challenge challenge-7");
    expect(activityDiagnostic(EVENTS.page_context_opened).message).toBe(
      "Opened managed page context on kick.com: reason=background_rejected",
    );
    expect(activityDiagnostic(EVENTS.page_context_closed).message).toBe(
      "Closed managed page context on kick.com: reason=user_tab_available",
    );
    expect(activityDiagnostic(EVENTS.auth_health_changed).message).toBe(
      "twitch authentication health changed from healthy to blocked: reason=security_policy_blocked",
    );
    expect(activityDiagnostic(EVENTS.critical_failure_detected).message).toBe(
      "kick flagged as critically failing: reason=page_context_churn",
    );
    expect(activityDiagnostic(EVENTS.critical_failure_cleared).message).toBe(
      "kick critical failure dismissed by the user, retrying: reason=page_context_churn",
    );
  });

  it("never leaves an activity code without a description", () => {
    for (const event of Object.values(EVENTS)) {
      const mirrored = activityDiagnostic(event);
      expect(mirrored.message).not.toBe("");
      expect(mirrored.message).not.toContain("undefined");
      expect(mirrored.code).toBe(event.code);
    }
  });

  it("carries the activity level, platform and structured data onto the mirror", () => {
    expect(activityDiagnostic(EVENTS.farming_stopped)).toEqual({
      category: "diagnostic",
      level: "warn",
      platform: "twitch",
      code: "farming_stopped",
      mirroredActivity: true,
      message: expect.stringContaining("reason=channel_offline"),
      data: { ...TARGET, reason: "channel_offline" },
    });
  });

  it("omits the platform when the activity event has none", () => {
    expect(activityDiagnostic(EVENTS.interruption).platform).toBeUndefined();
    expect(activityDiagnostic(EVENTS.interruption)).not.toHaveProperty("platform");
  });

  it("keeps optional fields out of the message when absent", () => {
    expect(activityDiagnostic({
      ...EVENTS.farming_started,
      data: { ...TARGET },
    }).message).not.toContain("on channel");
    expect(activityDiagnostic({
      category: "activity",
      code: "interruption",
      level: "warn",
      data: { reason: "runtime_restart" },
    }).message).toBe("Farming interrupted: reason=runtime_restart");
    expect(activityDiagnostic({
      category: "activity",
      code: "auth_health_changed",
      level: "info",
      platform: "kick",
      data: { from: "checking", to: "healthy" },
    }).message).toBe("kick authentication health changed from checking to healthy");
  });

  it("mirrors activity events through the wrapped emitter and leaves diagnostics alone", () => {
    const events: EngineEvent[] = [];
    const emit = withActivityDiagnostics((event) => events.push(event));

    emit(EVENTS.reward_claimed);
    emit({ category: "diagnostic", level: "debug", message: "Kick fetch kick.com 200" });

    expect(events.map(({ emittedAt, ...event }) => event)).toEqual([
      EVENTS.reward_claimed,
      activityDiagnostic(EVENTS.reward_claimed),
      { category: "diagnostic", level: "debug", message: "Kick fetch kick.com 200" },
    ]);
  });

  it("stamps every emitted event with the time it was emitted", () => {
    const events: EngineEvent[] = [];
    const emit = withActivityDiagnostics((event) => events.push(event));

    emit(EVENTS.reward_claimed);

    // An activity event and its mirror describe one moment, so they share it.
    const [activity, mirror] = events;
    expect(activity.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(mirror.emittedAt).toBe(activity.emittedAt);
  });

  it("keeps an emittedAt the caller already set", () => {
    const events: EngineEvent[] = [];
    const emit = withActivityDiagnostics((event) => events.push(event));

    emit({ ...EVENTS.reward_claimed, emittedAt: "2020-01-01T00:00:00.000Z" });

    expect(events.map((event) => event.emittedAt))
      .toEqual(["2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"]);
  });

  it("emits the mirror right after its activity event so the log stays ordered", () => {
    const events: EngineEvent[] = [];
    const emit = withActivityDiagnostics((event) => events.push(event));

    emit(EVENTS.farming_stopped);
    emit(EVENTS.farming_started);

    expect(events.map((event) => `${event.category}:${event.code ?? ""}`)).toEqual([
      "activity:farming_stopped",
      "diagnostic:farming_stopped",
      "activity:farming_started",
      "diagnostic:farming_started",
    ]);
  });
});
