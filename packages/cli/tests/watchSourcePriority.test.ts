import { describe, expect, it } from "vitest";
import {
  buildCliSettingsExportPayload,
  parseCliSettings,
  parseCliSettingsImportPayload,
  toEngineSettings,
} from "../src/settings";
import { parse } from "jsonc-parser";
import { defaultConfigJsonc, parseConfig } from "../src/config";

describe("CLI watch-source priority", () => {
  it("normalizes platform orders and preserves them through the engine and export/import", () => {
    const settings = parseCliSettings({
      platform: {
        twitch: { watchSourcePriority: ["fortnite", "nopixel", "fortnite", "unknown"] },
        kick: { watchSourcePriority: ["nopixel", "watchlist"] },
      },
    });
    expect(settings.platform.twitch.watchSourcePriority).toEqual([
      "watch_streaks",
      "fortnite",
      "nopixel",
      "drops",
      "watchlist",
    ]);
    expect(settings.platform.kick.watchSourcePriority).toEqual(["watchlist", "drops"]);
    expect(toEngineSettings(settings).platform).toEqual(settings.platform);
    expect(
      parseCliSettingsImportPayload(
        JSON.parse(JSON.stringify(buildCliSettingsExportPayload(settings))),
      ).settings,
    ).toEqual(settings);
  });

  it("migrates legacy Watchlist-first intent and lets explicit priority win", () => {
    expect(
      parseCliSettings({ idleWatchlistFallbackOnly: false }).platform.twitch.watchSourcePriority,
    ).toEqual(["watch_streaks", "watchlist", "drops", "nopixel", "fortnite"]);
    expect(
      parseCliSettings({
        idleWatchlistFallbackOnly: false,
        platform: { kick: { watchSourcePriority: ["drops"] } },
      }).platform.kick.watchSourcePriority,
    ).toEqual(["drops", "watchlist"]);
  });

  it("generates both source orders in the config template", () => {
    const template = defaultConfigJsonc();
    const config = parseConfig(parse(template), "/tmp/watch-source-config.jsonc");
    expect(config.settings.platform.twitch.watchSourcePriority).toEqual([
      "watch_streaks",
      "drops",
      "nopixel",
      "fortnite",
      "watchlist",
    ]);
    expect(config.settings.platform.kick.watchSourcePriority).toEqual(["drops", "watchlist"]);
    expect(template).not.toContain('"idleWatchlistFallbackOnly"');
  });

  it("loads a config written with the Watchlist names and warns about each", () => {
    const config = parseConfig(
      {
        settings: {
          platform: {
            twitch: {
              idleWatchlistChannels: ["alpha", "beta"],
              idleWatchlistStreakChannels: ["beta"],
              watchSourcePriority: ["idle_watchlist", "drops", "nopixel", "fortnite"],
            },
            kick: { idleWatchlistChannels: ["gamma"], watchSourcePriority: ["idle_watchlist"] },
          },
        },
      },
      "/tmp/old-watchlist-config.jsonc",
    );
    expect(config.settings.platform.twitch.watchlistChannels).toEqual(["alpha", "beta"]);
    expect(config.settings.platform.twitch.watchlistStreakChannels).toEqual(["beta"]);
    expect(config.settings.platform.twitch.watchSourcePriority).toEqual([
      "watch_streaks",
      "watchlist",
      "drops",
      "nopixel",
      "fortnite",
    ]);
    expect(config.settings.platform.kick.watchlistChannels).toEqual(["gamma"]);
    expect(config.settings.platform.kick.watchSourcePriority).toEqual(["watchlist", "drops"]);
    expect(config.warnings).toContain(
      "settings.platform.twitch.idleWatchlistChannels is deprecated; use settings.platform.twitch.watchlistChannels",
    );
    expect(config.warnings).toContain(
      "settings.platform.twitch.idleWatchlistStreakChannels is deprecated; use settings.platform.twitch.watchlistStreakChannels",
    );
  });

  it("accepts and clamps the watch-streak tuning, and exports it", () => {
    const config = parseConfig(
      {
        settings: {
          platform: {
            twitch: {
              watchStreakBudgetMinutes: 20,
              watchStreakRetryCooldownMinutes: 1,
              watchStreakMaxRounds: 9,
            },
          },
        },
      },
      "/tmp/streak-tuning-config.jsonc",
    );
    expect(config.warnings).toEqual([]);
    expect(config.settings.platform.twitch).toMatchObject({
      watchStreakBudgetMinutes: 20,
      watchStreakRetryCooldownMinutes: 10,
      watchStreakMaxRounds: 5,
    });
    expect(
      parseCliSettingsImportPayload(
        JSON.parse(JSON.stringify(buildCliSettingsExportPayload(config.settings))),
      ).settings.platform.twitch,
    ).toMatchObject({ watchStreakBudgetMinutes: 20, watchStreakMaxRounds: 5 });
  });
});
