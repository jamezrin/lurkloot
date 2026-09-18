import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, applySettingsPatch, mergeEngineSettings, mergeSettings } from "@lurkloot/shared/settings";
import { buildSettingsExportPayload, parseSettingsImportPayload } from "@lurkloot/shared/settingsExport";
import { CURRENT_SETTINGS_SCHEMA_VERSION, migrateSettings, withSchemaVersion } from "@lurkloot/shared/settingsSchema";
import { DEFAULT_WATCH_SOURCE_PRIORITY, normalizeWatchSourcePriority } from "@lurkloot/shared/watchSources";

const twitchDefaults = ["drops", "nopixel", "fortnite", "idle_watchlist"];
const kickDefaults = ["drops", "idle_watchlist"];

describe("watch-source settings", () => {
  it("appends every supported source to partial orders without sharing mutable defaults", () => {
    expect(normalizeWatchSourcePriority("twitch", ["nopixel"])).toEqual(["nopixel", "drops", "fortnite", "idle_watchlist"]);
    for (const value of [undefined, null, {}, "drops", 42, ["not_a_source"]]) {
      expect(normalizeWatchSourcePriority("kick", value)).toEqual(kickDefaults);
    }
    const normalized = normalizeWatchSourcePriority("twitch", undefined);
    normalized.reverse();
    expect(DEFAULT_WATCH_SOURCE_PRIORITY.twitch).toEqual(twitchDefaults);
    expect(normalizeWatchSourcePriority("twitch", undefined)).toEqual(twitchDefaults);
  });

  it("normalizes missing, duplicate, unknown and wrong-platform entries", () => {
    expect(mergeEngineSettings(undefined).platform.twitch).toHaveProperty("watchSourcePriority", twitchDefaults);
    expect(mergeSettings({ platform: {
      twitch: { watchSourcePriority: ["fortnite", "fortnite", "invalid", "idle_watchlist"] },
      kick: { watchSourcePriority: ["nopixel", "idle_watchlist", null, "drops"] },
    } } as never).platform).toMatchObject({
      twitch: { watchSourcePriority: ["fortnite", "idle_watchlist", "drops", "nopixel"] },
      kick: { watchSourcePriority: ["idle_watchlist", "drops"] },
    });
  });

  it("migrates the old sticky-idle preference to Idle-first on both platforms", () => {
    const migration = migrateSettings({ schemaVersion: 5, idleWatchlistFallbackOnly: false });
    expect(migration.changed).toBe(true);
    expect(migration.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    const settings = mergeSettings(migration.settings as never);
    expect(settings.platform.twitch).toHaveProperty("watchSourcePriority", ["idle_watchlist", "drops", "nopixel", "fortnite"]);
    expect(settings.platform.kick).toHaveProperty("watchSourcePriority", ["idle_watchlist", "drops"]);
    expect(migration.settings.platform).toMatchObject({
      twitch: { watchSourcePriority: settings.platform.twitch.watchSourcePriority },
      kick: { watchSourcePriority: settings.platform.kick.watchSourcePriority },
    });
    expect(migrateSettings(withSchemaVersion(settings)).changed).toBe(false);
  });

  it("lets an explicit priority win over the legacy flag, including an invalid or empty value", () => {
    for (const value of [[], null, "idle_watchlist", ["drops", "fortnite"]]) {
      const settings = mergeSettings({ idleWatchlistFallbackOnly: false, platform: {
        twitch: { watchSourcePriority: value }, kick: { watchSourcePriority: value },
      } } as never);
      expect(settings.platform.twitch.watchSourcePriority).toEqual(Array.isArray(value) && value.length ? ["drops", "fortnite", "nopixel", "idle_watchlist"] : twitchDefaults);
      expect(settings.platform.kick.watchSourcePriority).toEqual(kickDefaults);
    }
  });

  it("leaves explicit raw priorities for host normalization during migration", () => {
    const priority = ["unknown", "fortnite", "fortnite"];
    const migration = migrateSettings({ schemaVersion: 5, idleWatchlistFallbackOnly: false, platform: { twitch: { watchSourcePriority: priority } } });
    expect(migration.settings.platform).toMatchObject({ twitch: { watchSourcePriority: priority } });
    expect(mergeSettings(migration.settings as never).platform.twitch.watchSourcePriority).toEqual(["fortnite", "drops", "nopixel", "idle_watchlist"]);
  });

  it("preserves independent orders through save, restart and export/import", () => {
    const changed = applySettingsPatch(DEFAULT_SETTINGS, { platform: { twitch: { watchSourcePriority: ["nopixel", "idle_watchlist", "drops", "fortnite"] }, kick: { watchSourcePriority: ["idle_watchlist", "drops"] } } });
    const restarted = mergeSettings(migrateSettings(JSON.parse(JSON.stringify(withSchemaVersion(changed)))).settings as never);
    expect(restarted.platform.twitch.watchSourcePriority).toEqual(["nopixel", "idle_watchlist", "drops", "fortnite"]);
    expect(restarted.platform.kick.watchSourcePriority).toEqual(["idle_watchlist", "drops"]);
    expect(parseSettingsImportPayload(JSON.parse(JSON.stringify(buildSettingsExportPayload(restarted)))).settings).toEqual(changed);
    expect(DEFAULT_SETTINGS.platform.twitch.watchSourcePriority).toEqual(twitchDefaults);
  });
});
