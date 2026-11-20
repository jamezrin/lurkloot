import { expect, it, vi } from "vitest";
import * as host from "@lurkloot/core/extensions/host";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";

const drivers = vi.hoisted(() => ({ fortnite: vi.fn(), nopixel: vi.fn() }));
vi.mock("@lurkloot/core/extensions/fortnite/driver", () => ({
  createFortniteDriver: drivers.fortnite,
}));
vi.mock("@lurkloot/core/extensions/nopixel/driver", () => ({
  createNoPixelDriver: drivers.nopixel,
}));

it("reads driver settings per session and publishes only activity for a valid channel", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const fetch = vi.fn();
  const createSocket = vi.fn();
  const publish = vi.fn();
  const startDriver = vi.fn();
  drivers.fortnite.mockReturnValue(startDriver);
  drivers.nopixel.mockReturnValue(startDriver);
  const factories = host.createTwitchExtensionDrivers({
    fetch,
    createSocket,
    loadSettings: async () => settings,
  });
  const session = {
    jwt: "session",
    channelId: "1",
    expiresAt: 1,
    version: "1",
    identityLinked: true,
  };
  settings.twitchExtensions.fortnite.allowTakeovers = true;
  await factories.fortnite(session, vi.fn(), { username: "streamer" }, publish);
  const [fortnite] = drivers.fortnite.mock.lastCall!;
  expect(fortnite.allowTakeovers).toBe(true);
  expect(fortnite.createSocket).toBe(createSocket);
  fortnite.onTakeoverStarted();
  fortnite.onCaptured({ collectableId: "sprite" });
  expect(
    publish.mock.calls.map(([events]) =>
      events.map(({ category }: { category: string }) => category),
    ),
  ).toEqual([["diagnostic"], ["activity", "diagnostic"]]);

  settings.twitchExtensions.nopixel.autoOpenPacks = true;
  await factories.nopixel(session, vi.fn(), { username: "invalid channel" }, publish);
  const [noPixelFetch, giveaway, , diagnostic, pack] = drivers.nopixel.mock.lastCall!;
  expect(noPixelFetch).toBe(fetch);
  expect(pack.autoOpenPacks).toBe(true);
  giveaway();
  expect(publish).toHaveBeenCalledTimes(2);
  diagnostic("test warning");
  expect(publish.mock.lastCall?.[0]).toEqual([
    { category: "diagnostic", platform: "twitch", level: "warn", message: "test warning" },
  ]);
});
