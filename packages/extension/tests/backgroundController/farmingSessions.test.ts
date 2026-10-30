import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, EngineEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { farming, harness } from "../helpers/backgroundController";

// Farming sessions: one per platform from enable to disable, stamped on every
// activity event the controller reports.

function reported(env: ReturnType<typeof harness>): EngineEvent[] {
  return env.reportEvents.mock.calls.flatMap(([events]) => events);
}

function activity(env: ReturnType<typeof harness>, code: ActivityEvent["code"]): ActivityEvent[] {
  return reported(env).filter(
    (event): event is ActivityEvent => event.category === "activity" && event.code === code,
  );
}

const claimed = (platform: "twitch" | "kick", emittedAt?: string): EngineEvent => ({
  category: "activity",
  code: "reward_claimed",
  level: "info",
  platform,
  data: {
    campaignId: "c",
    campaignName: "Campaign",
    rewardId: "r",
    rewardName: "Hat",
    method: "manual",
  },
  ...(emittedAt ? { emittedAt } : {}),
});

describe("farming sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a session for each enabled platform at startup and keeps it across restarts", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleStartup();

    const twitch = env.state.farmingSessions?.twitch;
    expect(twitch).toEqual({ id: expect.any(String), startedAt: expect.any(String) });
    expect(activity(env, "session_started")).toContainEqual(
      expect.objectContaining({
        platform: "twitch",
        sessionId: twitch!.id,
        data: { sessionId: twitch!.id, startedAt: twitch!.startedAt },
      }),
    );

    await env.controller.handleStartup();

    expect(env.state.farmingSessions?.twitch).toEqual(twitch);
    expect(activity(env, "session_started").filter((e) => e.platform === "twitch")).toHaveLength(1);
  });

  it("stamps the open session on a platform's activity and null on a disabled platform's", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleStartup();
    await env.controller.setPlatformEnabled({
      type: "setPlatformEnabled",
      platform: "kick",
      enabled: false,
    });
    await env.controller.settleBackgroundWork();
    env.reportEvents.mockClear();

    await env.controller.reportEvents([
      claimed("twitch"),
      claimed("kick"),
      {
        category: "activity",
        code: "interruption",
        level: "warn",
        data: { reason: "runtime_restart" },
      },
    ]);

    const [twitch, kick, interruption] = reported(env).filter((e) => e.category === "activity");
    expect(twitch).toMatchObject({ sessionId: env.state.farmingSessions!.twitch!.id });
    expect(kick).toMatchObject({ sessionId: null });
    expect(interruption).not.toHaveProperty("sessionId");
  });

  it("starts a new session after a quick disable and enable, ending the first", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleStartup();
    const first = env.state.farmingSessions!.twitch!.id;

    await env.controller.setPlatformEnabled({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: false,
    });
    expect(env.state.farmingSessions?.twitch).toBeUndefined();
    await env.controller.setPlatformEnabled({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: true,
    });
    await env.controller.settleBackgroundWork();

    const second = env.state.farmingSessions!.twitch!.id;
    expect(second).not.toBe(first);
    expect(activity(env, "session_ended")).toContainEqual(
      expect.objectContaining({
        platform: "twitch",
        sessionId: first,
        data: expect.objectContaining({ sessionId: first, reason: "disabled" }),
      }),
    );
  });

  it("files an event emitted before the disable, but reported after it, under the closed session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleStartup();
    const session = env.state.farmingSessions!.twitch!.id;

    vi.setSystemTime(new Date("2026-10-30T11:00:00.000Z"));
    await env.controller.setPlatformEnabled({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: false,
    });
    await env.controller.settleBackgroundWork();
    env.reportEvents.mockClear();

    await env.controller.reportEvents([claimed("twitch", "2026-10-30T10:59:59.000Z")]);

    expect(reported(env).find((e) => e.category === "activity")).toMatchObject({
      sessionId: session,
    });
  });

  it("stamps the persisted session on a freshly started controller, before any reconcile", async () => {
    // A worker restart: the session survived in storage, the controller is new.
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.farmingSessions = {
      twitch: { id: "persisted", startedAt: "2026-10-30T09:00:00.000Z" },
    };

    await env.controller.reportEvents([claimed("twitch")]);

    expect(reported(env).find((e) => e.category === "activity")).toMatchObject({
      sessionId: "persisted",
    });
  });

  it("opens a session on install or update when farming is already on", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.ensureAlarm();
    await env.controller.settleBackgroundWork();

    expect(env.state.farmingSessions?.twitch).toEqual({
      id: expect.any(String),
      startedAt: expect.any(String),
    });
  });

  it("keeps a session open when a disable and an enable race", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleStartup();

    await Promise.all([
      env.controller.setPlatformEnabled({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      }),
      env.controller.setPlatformEnabled({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      }),
    ]);
    await env.controller.settleBackgroundWork();

    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.state.farmingSessions?.twitch).toBeDefined();
  });

  it("files what turning farming off reports under the session it closed", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleStartup();
    await env.controller.tick();
    await env.controller.settleBackgroundWork();
    const session = env.state.farmingSessions!.twitch!.id;
    env.reportEvents.mockClear();

    await env.controller.setPlatformEnabled({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: false,
    });
    await env.controller.settleBackgroundWork();

    const statusRows = reported(env).filter(
      (event) =>
        event.category === "activity"
        && event.platform === "twitch"
        && event.code !== "session_ended",
    );
    for (const row of statusRows)
      expect(row, JSON.stringify(row)).toMatchObject({ sessionId: session });
  });
});
