import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, set } = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: { get, set },
    },
  },
}));

import { loadSettings, saveSettings } from "../src/core/storage";

describe("settings storage migration", () => {
  beforeEach(() => {
    get.mockReset();
    set.mockReset();
  });

  it("writes legacy Watch Queue settings back using only Idle Watchlist keys", async () => {
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
    expect(set).toHaveBeenCalledWith({ settings });
    expect(set.mock.calls[0]?.[0].settings).not.toHaveProperty("watchQueueFallbackOnly");
    expect(set.mock.calls[0]?.[0].settings.platform.twitch).not.toHaveProperty("watchQueueChannels");
  });

  it("does not rewrite settings that already use Idle Watchlist keys", async () => {
    get.mockResolvedValue({
      settings: {
        idleWatchlistFallbackOnly: true,
        platform: {
          twitch: { idleWatchlistChannels: ["current"] },
          kick: { idleWatchlistChannels: [] },
        },
      },
    });

    await loadSettings();

    expect(set).not.toHaveBeenCalled();
  });

  it("still loads migrated settings when the one-time write-back fails", async () => {
    get.mockResolvedValue({
      settings: {
        watchQueueFallbackOnly: false,
        platform: { twitch: { watchQueueChannels: ["Legacy"] } },
      },
    });
    set.mockRejectedValue(new Error("storage unavailable"));

    await expect(loadSettings()).resolves.toMatchObject({
      idleWatchlistFallbackOnly: false,
      platform: { twitch: { idleWatchlistChannels: ["legacy"] } },
    });
  });

  it("serializes a migration write with a concurrent settings save", async () => {
    let finishMigration: (() => void) | undefined;
    const migrationPending = new Promise<void>((resolve) => {
      finishMigration = resolve;
    });
    get.mockResolvedValue({
      settings: {
        watchQueueFallbackOnly: false,
        platform: { twitch: { watchQueueChannels: ["Legacy"] } },
      },
    });
    set.mockImplementationOnce(() => migrationPending).mockResolvedValue(undefined);

    const migration = loadSettings();
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));

    const current = await import("@lurkloot/shared/settings").then(({ mergeSettings }) =>
      mergeSettings({ idleWatchlistFallbackOnly: true }));
    const save = saveSettings(current);

    expect(set).toHaveBeenCalledTimes(1);
    finishMigration?.();
    await migration;
    await save;
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[1]?.[0]).toEqual({ settings: current });
  });
});
