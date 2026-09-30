import { describe, expect, it } from "vitest";
import { parseTwitchExtensionLaneMemory } from "../src/extensions/host";

// #594: what the lane keeps across service-worker restarts is validated on load.
describe("Twitch Extensions lane memory", () => {
  const now = Date.UTC(2026, 8, 14, 12);

  it("keeps valid, unexpired deadlines", () => {
    expect(parseTwitchExtensionLaneMemory({
      version: 1,
      knownComplete: { nopixel: now + 60_000 },
      completedUntil: { fortnite: now + 60_000 },
      unavailableUntil: { "nopixel:buddha": now + 60_000 },
      lastCompletedNoPixelChannel: "buddha",
      owner: "viewer",
    }, now)).toEqual({
      version: 1,
      knownComplete: { nopixel: now + 60_000 },
      completedUntil: { fortnite: now + 60_000 },
      unavailableUntil: { "nopixel:buddha": now + 60_000 },
      lastCompletedNoPixelChannel: "buddha",
      owner: "viewer",
    });
  });

  it("drops expired, far-future, unknown and malformed entries", () => {
    expect(parseTwitchExtensionLaneMemory({
      version: 1,
      knownComplete: { nopixel: now - 1, fortnite: now + 30 * 60 * 60_000, drops: now + 60_000 },
      completedUntil: { nopixel: "soon" },
      unavailableUntil: { "nopixel:Buddha!": now + 60_000, "unknown:buddha": now + 60_000, "nopixel:buddha:extra": now + 60_000, "fortnite:ninja": Number.NaN },
      lastCompletedNoPixelChannel: "not a login",
      owner: "Not A Login!",
      token: "private",
    }, now)).toEqual({ version: 1, knownComplete: {}, completedUntil: {}, unavailableUntil: {} });
  });

  it.each([undefined, null, "memory", { version: 2 }])("treats %s as no memory", (value) => {
    expect(parseTwitchExtensionLaneMemory(value, now)).toBeUndefined();
  });

  it("bounds the number of channel cooldowns it restores", () => {
    const unavailableUntil = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`nopixel:channel${index}`, now + 60_000]));
    const parsed = parseTwitchExtensionLaneMemory({ version: 1, knownComplete: {}, completedUntil: {}, unavailableUntil }, now);
    expect(Object.keys(parsed!.unavailableUntil)).toHaveLength(64);
  });
});
