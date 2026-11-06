import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "@lurkloot/shared/events";
import {
  cancelTwitchIntegrityAcquisition,
  createTabRegistry,
  setTwitchIntegrity,
  TWITCH_FRESH_MINT_EPISODE_MS,
  twitchMintHeld,
  type TabRegistry,
} from "@lurkloot/core/tabRegistry";
import type { TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import { ensureTwitchIntegrityWithBrowser } from "../src/core/browserTabs";

// #1003: in one user's browser Twitch rejected every token the extension's
// own twitch.tv page context minted, on the very next request. Each rejection
// minted again, so the dashboard and the channel-points claim opened two
// twitch.tv tabs a minute, forever.

const URL = "https://www.twitch.tv/drops/inventory";

function token(integrity: string): TwitchIntegrity {
  return {
    integrity,
    clientSessionId: "session",
    deviceId: "device",
    expiresAt: Date.now() + 12 * 60 * 60_000,
    expiryUnknown: true,
  };
}

// A browser whose every new twitch.tv tab mints a fresh token at once.
function mintingBrowser(registry: TabRegistry) {
  let nextTabId = 100;
  const browser = {
    tabs: {
      get: vi.fn(),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
      create: vi.fn(async () => {
        const id = nextTabId++;
        setTimeout(() => {
          setTwitchIntegrity(registry, token(`minted-${id}`), { isNew: true, sourceTabId: id });
        }, 0);
        return { id };
      }),
    },
  };
  return browser;
}

describe("Twitch integrity mint hold", () => {
  let registry: TabRegistry;
  let events: EngineEvent[];
  const emit = (event: EngineEvent) => events.push(event);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T23:00:00.000Z"));
    registry = createTabRegistry();
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // What the adapter does when Twitch rejects the current token.
  function recover(browser: ReturnType<typeof mintingBrowser>): Promise<boolean> {
    return ensureTwitchIntegrityWithBrowser(registry, browser, URL, 5_000, emit, {
      forceRefresh: true,
      reason: "rejection_recovery",
      rejectedToken: registry.twitchIntegrity?.integrity,
    });
  }

  it("stops opening tabs within hours of ticks when every minted token is rejected", async () => {
    const browser = mintingBrowser(registry);
    setTwitchIntegrity(registry, token("stale"), { isNew: true, sourceTabId: 1 });

    // Three hours of one-minute ticks; each tick, the dashboard read and the
    // channel-points claim are both rejected on whatever token is current.
    for (let minute = 0; minute < 180; minute += 1) {
      await recover(browser);
      await recover(browser);
      vi.setSystemTime(Date.now() + 60_000);
    }

    // The stale token's recovery, then one more mint for a possible blip.
    expect(browser.tabs.create).toHaveBeenCalledTimes(2);
    expect(twitchMintHeld(registry)).toBe(true);
    const warnings = events.filter(
      (event) => event.category === "diagnostic" && event.level === "warn",
    );
    expect(
      warnings.filter((event) =>
        "message" in event
          ? (event.message?.includes("stopped opening twitch.tv tabs") ?? false)
          : false,
      ),
    ).toHaveLength(1);
  });

  it("keeps minting when a freshly minted token is rejected only once", async () => {
    const browser = mintingBrowser(registry);
    setTwitchIntegrity(registry, token("stale"), { isNew: true, sourceTabId: 1 });

    await expect(recover(browser)).resolves.toBe(true);
    // A blip: the fresh token is rejected once, the next one works.
    await expect(recover(browser)).resolves.toBe(true);
    expect(twitchMintHeld(registry)).toBe(false);

    // An unrelated rejection much later is a new episode, not a second strike.
    vi.setSystemTime(Date.now() + TWITCH_FRESH_MINT_EPISODE_MS + 60_000);
    await expect(recover(browser)).resolves.toBe(true);
    vi.setSystemTime(Date.now() + 60_000);
    await expect(recover(browser)).resolves.toBe(true);

    expect(twitchMintHeld(registry)).toBe(false);
    expect(browser.tabs.create).toHaveBeenCalledTimes(4);
  });

  it("holds readiness mints too, so a lost token cannot reopen the loop", async () => {
    const browser = mintingBrowser(registry);
    setTwitchIntegrity(registry, token("stale"), { isNew: true, sourceTabId: 1 });
    await recover(browser);
    await recover(browser);
    await recover(browser);
    expect(twitchMintHeld(registry)).toBe(true);
    const opened = browser.tabs.create.mock.calls.length;

    setTwitchIntegrity(registry, undefined);
    await expect(
      ensureTwitchIntegrityWithBrowser(registry, browser, URL, 5_000, emit),
    ).resolves.toBe(false);
    expect(browser.tabs.create).toHaveBeenCalledTimes(opened);
  });

  it("lifts the hold when the user's own twitch.tv tab provides a token", async () => {
    const browser = mintingBrowser(registry);
    setTwitchIntegrity(registry, token("stale"), { isNew: true, sourceTabId: 1 });
    await recover(browser);
    await recover(browser);
    await recover(browser);
    expect(twitchMintHeld(registry)).toBe(true);

    setTwitchIntegrity(registry, token("from-user-tab"), { isNew: true, sourceTabId: 7 });

    expect(twitchMintHeld(registry)).toBe(false);
    const opened = browser.tabs.create.mock.calls.length;
    await expect(recover(browser)).resolves.toBe(true);
    expect(browser.tabs.create).toHaveBeenCalledTimes(opened + 1);
  });

  it("lifts the hold when the integrity lifecycle restarts", async () => {
    const browser = mintingBrowser(registry);
    setTwitchIntegrity(registry, token("stale"), { isNew: true, sourceTabId: 1 });
    await recover(browser);
    await recover(browser);
    await recover(browser);
    expect(twitchMintHeld(registry)).toBe(true);

    cancelTwitchIntegrityAcquisition(registry, new Error("Twitch disabled"));

    expect(twitchMintHeld(registry)).toBe(false);
  });

  it("does not lift the hold for the managed tab's own token seen again", async () => {
    const browser = mintingBrowser(registry);
    setTwitchIntegrity(registry, token("stale"), { isNew: true, sourceTabId: 1 });
    await recover(browser);
    await recover(browser);
    await recover(browser);
    expect(twitchMintHeld(registry)).toBe(true);
    const current = registry.twitchIntegrity!;

    // A late request from the closed context still carries its token.
    setTwitchIntegrity(registry, current, { sourceTabId: 7 });

    expect(twitchMintHeld(registry)).toBe(true);
  });
});
