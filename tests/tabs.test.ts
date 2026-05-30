import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate } from "../src/core/models";
import { fetchJsonInPageWithBrowser, openPinnedMutedTabWithBrowser, stopWatchTabWithBrowser } from "../src/core/tabs";

const channel: ChannelCandidate = {
  platform: "twitch",
  username: "creator",
  url: "https://www.twitch.tv/creator",
};

function browserMock() {
  return {
    tabs: {
      get: vi.fn(),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      query: vi.fn<() => Promise<Array<{ id?: number }>>>(async () => []),
      create: vi.fn(async () => ({ id: 9 })),
    },
  };
}

describe("tab manager", () => {
  it("reuses and repins an existing stored tab", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({ id: 4 });

    const result = await openPinnedMutedTabWithBrowser(browser, channel, { platform: "twitch", status: "watching", offlineChecks: 0, tabId: 4, tabManagedByExtension: true });

    expect(result).toEqual({
      tabId: 4,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 4,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(4, {
      url: channel.url,
      pinned: true,
      muted: true,
      active: false,
    });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it("creates one new managed tab when the registered tab is stale", async () => {
    const browser = browserMock();
    browser.tabs.get.mockRejectedValue(new Error("missing"));
    browser.tabs.query.mockResolvedValue([{ id: 7 }]);

    const result = await openPinnedMutedTabWithBrowser(browser, channel, { platform: "twitch", status: "watching", offlineChecks: 0, tabId: 4, tabManagedByExtension: true });

    expect(result).toEqual({
      tabId: 9,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 9,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(browser.tabs.remove).toHaveBeenCalledWith(4);
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { pinned: true, muted: true, active: false });
  });

  it("creates pinned tabs and then mutes them", async () => {
    const browser = browserMock();

    const result = await openPinnedMutedTabWithBrowser(browser, channel);

    expect(result).toEqual({
      tabId: 9,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 9,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: channel.url,
      pinned: true,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { pinned: true, muted: true, active: false });
  });

  it("updates a registered managed tab when switching channels", async () => {
    const browser = browserMock();
    const nextChannel = { ...channel, username: "next", url: "https://www.twitch.tv/next" };
    browser.tabs.get.mockResolvedValue({ id: 4 });

    const result = await openPinnedMutedTabWithBrowser(browser, nextChannel, undefined, {
      managedTab: {
        platform: "twitch",
        tabId: 4,
        channelUrl: channel.url,
        ownedByExtension: true,
      },
    });

    expect(result).toEqual({
      tabId: 4,
      managedByExtension: true,
      managedTab: {
        platform: "twitch",
        tabId: 4,
        channelUrl: nextChannel.url,
        ownedByExtension: true,
      },
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(4, {
      url: nextChannel.url,
      pinned: true,
      muted: true,
      active: false,
    });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it("does not treat user-opened matching tabs as managed or close them", async () => {
    const browser = browserMock();
    browser.tabs.query.mockResolvedValue([{ id: 7 }]);

    await openPinnedMutedTabWithBrowser(browser, channel);

    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: channel.url,
      pinned: true,
      active: false,
    });
  });

  it("closes extension-managed watch tabs on stop", async () => {
    const browser = browserMock();

    await stopWatchTabWithBrowser(browser, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: true,
    });

    expect(browser.tabs.remove).toHaveBeenCalledWith(4);
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it("restores reused user tabs on stop instead of closing them", async () => {
    const browser = browserMock();

    await stopWatchTabWithBrowser(browser, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: false,
    });

    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(browser.tabs.update).toHaveBeenCalledWith(4, { muted: false, pinned: false, active: false });
  });

  it("uses scripting execution for page-context fetches", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }]);

    const result = await fetchJsonInPageWithBrowser<{ ok: boolean }>(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
    );

    expect(result).toEqual({ ok: true });
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 3 },
      // MAIN world is required so Cloudflare-protected APIs (Kick) accept the fetch.
      world: "MAIN",
      // args must be JSON-serializable: null, never undefined ("unserializable").
      args: ["https://web.kick.com/api/v1/drops/progress", null],
    }));
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });

  it("closes an extension-created page-context tab after a fetch", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.create.mockResolvedValue({ id: 14 });

    const result = await fetchJsonInPageWithBrowser<{ ok: boolean }>(
      browser,
      "https://www.twitch.tv/drops/inventory",
      "https://gql.twitch.tv/gql",
    );

    expect(result).toEqual({ ok: true });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://www.twitch.tv/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(14, { muted: true, active: false });
    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
  });

  it("does not close an existing user tab reused for a page-context fetch", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }]);

    await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
    );

    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });

  it("shares one page-context tab creation across concurrent fetches for the same origin", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.create.mockImplementation(async () => {
      await Promise.resolve();
      return { id: 14 };
    });

    await Promise.all([
      fetchJsonInPageWithBrowser(browser, "https://www.twitch.tv/drops/inventory", "https://gql.twitch.tv/gql"),
      fetchJsonInPageWithBrowser(browser, "https://www.twitch.tv/drops/inventory", "https://gql.twitch.tv/gql"),
    ]);

    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://www.twitch.tv/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(14, { muted: true, active: false });
    expect(browser.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 14 },
    }));
    expect(browser.tabs.remove).toHaveBeenCalledTimes(1);
    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
  });
});
