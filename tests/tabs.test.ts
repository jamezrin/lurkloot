import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelCandidate } from "../src/core/models";
import {
  currentManagedPageContextTabs,
  fetchJsonInPageWithBrowser,
  fetchTwitchInBackgroundWith,
  openPinnedMutedTabWithBrowser,
  registerManagedPageContextTabs,
  stopWatchTabWithBrowser,
} from "../src/core/tabs";

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
  beforeEach(() => {
    registerManagedPageContextTabs({});
  });

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

  it("primes a matching managed tab when playback telemetry is not healthy yet", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({
      id: 4,
      url: channel.url,
      pinned: true,
      mutedInfo: { muted: true },
      active: false,
    });

    await openPinnedMutedTabWithBrowser(browser, channel, { platform: "twitch", status: "watching", offlineChecks: 0, tabId: 4, tabManagedByExtension: true });

    expect(browser.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  it("does not update the managed tab when it already matches the target channel, options, and healthy playback", async () => {
    const browser = browserMock();
    browser.tabs.get.mockResolvedValue({
      id: 4,
      url: channel.url,
      pinned: true,
      mutedInfo: { muted: true },
      active: false,
    });

    await openPinnedMutedTabWithBrowser(browser, channel, {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 4,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: new Date().toISOString(),
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    });

    expect(browser.tabs.update).not.toHaveBeenCalled();
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
    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(browser.tabs.remove).toHaveBeenCalledWith(4);
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { pinned: true, muted: true, active: false });
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { active: true });
    expect(browser.tabs.update).toHaveBeenCalledWith(7, { active: true });
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

  it("does not foreground-prime new tabs when page video control is disabled", async () => {
    const browser = browserMock();

    await openPinnedMutedTabWithBrowser(browser, channel, undefined, { keepVideosUnmuted: false });

    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: channel.url,
      pinned: true,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledTimes(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { pinned: true, muted: true, active: false });
    expect(browser.tabs.query).not.toHaveBeenCalled();
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

    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
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

  it("retains an extension-created page-context tab when requested", async () => {
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
      undefined,
      { retainPageContext: { platform: "twitch" } },
    );

    expect(result).toEqual({ ok: true });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: "https://www.twitch.tv/drops/inventory",
      pinned: false,
      active: false,
    });
    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(currentManagedPageContextTabs()).toMatchObject({
      twitch: {
        platform: "twitch",
        tabId: 14,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    });
  });

  it("reuses a retained page-context tab instead of creating a new one", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.get.mockResolvedValue({ id: 14, url: "https://www.twitch.tv/drops/inventory" });
    registerManagedPageContextTabs({
      twitch: {
        platform: "twitch",
        tabId: 14,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    });

    await fetchJsonInPageWithBrowser(
      browser,
      "https://www.twitch.tv/drops/inventory",
      "https://gql.twitch.tv/gql",
      undefined,
      { retainPageContext: { platform: "twitch" } },
    );

    expect(browser.tabs.get).toHaveBeenCalledWith(14);
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 14 },
    }));
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

  it("prefers an existing user tab over a retained page-context tab", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: { ok: true } }]),
      },
    };
    browser.tabs.query.mockResolvedValue([{ id: 3 }, { id: 14 }]);
    registerManagedPageContextTabs({
      kick: {
        platform: "kick",
        tabId: 14,
        originUrl: "https://kick.com",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    });

    await fetchJsonInPageWithBrowser(
      browser,
      "https://kick.com",
      "https://web.kick.com/api/v1/drops/progress",
      undefined,
      { retainPageContext: { platform: "kick" } },
    );

    expect(browser.tabs.get).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.remove).toHaveBeenCalledWith(14);
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 3 },
    }));
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

describe("fetchTwitchInBackgroundWith", () => {
  const cookieApi = {
    cookies: {
      get: vi.fn(async ({ name }: { name: string }) =>
        name === "auth-token" ? { value: "tok123" } : name === "unique_id" ? { value: "dev456" } : null),
    },
  };

  beforeEach(() => {
    cookieApi.cookies.get.mockClear();
  });

  it("attaches the OAuth token, device id and a session id for authenticated GQL", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: { currentUser: { id: "u" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await fetchTwitchInBackgroundWith(cookieApi, "https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko" },
      body: "{}",
    });

    const headers = new Headers(captured?.init.headers);
    expect(headers.get("authorization")).toBe("OAuth tok123");
    expect(headers.get("x-device-id")).toBe("dev456");
    expect(headers.get("client-session-id")).toMatch(/^[0-9a-f]{16}$/);
    expect(captured?.init.credentials).toBe("include");
    expect(result).toMatchObject({ data: { currentUser: { id: "u" } } });
    vi.unstubAllGlobals();
  });

  it("omits credentials and auth for anonymous public queries", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ data: { user: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await fetchTwitchInBackgroundWith(cookieApi, "https://gql.twitch.tv/gql", { credentials: "omit", body: "{}" });

    expect(cookieApi.cookies.get).not.toHaveBeenCalled();
    expect(new Headers(captured?.headers).has("authorization")).toBe(false);
    expect(captured?.credentials).toBe("omit");
    vi.unstubAllGlobals();
  });

  it("returns a serializable diagnostic envelope when the GQL fetch is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    const result = await fetchTwitchInBackgroundWith<{ __twitchGqlError?: string }>(
      cookieApi,
      "https://gql.twitch.tv/gql",
      { body: "{}" },
    );

    expect(result.__twitchGqlError).toContain("request failed (Failed to fetch)");
    expect(result.__twitchGqlError).toContain("authHeader=yes");
    vi.unstubAllGlobals();
  });

  it("returns channel page HTML for non-GQL Twitch URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>live</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));

    const result = await fetchTwitchInBackgroundWith<{ html: string }>(cookieApi, "https://www.twitch.tv/creator");

    expect(result.html).toBe("<html>live</html>");
    vi.unstubAllGlobals();
  });
});
