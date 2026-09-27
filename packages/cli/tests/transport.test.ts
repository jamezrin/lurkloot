import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransport } from "../src/transport";
import { withHeartbeatTimeout } from "../src/transport/common";
import { createTickEffectExecutor } from "@lurkloot/core/background/tickEffects";
import { createTabRegistry } from "@lurkloot/core/tabRegistry";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent } from "@lurkloot/shared/events";
import { reportCliEvents } from "../src/events";
import { createLogger } from "../src/logger";

const ENABLED = { twitch: true, kick: true };

afterEach(() => vi.unstubAllGlobals());

function twitchOperation(init?: RequestInit): string {
  return JSON.parse(String(init?.body)).operationName;
}

function twitchResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function emptyTwitchInventory(): unknown {
  return {
    data: {
      currentUser: {
        id: "viewer-id",
        inventory: { dropCampaignsInProgress: [] },
      },
    },
  };
}

function retainedTwitchDashboard(): unknown {
  return {
    data: {
      currentUser: {
        id: "viewer-id",
        login: "viewer",
        dropCampaigns: [{ id: "retained", status: "ACTIVE", self: { isAccountConnected: true } }],
      },
    },
  };
}

function retainedTwitchCampaignDetails(): unknown {
  return {
    data: {
      dropCampaign: {
        id: "retained",
        name: "Retained Campaign",
        game: { id: "game", slug: "game-slug", displayName: "Game" },
        timeBasedDrops: [{
          id: "retained-drop",
          requiredMinutesWatched: 60,
          benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
        }],
      },
    },
  };
}

describe("createTransport", () => {
  it("keeps route counts useful in CLI debug output across fresh adapters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"id":42}', { status: 200, headers: { "content-type": "application/json" } })));
    const events: EngineEvent[] = [];
    const emit = (event: EngineEvent) => events.push(event);
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    try {
      for (let tick = 0; tick < 3; tick += 1) {
        const { adapter } = handle.createAdapter("kick", emit, DEFAULT_ENGINE_SETTINGS);
        for (let request = 0; request < 10; request += 1) await adapter.checkAuthHealth();
        adapter.flushRouteDiagnostics?.(emit);
      }
      const summaries = events.filter((event) => event.category === "diagnostic" && event.code === "kick_fetch_summary") as DiagnosticEvent[];
      expect(summaries.map((event) => event.data)).toEqual(Array(3).fill({ "kick.com.background": 10 }));
      expect(events.filter((event) => event.level === "info")).toHaveLength(1);
      const output: string[] = [];
      const write = vi.spyOn(process.stderr, "write").mockImplementation((line) => { output.push(String(line)); return true; });
      try {
        await reportCliEvents(events, createLogger("debug"));
      } finally {
        write.mockRestore();
      }
      expect(output.filter((line) => line.includes("DEBUG [kick]") && line.includes("kick.com.background=10"))).toHaveLength(3);
      expect(output.join("\n")).not.toContain("service worker");
    } finally {
      await handle.dispose();
    }
  });

  it("builds a disposable http transport with both adapters", async () => {
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    expect(handle.adapters.twitch.platform).toBe("twitch");
    expect(handle.adapters.kick.platform).toBe("kick");
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it("resolves the Smart TV client to Spade rather than Android Trowel", async () => {
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);

    const construction = handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS);

    expect(construction.compatibility.twitch.heartbeat).toBe("twitch-heartbeat-spade-v1");
    expect(construction.adapters.twitch.compatibility).toEqual(construction.compatibility.twitch);
    expect(construction.adapters.kick.compatibility).toEqual(construction.compatibility.kick);
    await handle.dispose();
  });

  it("shares Kick claim suppression across fresh HTTP adapter constructions", async () => {
    let claimPosts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return new Response(JSON.stringify({ connect_url: "https://accounts.example/link" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", name: "Reward", status: "claimable" } as DropReward;

    await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.kick.claimReward(campaign, reward);
    await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.kick.claimReward(campaign, reward);

    expect(claimPosts).toBe(1);
    await handle.dispose();
  });

  it("retains Twitch discovery across fresh HTTP adapter constructions", async () => {
    let dashboardAvailable = true;
    let detailsAvailable = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      switch (twitchOperation(init)) {
        case "Inventory":
          return twitchResponse(emptyTwitchInventory());
        case "ViewerDropsDashboard":
          if (dashboardAvailable) {
            dashboardAvailable = false;
            return twitchResponse(retainedTwitchDashboard());
          }
          throw new Error("dashboard unavailable");
        case "DropCampaignDetails":
          if (detailsAvailable) {
            detailsAvailable = false;
            return twitchResponse(retainedTwitchCampaignDetails());
          }
          throw new Error("details unavailable");
        default:
          throw new Error(`Unexpected Twitch operation ${twitchOperation(init)}`);
      }
    }));
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);

    const first = await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.twitch.refreshCampaigns();
    const second = await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.twitch.refreshCampaigns();

    expect(first.map((campaign) => campaign.id)).toEqual(["retained"]);
    expect(second.map((campaign) => campaign.id)).toEqual(["retained"]);
    await handle.dispose();
  });

  it("isolates retained Twitch discovery between HTTP transport handles", async () => {
    let seedFirstHandle = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      switch (twitchOperation(init)) {
        case "Inventory":
          return twitchResponse(emptyTwitchInventory());
        case "ViewerDropsDashboard":
          if (seedFirstHandle) return twitchResponse(retainedTwitchDashboard());
          throw new Error("dashboard unavailable");
        case "DropCampaignDetails":
          return twitchResponse(retainedTwitchCampaignDetails());
        default:
          throw new Error(`Unexpected Twitch operation ${twitchOperation(init)}`);
      }
    }));
    const firstHandle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    const secondHandle = await createTransport("http", {}, "/tmp/auth", ENABLED);

    expect((await firstHandle.adapters.twitch.refreshCampaigns()).map((campaign) => campaign.id))
      .toEqual(["retained"]);
    seedFirstHandle = false;

    await expect(secondHandle.adapters.twitch.refreshCampaigns()).resolves.toEqual([]);
    await firstHandle.dispose();
    await secondHandle.dispose();
  });

  it("discovers a live-channel campaign when Twitch returns a null dashboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      switch (twitchOperation(init)) {
        case "Inventory": return twitchResponse(emptyTwitchInventory());
        case "ViewerDropsDashboard": return twitchResponse({ data: { currentUser: { id: "viewer-id", dropCampaigns: null } } });
        case "DirectoryPage_Game": return twitchResponse({ data: { game: { streams: { edges: [{ node: {
          id: "broadcast-id", broadcaster: { id: "channel-id", login: "creator" },
        } }] } } } });
        case "DropsHighlightService_AvailableDrops": return twitchResponse({ data: { channel: {
          id: "channel-id", viewerDropCampaigns: [{
            id: "new-campaign", name: "New campaign",
            game: { id: "game-id", name: "Rust", displayName: "Rust" },
            endAt: "2099-01-01T00:00:00Z",
            timeBasedDrops: [{ id: "reward-id", name: "Reward", requiredMinutesWatched: 60,
              startAt: "2026-01-01T00:00:00Z", benefitEdges: [{ benefit: { id: "benefit-id", name: "Benefit" } }] }],
          }],
        } } });
        default: throw new Error(`Unexpected Twitch operation ${twitchOperation(init)}`);
      }
    }));
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    const settings = structuredClone(DEFAULT_ENGINE_SETTINGS);
    settings.platform.twitch.categories = [{ id: "game-id", name: "Rust" }];

    const campaigns = await handle.createAdapters(() => {}, settings).adapters.twitch.refreshCampaigns();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["new-campaign"]);
    expect(campaigns[0]?.allowedChannels).toEqual(["creator"]);
    await handle.dispose();
  });

  it("continues scanning other games after one live-directory failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      switch (request.operationName) {
        case "Inventory": return twitchResponse(emptyTwitchInventory());
        case "ViewerDropsDashboard": return twitchResponse({ data: { currentUser: { id: "viewer-id", dropCampaigns: null } } });
        case "DirectoryPage_Game":
          if (request.variables.slug === "Broken") throw new Error("temporary directory failure");
          return twitchResponse({ data: { game: { streams: { edges: [{ node: {
            broadcaster: { id: "channel-id", login: "creator" },
          } }] } } } });
        case "DropsHighlightService_AvailableDrops": return twitchResponse({ data: { channel: {
          id: "channel-id", viewerDropCampaigns: [{ id: "working", name: "Working",
            game: { id: "working-game", name: "Working" },
            timeBasedDrops: [{ id: "reward", requiredMinutesWatched: 30 }],
          }],
        } } });
        default: throw new Error(`Unexpected operation ${request.operationName}`);
      }
    }));
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    const settings = structuredClone(DEFAULT_ENGINE_SETTINGS);
    settings.platform.twitch.categories = [{ id: "broken", name: "Broken" }, { id: "working", name: "Working" }];

    const campaigns = await handle.createAdapters(() => {}, settings).adapters.twitch.refreshCampaigns();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["working"]);
    await handle.dispose();
  });

  it("reports a failed discovery when every configured game lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      switch (twitchOperation(init)) {
        case "Inventory": return twitchResponse(emptyTwitchInventory());
        case "ViewerDropsDashboard": return twitchResponse({ data: { currentUser: { id: "viewer-id", dropCampaigns: null } } });
        case "DirectoryPage_Game": throw new Error("directory unavailable");
        default: throw new Error(`Unexpected Twitch operation ${twitchOperation(init)}`);
      }
    }));
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    const settings = structuredClone(DEFAULT_ENGINE_SETTINGS);
    settings.platform.twitch.categories = [{ id: "game", name: "Rust" }];

    await expect(handle.createAdapters(() => {}, settings).adapters.twitch.refreshCampaigns())
      .rejects.toThrow(/directory unavailable/);
    await handle.dispose();
  });

  it("sends Trowel through the HTTP transport request path", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(url.includes("trowel.twitch.tv") ? null : JSON.stringify({
      data: { user: { id: "channel-id", stream: { id: "broadcast-id" } } },
    }), { status: url.includes("trowel.twitch.tv") ? 204 : 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const handle = await createTransport("http", { twitch: { authToken: "token", clientId: "kd1unb4b3q4t58fwlpcbzcbnm76a8fp" } }, "/tmp/auth", ENABLED);
    const watcher = handle.adapters.twitch.createTablessWatcher!();
    await watcher.start({ platform: "twitch", username: "creator", url: "https://twitch.tv/creator" }, { userId: "viewer-id" });

    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(fetchMock).toHaveBeenCalledWith("https://trowel.twitch.tv/track", expect.objectContaining({ method: "POST" }));
    await handle.dispose();
  });

  it("sends custom-client Spade page resolution and beacon through HTTP fetch", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("gql.twitch.tv")) return new Response(JSON.stringify({
        data: { user: { id: "channel-id", stream: { id: "broadcast-id" } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://www.twitch.tv/creator") {
        return new Response('<script src="https://static.twitch.tv/config/settings.js"></script>');
      }
      if (url === "https://static.twitch.tv/config/settings.js") {
        return new Response('{"spade_url":"https://spade.twitch.tv/track"}');
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handle = await createTransport("http", {
      twitch: { authToken: "token", clientId: "custom-web-client" },
    }, "/tmp/auth", ENABLED);
    const watcher = handle.adapters.twitch.createTablessWatcher!();
    await watcher.start({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }, { userId: "viewer-id" });

    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(fetchMock).toHaveBeenCalledWith("https://www.twitch.tv/creator", expect.objectContaining({
      credentials: "include",
      redirect: "error",
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://static.twitch.tv/config/settings.js", expect.objectContaining({
      credentials: "include",
      redirect: "error",
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://spade.twitch.tv/track", expect.objectContaining({ method: "POST" }));
    await handle.dispose();
  });

  // The Twitch adapter reads strict campaign availability from engine settings,
  // so a construction site that stops forwarding it silently reverts every CLI
  // run to rejecting candidates on AvailableDrops (#400). Asserted through
  // behaviour rather than the private option: what matters is whether the
  // request goes out.
  describe.each([
    { strictCampaignAvailability: false, expected: [] as string[] },
    { strictCampaignAvailability: true, expected: ["DropsHighlightService_AvailableDrops"] },
  ])("forwards strictCampaignAvailability=$strictCampaignAvailability to the Twitch adapter", ({ strictCampaignAvailability, expected }) => {
    it("matches the availability requests the setting implies", async () => {
      const operations: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        const operation = twitchOperation(init);
        operations.push(operation);
        if (operation === "DropsHighlightService_AvailableDrops") {
          return twitchResponse({
            data: { channel: { id: "channel-id", viewerDropCampaigns: [{ id: "campaign" }] } },
          });
        }
        throw new Error(`Unexpected Twitch operation ${operation}`);
      }));
      const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
      const settings = {
        ...DEFAULT_ENGINE_SETTINGS,
        platform: {
          ...DEFAULT_ENGINE_SETTINGS.platform,
          twitch: { ...DEFAULT_ENGINE_SETTINGS.platform.twitch, strictCampaignAvailability },
        },
      };

      const selection = await handle.createAdapters(() => {}, settings).adapters.twitch.selectCandidateChannel?.(
        [{
          platform: "twitch",
          username: "directory-one",
          url: "https://www.twitch.tv/directory-one",
          channelId: "channel-id",
          broadcastId: "broadcast-id",
          categoryId: "game",
          live: true,
          isAclMatch: false,
        }],
        { id: "campaign", name: "Campaign", categoryId: "game" } as DropCampaign,
      );

      expect(selection?.channel?.username).toBe("directory-one");
      expect(operations).toEqual(expected);
      await handle.dispose();
    });
  });

  // impersonate and browser are exercised by impersonate.test.ts / browser.test.ts
  // (with cycletls/Playwright handled there, so no real subprocess spawns here).
});

// The CLI declares no browser tabs, so the tick runs with no watch-tab port
// (#598): opening a tab fails loudly and stopping one is a harmless no-op.
describe("watch tabs without the browserTabs capability", () => {
  const context = { adapters: {}, tabRegistry: createTabRegistry(), emit: () => undefined };

  it("fails loudly when asked to open a watch tab", async () => {
    await expect(createTickEffectExecutor().run({
      type: "openWatchTab",
      platform: "twitch",
      channel: { platform: "twitch", username: "x", url: "https://twitch.tv/x" },
      session: { platform: "twitch", status: "idle", offlineChecks: 0 },
    }, context)).rejects.toThrow('Tab-based watch is unavailable headlessly; keep "tablessMode" enabled in the config');
  });

  it("treats stopping as a harmless no-op", async () => {
    await expect(createTickEffectExecutor().run({
      type: "stopWatchTab",
      platform: "twitch",
      session: { platform: "twitch", status: "idle", offlineChecks: 0 },
    }, context)).resolves.toBeUndefined();
  });
});

describe("heartbeat request bounds", () => {
  it("rejects a stalled request after the configured timeout", async () => {
    vi.useFakeTimers();
    const request = withHeartbeatTimeout(() => new Promise<never>(() => {}), undefined, 25);
    const rejection = expect(request).rejects.toThrow("Twitch heartbeat request timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    vi.useRealTimers();
  });

  it("preserves caller cancellation and its reason", async () => {
    const caller = new AbortController();
    const reason = new Error("caller stopped");
    const request = withHeartbeatTimeout(() => new Promise<never>(() => {}), caller.signal, 10_000);

    caller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });
});
