import { describe, expect, it } from "vitest";
import { createTransport } from "../src/transport";
import { tablessWatchPort } from "../src/transport/common";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";

const ENABLED = { twitch: true, kick: true };

describe("createTransport", () => {
  it("builds a disposable http transport with both adapters", async () => {
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    expect(handle.adapters.twitch.platform).toBe("twitch");
    expect(handle.adapters.kick.platform).toBe("kick");
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it("resolves CLI adapters with the Android Twitch identity", async () => {
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);

    const construction = handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS);

    expect(construction.compatibility.twitch.heartbeat).toBe("twitch-heartbeat-trowel-v1");
    await handle.dispose();
  });

  // impersonate and browser are exercised by impersonate.test.ts / browser.test.ts
  // (with cycletls/Playwright handled there, so no real subprocess spawns here).
});

describe("tablessWatchPort", () => {
  it("fails loudly when asked to open a watch tab", () => {
    expect(() => tablessWatchPort.openPinnedMutedTab({ platform: "twitch", username: "x", url: "https://twitch.tv/x" }))
      .toThrow(/Tab-based watch is unavailable/);
  });

  it("treats stopping as a harmless no-op", async () => {
    await expect(tablessWatchPort.stopWatchTab({ platform: "twitch", status: "idle", offlineChecks: 0 })).resolves.toBeUndefined();
  });
});
