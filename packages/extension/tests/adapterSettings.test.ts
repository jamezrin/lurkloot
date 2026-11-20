import { describe, expect, it } from "vitest";
import {
  ADAPTER_BACKED_SETTINGS,
  ADAPTER_FEATURES,
  adapterFeatures,
  CLI_CAPABILITIES,
  EXTENSION_CAPABILITIES,
  inertAdapterSettings,
  requestedAdapterSettings,
} from "@lurkloot/core/controller";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";

function bareAdapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: async () => ({ status: "healthy", message: { key: "authHealthy" } }),
    refreshCampaigns: async () => [],
    listCandidateChannels: async () => [],
    checkChannel: async (candidate) => ({ live: false, categoryMatches: false, candidate }),
    claimReward: async () => false,
  };
}

function fullAdapter(platform: Platform): PlatformAdapter {
  return {
    ...bareAdapter(platform),
    createChatPresenceClient: (() => ({})) as never,
    createChannelPointsPushController: (() => ({})) as never,
    claimChannelPoints: (async () => []) as never,
    claimChallenges: async () => [],
    supportsPostClaimHandoff: true,
  };
}

function settingsWith(
  twitch: Partial<EngineSettings["platform"]["twitch"]> = {},
  kick: Partial<EngineSettings["platform"]["kick"]> = {},
): EngineSettings {
  return {
    ...DEFAULT_ENGINE_SETTINGS,
    platform: {
      twitch: { ...DEFAULT_ENGINE_SETTINGS.platform.twitch, ...twitch },
      kick: { ...DEFAULT_ENGINE_SETTINGS.platform.kick, ...kick },
    },
  };
}

describe("adapter-backed settings (#1090)", () => {
  it("derives features from what the adapter offers", () => {
    expect([...adapterFeatures(bareAdapter("twitch"))]).toEqual([]);
    expect([...adapterFeatures(fullAdapter("kick"))]).toEqual([...ADAPTER_FEATURES]);
  });

  it("names a platform settings field once per entry", () => {
    const fields = ADAPTER_BACKED_SETTINGS.map((entry) => entry.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("reports nothing an adapter offers", () => {
    const settings = settingsWith(
      { alwaysEnterChat: true, watchlistStreakChannels: ["a"], watchStreakMaxRounds: 5 },
      { alwaysEnterChat: true },
    );
    for (const platform of ["twitch", "kick"] as const) {
      expect(
        inertAdapterSettings(platform, settings, fullAdapter(platform), EXTENSION_CAPABILITIES),
      ).toEqual([]);
    }
  });

  it("reports each requested setting the adapter cannot honour, with its platform", () => {
    const settings = settingsWith(
      {
        alwaysEnterChat: true,
        watchlistStreakChannels: ["a"],
        watchStreakBudgetMinutes: 20,
        watchStreakRetryCooldownMinutes: 60,
        watchStreakMaxRounds: 4,
      },
      { alwaysEnterChat: true },
    );
    expect(
      inertAdapterSettings("twitch", settings, bareAdapter("twitch"), CLI_CAPABILITIES),
    ).toEqual([
      {
        key: "platform.twitch.alwaysEnterChat",
        platform: "twitch",
        message:
          "Twitch on this host cannot join channel chat, so platform.twitch.alwaysEnterChat has no effect",
      },
      {
        key: "platform.twitch.channelPointsPushClaim",
        platform: "twitch",
        message:
          "Twitch on this host has no live push connection, so platform.twitch.channelPointsPushClaim has no effect",
      },
      expect.objectContaining({ key: "platform.twitch.watchlistStreakChannels" }),
      expect.objectContaining({ key: "platform.twitch.watchStreakBudgetMinutes" }),
      expect.objectContaining({ key: "platform.twitch.watchStreakRetryCooldownMinutes" }),
      expect.objectContaining({ key: "platform.twitch.watchStreakMaxRounds" }),
    ]);
    // Kick settings have no Twitch-only fields, so only its own key applies.
    expect(
      inertAdapterSettings("kick", settings, bareAdapter("kick"), CLI_CAPABILITIES).map(
        (setting) => setting.key,
      ),
    ).toEqual(["platform.kick.alwaysEnterChat"]);
  });

  it("asks nothing of values that request no feature", () => {
    // Defaults: chat off, no streak channels, untouched tuning. Push claiming
    // is on by default, but only matters while channel points are auto-claimed.
    expect(
      requestedAdapterSettings(
        "twitch",
        settingsWith({ autoClaimChannelPoints: false }),
        CLI_CAPABILITIES,
      ),
    ).toEqual([]);
    expect(
      requestedAdapterSettings("twitch", settingsWith(), CLI_CAPABILITIES).map(({ key }) => key),
    ).toEqual(["platform.twitch.channelPointsPushClaim"]);
    expect(requestedAdapterSettings("kick", settingsWith(), CLI_CAPABILITIES)).toEqual([]);
  });

  it("leaves a setting whose host capability is missing to the host-wide report", () => {
    const settings = settingsWith({ alwaysEnterChat: true }, { alwaysEnterChat: true });
    const noChat = { ...CLI_CAPABILITIES, chatPresence: false };
    for (const platform of ["twitch", "kick"] as const) {
      expect(
        inertAdapterSettings(platform, settings, bareAdapter(platform), noChat).map(
          (setting) => setting.key,
        ),
      ).not.toContain(`platform.${platform}.alwaysEnterChat`);
    }
  });
});
