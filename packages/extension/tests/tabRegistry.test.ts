import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ChannelCandidate, WatchSession } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import {
  applyAdFocusWithBrowser,
  createTabRegistry,
  currentManagedPageContextTabs,
  currentTwitchIntegrityWaiterCount,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrityWithBrowser,
  managedTabBreakerOpen,
  noteTwitchGqlRequest,
  openPinnedMutedTabWithBrowser,
  registerManagedPageContextTabs,
  syncManagedTabBreakers,
  type TabRegistry,
} from "@lurkloot/core/tabs";
import { harness, integrityBundle, integrityHeaders } from "./helpers/backgroundController";

// #598: tab state belongs to one controller's registry. Two controllers in one
// process must share none of it, whichever kind of tab state it is.

const channel: ChannelCandidate = {
  platform: "twitch",
  username: "creator",
  url: "https://www.twitch.tv/creator",
};

// A managed watch tab whose player never starts, so opening it primes playback.
const stalledSession: WatchSession = {
  platform: "twitch",
  status: "watching",
  offlineChecks: 0,
  tabId: 4,
  tabManagedByExtension: true,
  playback: {
    platform: "twitch",
    checkedAt: new Date().toISOString(),
    videoCount: 1,
    mutedVideoCount: 1,
    unmutedVideoCount: 0,
    playingVideoCount: 0,
    blockedPlaybackCount: 1,
    documentHidden: false,
  },
};

function browserMock() {
  return {
    tabs: {
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: channel.url,
        pinned: true,
        mutedInfo: { muted: true },
        active: false,
        windowId: 2,
      })),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
      create: vi.fn(async () => ({ id: 9 })),
    },
    windows: {
      update: vi.fn(async () => undefined),
    },
  };
}

// Everything a registry holds, in a comparable shape.
function tabState(registry: TabRegistry) {
  return {
    pageContexts: currentManagedPageContextTabs(registry),
    pageContextEntries: registry.pageContextTabs.size,
    pageContextRevision: registry.retainedPageContextRevision,
    breakers: [...registry.openManagedTabBreakers],
    playbackPrimes: registry.playbackPrimeStates.size,
    adFocusHolds: registry.adFocusHolds.size,
    previousFocus: registry.previousFocus,
    integrity: currentValidTwitchIntegrity(registry),
    integrityCaptures: registry.twitchIntegrityCapturesBySourceTab.size,
    integrityWaiters: currentTwitchIntegrityWaiterCount(registry),
    integrityAcquisition: registry.inFlightIntegrityAcquisition !== undefined,
    contextBoot: registry.twitchContextBoot,
  };
}

describe("tab registry isolation", () => {
  it("keeps every kind of tab state inside the registry that recorded it", async () => {
    const first = createTabRegistry();
    const second = createTabRegistry();
    const untouched = tabState(second);
    const browser = browserMock();

    registerManagedPageContextTabs(first, {
      kick: {
        platform: "kick",
        tabId: 20,
        originUrl: "https://kick.com/drops/inventory",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    });
    syncManagedTabBreakers(first, { criticalHealth: { kick: { breakerOpen: true } } });
    await openPinnedMutedTabWithBrowser(first, browser, channel, stalledSession);
    await applyAdFocusWithBrowser(first, browser, "twitch", 42, true, "tab");
    const waiting = ensureTwitchIntegrityWithBrowser(first, browser, "https://www.twitch.tv/drops/inventory", 50, undefined, {
      forceRefresh: true,
    });
    await vi.waitFor(() => expect(currentTwitchIntegrityWaiterCount(first)).toBe(1));
    noteTwitchGqlRequest(first, 9);

    const recorded = tabState(first);
    expect(recorded.pageContexts.kick?.tabId).toBe(20);
    expect(managedTabBreakerOpen(first, "kick")).toBe(true);
    expect(recorded.playbackPrimes).toBe(1);
    expect(recorded.adFocusHolds).toBe(1);
    expect(recorded.integrityWaiters).toBe(1);
    expect(recorded.integrityAcquisition).toBe(true);
    expect(tabState(second)).toEqual(untouched);
    expect(managedTabBreakerOpen(second, "kick")).toBe(false);

    await waiting;
  });

  it("gives two controllers in one process separate tab state", async () => {
    const first = harness({ ...DEFAULT_SETTINGS });
    const second = harness({ ...DEFAULT_SETTINGS });
    await Promise.all([first.controller.settleBackgroundWork(), second.controller.settleBackgroundWork()]);
    const untouched = tabState(second.tabRegistry);

    const token = integrityBundle({ integrity: "first-controller-token" });
    await first.controller.captureTwitchIntegrity(integrityHeaders(token), 7);

    expect(first.tabRegistry).not.toBe(second.tabRegistry);
    expect(currentValidTwitchIntegrity(first.tabRegistry)?.integrity).toBe(token.integrity);
    expect(tabState(second.tabRegistry)).toEqual(untouched);
  });

  // #598: the scheduler receives page contexts as input and the controller
  // facade gets its registry from a slice, so neither imports a tab module.
  it("keeps the scheduler and the controller facade free of tab imports", () => {
    const core = resolve(dirname(fileURLToPath(import.meta.url)), "../../core/src");
    for (const file of ["core/scheduler.ts", "background/controller.ts"]) {
      const source = readFileSync(resolve(core, file), "utf8");
      expect(source, file).not.toMatch(/from\s+"[^"]*\/tabs"/);
    }
  });

  it("keeps no mutable state at module level in core/tabs", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../core/src/core/tabs.ts"),
      "utf8",
    );
    const moduleState = source.split("\n").filter((line) =>
      /^let\s/.test(line) || /^const\s+\w+\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|AbortController)\b/.test(line));
    expect(moduleState).toEqual([]);
  });
});
