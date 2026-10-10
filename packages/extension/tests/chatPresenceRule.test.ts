import { describe, expect, it } from "vitest";
import { chatPresenceDecision } from "@lurkloot/core/chatPresence";
import { twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
import type { EngineSettings, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../src/core/storage";

function settingsWith(patch: { enabled?: boolean; alwaysEnterChat?: boolean; pauseOnManualWatch?: boolean } = {}): EngineSettings {
  return {
    ...DEFAULT_ENGINE_SETTINGS,
    pauseOnManualWatch: patch.pauseOnManualWatch ?? DEFAULT_ENGINE_SETTINGS.pauseOnManualWatch,
    platform: {
      ...DEFAULT_ENGINE_SETTINGS.platform,
      twitch: {
        ...DEFAULT_ENGINE_SETTINGS.platform.twitch,
        enabled: patch.enabled ?? true,
        alwaysEnterChat: patch.alwaysEnterChat ?? false,
      },
    },
  };
}

function stateWith(session: Partial<WatchSession> = {}, auth: "healthy" | "checking" = "healthy"): SchedulerState {
  return {
    ...DEFAULT_STATE,
    authHealth: { ...DEFAULT_STATE.authHealth, twitch: { status: auth } },
    sessions: {
      ...DEFAULT_STATE.sessions,
      twitch: {
        platform: "twitch",
        status: "watching",
        watchMode: "tabless",
        offlineChecks: 0,
        channel: { platform: "twitch", username: "Prod", url: "https://www.twitch.tv/prod", channelId: "174754672" },
        ...session,
      },
    },
  } as SchedulerState;
}

const nopixel = { supplementalWatch: { id: "nopixel", tablessOnly: true as const } };
const fortnite = { supplementalWatch: { id: "fortnite", tablessOnly: true as const } };

describe("chat presence rule", () => {
  it("declares chat presence for NoPixelV only", () => {
    expect(twitchExtensionProvider("nopixel")?.needsChatPresence).toBe(true);
    expect(twitchExtensionProvider("fortnite")?.needsChatPresence).toBe(false);
  });

  it("wants presence for a NoPixelV watch, with the provider as trigger", () => {
    expect(chatPresenceDecision("twitch", settingsWith(), stateWith(nopixel), { capability: true })).toEqual({
      target: { username: "prod", channelId: "174754672" },
      trigger: { kind: "provider", providerId: "nopixel" },
    });
  });

  it("wants presence for any tabless watch when alwaysEnterChat is on", () => {
    expect(chatPresenceDecision("twitch", settingsWith({ alwaysEnterChat: true }), stateWith(), { capability: true })?.trigger)
      .toEqual({ kind: "setting" });
  });

  it.each([
    ["no trigger", settingsWith(), stateWith()],
    ["Fortnite watch", settingsWith(), stateWith(fortnite)],
    ["platform disabled", settingsWith({ enabled: false, alwaysEnterChat: true }), stateWith()],
    ["auth not healthy", settingsWith({ alwaysEnterChat: true }), stateWith({}, "checking")],
    ["tab watch never wants presence", settingsWith({ alwaysEnterChat: true }), stateWith({ ...nopixel, watchMode: "tab" })],
    ["not watching", settingsWith({ alwaysEnterChat: true }), stateWith({ status: "paused" })],
    ["no channel", settingsWith({ alwaysEnterChat: true }), stateWith({ channel: undefined })],
  ])("does not want presence: %s", (_label, settings, state) => {
    expect(chatPresenceDecision("twitch", settings, state, { capability: true })).toBeUndefined();
  });

  it("does not want presence without the host capability", () => {
    expect(chatPresenceDecision("twitch", settingsWith({ alwaysEnterChat: true }), stateWith(nopixel), { capability: false })).toBeUndefined();
  });

  it("does not want presence during a manual-close pause or a recent manual watch", () => {
    const paused: SchedulerState = { ...stateWith(nopixel), manualClosePause: { twitch: { platform: "twitch", closedAt: new Date(0).toISOString() } } };
    expect(chatPresenceDecision("twitch", settingsWith(), paused, { capability: true })).toBeUndefined();
    const now = Date.parse("2026-10-05T12:00:00Z");
    const watching: SchedulerState = {
      ...stateWith(nopixel),
      manualWatch: { twitch: { platform: "twitch", tabId: 7, checkedAt: new Date(now).toISOString(), active: true } },
    };
    expect(chatPresenceDecision("twitch", settingsWith({ pauseOnManualWatch: true }), watching, { capability: true, now })).toBeUndefined();
    expect(chatPresenceDecision("twitch", settingsWith({ pauseOnManualWatch: false }), watching, { capability: true, now })).toBeDefined();
  });
});
