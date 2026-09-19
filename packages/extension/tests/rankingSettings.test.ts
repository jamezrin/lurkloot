import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeEngineSettings, mergeSettings } from "@lurkloot/shared/settings";
import { CURRENT_SETTINGS_SCHEMA_VERSION, migrateSettings, withSchemaVersion } from "@lurkloot/shared/settingsSchema";

describe("ranking settings", () => {
  it("defaults to an empty pin list, no favourites and no blocks", () => {
    expect(DEFAULT_SETTINGS.campaignPins).toEqual([]);
    expect(DEFAULT_SETTINGS.farmPinnedOnly).toBe(false);
    expect(DEFAULT_SETTINGS.platform.twitch.favouriteCategories).toEqual([]);
    expect(DEFAULT_SETTINGS.platform.kick.blockedCategories).toEqual([]);
  });

  it("keeps pins in the order they were given and drops duplicates", () => {
    const settings = mergeEngineSettings({ campaignPins: ["b", "a", "b", "", "c"] });
    expect(settings.campaignPins).toEqual(["b", "a", "c"]);
  });

  it("no longer carries the display-only drops list filter", () => {
    expect("dropsListFilter" in mergeSettings({})).toBe(false);
  });
});

describe("settings migration to pins and favourites", () => {
  function migrate(raw: Record<string, unknown>) {
    return migrateSettings(withSchemaVersion(raw, CURRENT_SETTINGS_SCHEMA_VERSION - 1));
  }

  it("turns a campaign priority map into pins, highest priority first", () => {
    const result = migrate({ campaignPriorities: { low: 1, high: 10, middle: 5 } });
    expect(result.settings.campaignPins).toEqual(["high", "middle", "low"]);
    expect(result.settings.campaignPriorities).toBeUndefined();
    expect(result.diagnostics.map((entry) => entry.path)).toContain("campaignPriorities");
  });

  it("turns priority-list-only mode into the farm-pinned-only switch", () => {
    const result = migrate({ priorityMode: "priority_list_only", campaignPriorities: { kept: 3 } });
    expect(result.settings.priorityMode).toBe("ending_soonest");
    expect(result.settings.farmPinnedOnly).toBe(true);
    expect(result.settings.campaignPins).toEqual(["kept"]);
  });

  it("turns an exclude-mode category list into blocked games", () => {
    const result = migrate({
      platform: { twitch: { categoryMode: "exclude", categories: [{ id: "cs2", name: "Counter-Strike 2" }] } },
    });
    const twitch = (result.settings.platform as Record<string, Record<string, unknown>>).twitch;
    expect(twitch.categoryMode).toBe("all");
    expect(twitch.blockedCategories).toEqual([{ id: "cs2", name: "Counter-Strike 2" }]);
    expect(twitch.categories).toEqual([]);
  });

  it("leaves an include-mode category list alone", () => {
    const result = migrate({
      platform: { kick: { categoryMode: "include", categories: [{ id: "rust", name: "Rust" }] } },
    });
    const kick = (result.settings.platform as Record<string, Record<string, unknown>>).kick;
    expect(kick.categoryMode).toBe("include");
    expect(kick.categories).toEqual([{ id: "rust", name: "Rust" }]);
    expect(kick.blockedCategories).toBeUndefined();
  });

  it("drops the display-only drops list filter", () => {
    const result = migrate({ dropsListFilter: { showExpired: true, showFinished: false } });
    expect(result.settings.dropsListFilter).toBeUndefined();
    expect(result.diagnostics.map((entry) => entry.path)).toContain("dropsListFilter");
  });

  it("is idempotent once a document is already at the current version", () => {
    const once = migrate({ campaignPriorities: { a: 2, b: 1 } });
    const twice = migrateSettings(withSchemaVersion(once.settings));
    expect(twice.changed).toBe(false);
    expect(twice.settings.campaignPins).toEqual(["a", "b"]);
  });
});
