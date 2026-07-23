import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, set, clear } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: { get, set, clear },
    },
  },
}));

vi.mock("../src/core/activityStorage", () => ({
  clearActivityEvents: vi.fn().mockResolvedValue(undefined),
  importLegacyActivityEvents: vi.fn().mockResolvedValue(undefined),
}));

import { loadSettings, resetStorage, saveSettings } from "../src/core/storage";
import { CURRENT_SETTINGS_SCHEMA_VERSION, UnsupportedSettingsVersionError, withSchemaVersion } from "@lurkloot/shared/settingsSchema";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";

describe("settings storage migration", () => {
  beforeEach(() => {
    get.mockReset();
    set.mockReset();
    set.mockResolvedValue(undefined);
    clear.mockReset();
    clear.mockResolvedValue(undefined);
  });

  it("writes a legacy document back once, using current keys and the current version", async () => {
    get.mockResolvedValue({
      settings: {
        watchQueueFallbackOnly: false,
        platform: {
          twitch: { watchQueueChannels: ["Legacy"] },
          kick: { watchQueueChannels: ["KickLegacy"] },
        },
      },
    });

    const settings = await loadSettings();

    expect(settings.idleWatchlistFallbackOnly).toBe(false);
    expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["legacy"]);
    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0]?.[0].settings;
    expect(written).toEqual(withSchemaVersion(settings));
    expect(written.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(written).not.toHaveProperty("watchQueueFallbackOnly");
    expect(written.platform.twitch).not.toHaveProperty("watchQueueChannels");
  });

  it("stamps an unversioned document that already uses current keys", async () => {
    get.mockResolvedValue({
      settings: { idleWatchlistFallbackOnly: true, platform: { twitch: { idleWatchlistChannels: ["current"] } } },
    });

    await loadSettings();

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0].settings.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
  });

  it("does not write when storage is already at the current version", async () => {
    get.mockResolvedValue({ settings: withSchemaVersion(DEFAULT_SETTINGS) });

    await loadSettings();

    expect(set).not.toHaveBeenCalled();
  });

  it("still returns usable settings when the write-back fails, and retries on the next load", async () => {
    get.mockResolvedValue({
      settings: { watchQueueFallbackOnly: false, platform: { twitch: { watchQueueChannels: ["Legacy"] } } },
    });
    set.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(loadSettings()).resolves.toMatchObject({
      idleWatchlistFallbackOnly: false,
      platform: { twitch: { idleWatchlistChannels: ["legacy"] } },
    });
    expect(set).toHaveBeenCalledTimes(1);

    set.mockResolvedValue(undefined);
    await loadSettings();
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("rejects a future schema version without writing", async () => {
    get.mockResolvedValue({ settings: { schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION + 1, autoClaim: false } });

    await expect(loadSettings()).rejects.toThrow(UnsupportedSettingsVersionError);
    expect(set).not.toHaveBeenCalled();
  });

  it("emits the current version on an ordinary save", async () => {
    await saveSettings(DEFAULT_SETTINGS);
    expect(set).toHaveBeenCalledWith({ settings: withSchemaVersion(DEFAULT_SETTINGS) });
  });

  it("emits the current version on reset", async () => {
    await resetStorage();
    expect(set.mock.calls[0]?.[0].settings).toEqual(withSchemaVersion(DEFAULT_SETTINGS));
  });

  it("serializes a migration write with a concurrent settings save", async () => {
    let finishMigration: (() => void) | undefined;
    const migrationPending = new Promise<void>((resolve) => {
      finishMigration = resolve;
    });
    get.mockResolvedValue({
      settings: { watchQueueFallbackOnly: false, platform: { twitch: { watchQueueChannels: ["Legacy"] } } },
    });
    set.mockImplementationOnce(() => migrationPending).mockResolvedValue(undefined);

    const migration = loadSettings();
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));

    const current = mergeSettings({ idleWatchlistFallbackOnly: true });
    const save = saveSettings(current);

    expect(set).toHaveBeenCalledTimes(1);
    finishMigration?.();
    await migration;
    await save;
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[1]?.[0]).toEqual({ settings: withSchemaVersion(current) });
  });
});
