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

import { loadSettings } from "../src/core/storage";

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
});
