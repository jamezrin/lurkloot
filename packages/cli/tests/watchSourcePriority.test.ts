import { describe, expect, it } from "vitest";
import { buildCliSettingsExportPayload, parseCliSettings, parseCliSettingsImportPayload, toEngineSettings } from "../src/settings";
import { parse } from "jsonc-parser";
import { defaultConfigJsonc, parseConfig } from "../src/config";

describe("CLI watch-source priority", () => {
  it("normalizes platform orders and preserves them through the engine and export/import", () => {
    const settings = parseCliSettings({ platform: {
      twitch: { watchSourcePriority: ["fortnite", "nopixel", "fortnite", "unknown"] },
      kick: { watchSourcePriority: ["nopixel", "idle_watchlist"] },
    } });
    expect(settings.platform.twitch.watchSourcePriority).toEqual(["fortnite", "nopixel", "drops", "idle_watchlist"]);
    expect(settings.platform.kick.watchSourcePriority).toEqual(["idle_watchlist", "drops"]);
    expect(toEngineSettings(settings).platform).toEqual(settings.platform);
    expect(parseCliSettingsImportPayload(JSON.parse(JSON.stringify(buildCliSettingsExportPayload(settings)))).settings).toEqual(settings);
  });

  it("migrates legacy Idle-first intent and lets explicit priority win", () => {
    expect(parseCliSettings({ idleWatchlistFallbackOnly: false }).platform.twitch.watchSourcePriority).toEqual(["idle_watchlist", "drops", "nopixel", "fortnite"]);
    expect(parseCliSettings({ idleWatchlistFallbackOnly: false, platform: { kick: { watchSourcePriority: ["drops"] } } }).platform.kick.watchSourcePriority).toEqual(["drops", "idle_watchlist"]);
  });

  it("generates both source orders in the config template", () => {
    const template = defaultConfigJsonc();
    const config = parseConfig(parse(template), "/tmp/watch-source-config.jsonc");
    expect(config.settings.platform.twitch.watchSourcePriority).toEqual(["drops", "nopixel", "fortnite", "idle_watchlist"]);
    expect(config.settings.platform.kick.watchSourcePriority).toEqual(["drops", "idle_watchlist"]);
    expect(template).not.toContain('"idleWatchlistFallbackOnly"');
  });
});
