import { describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { farming, harness } from "../helpers/backgroundController";

// Points gains on the viewer's channel-points topic become points_earned
// activity, filed under the open Twitch farming session.

const ACCOUNT = "78020132";

function settings(twitchEnabled = true): ExtensionSettings {
  const base = farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true });
  return {
    ...base,
    platform: {
      ...base.platform,
      twitch: { ...base.platform.twitch, enabled: twitchEnabled, autoClaimChannelPoints: false },
    },
  };
}

async function observing(twitchEnabled = true) {
  const env = harness(settings(twitchEnabled));
  env.state.authHealth = {
    ...env.state.authHealth,
    twitch: { status: "healthy", checkedAt: new Date().toISOString(), accountId: ACCOUNT },
  };
  await env.controller.handleStartup();
  await env.controller.ensureAlarm();
  await env.rawController.settleBackgroundWork();
  return env;
}

function points(env: ReturnType<typeof harness>): EngineEvent[] {
  return env.reportEvents.mock.calls
    .flatMap(([events]) => events)
    .filter((event) => event.category === "activity" && event.code === "points_earned");
}

describe("channel points tally", () => {
  it("reports each gain with the session's id while auto-claim is off", async () => {
    const env = await observing();
    env.twitch.resolveChannels = vi.fn(async () => ({
      "77": {
        login: "shroud",
        displayName: "Shroud",
        imageUrl: "https://static-cdn.jtvnw.net/s.png",
      },
    }));
    expect(env.channelPointsPushController.onPointsEarned).toBeDefined();

    env.channelPointsPushController.onPointsEarned?.({
      userId: ACCOUNT,
      channelId: "77",
      reason: "WATCH_STREAK",
      amount: 450,
      at: Date.now(),
    });
    await env.rawController.settleBackgroundWork();

    expect(points(env)).toEqual([
      expect.objectContaining({
        platform: "twitch",
        sessionId: env.state.farmingSessions!.twitch!.id,
        data: {
          channelId: "77",
          channelLogin: "shroud",
          channelDisplayName: "Shroud",
          channelImageUrl: "https://static-cdn.jtvnw.net/s.png",
          reason: "WATCH_STREAK",
          amount: 450,
        },
      }),
    ]);
  });

  it("does not follow points while Twitch is off", async () => {
    const env = await observing(false);
    expect(env.channelPointsPushController.onPointsEarned).toBeUndefined();
  });

  it("counts a gain under the channel id when the channel cannot be resolved, asking once", async () => {
    const env = await observing();
    env.twitch.resolveChannels = vi.fn(async () => {
      throw new Error("gql down");
    });

    for (const amount of [50, 10]) {
      env.channelPointsPushController.onPointsEarned?.({
        userId: ACCOUNT,
        channelId: "88",
        reason: "WATCH",
        amount,
        at: Date.now(),
      });
    }
    await env.rawController.settleBackgroundWork();

    expect(points(env).map((event) => event.category === "activity" && event.data)).toEqual([
      { channelId: "88", reason: "WATCH", amount: 50 },
      { channelId: "88", reason: "WATCH", amount: 10 },
    ]);
    expect(env.twitch.resolveChannels).toHaveBeenCalledOnce();
  });
});
