import type { EngineSettings, TwitchExtensionProviderId } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { withActivityDiagnostics } from "../../core/activityDiagnostics";
import { createFortniteDriver } from "../fortnite/driver";
import type { FortniteSocketFactory } from "../fortnite/socket";
import { createNoPixelDriver, type NoPixelFetch } from "../nopixel/driver";
import { driverRewardEvent, type DriverReward } from "./rewardEvents";
import type { TwitchExtensionDriverFactory } from "./runtime";

// A driver's reward, published through its session so that nothing is
// reported once the session has ended (#594).
function publishDriverReward(
  publish: ((events: readonly EngineEvent[]) => void) | undefined,
  channel: { username: string } | undefined,
  provider: "fortnite" | "nopixel",
  reward: DriverReward,
): void {
  if (!publish || !channel || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.username)) return;
  const events: EngineEvent[] = [];
  withActivityDiagnostics((event) => events.push(event))(
    driverRewardEvent(provider, channel.username, reward),
  );
  publish(events);
}

export function createTwitchExtensionDrivers(options: {
  fetch: NoPixelFetch;
  createSocket: FortniteSocketFactory;
  loadSettings(): Promise<EngineSettings>;
}): Record<TwitchExtensionProviderId, TwitchExtensionDriverFactory> {
  return {
    fortnite: async (session, emit, channel, publish) =>
      createFortniteDriver({
        allowTakeovers: (await options.loadSettings()).twitchExtensions.fortnite.allowTakeovers,
        // A takeover is not a reward: it is logged, not listed in Activity.
        onTakeoverStarted: () =>
          publish?.([
            {
              category: "diagnostic",
              platform: "twitch",
              level: "info",
              message: `Fortnite takeover started on ${channel?.username ?? "the watched channel"}`,
            },
          ]),
        createSocket: options.createSocket,
        onCaptured: ({ collectableId }) =>
          publishDriverReward(publish, channel, "fortnite", { type: "capture", collectableId }),
      })(session, emit, channel, publish),
    nopixel: async (session, emit, channel, publish) =>
      createNoPixelDriver(
        options.fetch,
        () => publishDriverReward(publish, channel, "nopixel", { type: "giveaway" }),
        Date.now,
        (message) =>
          publish?.([{ category: "diagnostic", platform: "twitch", level: "warn", message }]),
        {
          autoOpenPacks: (await options.loadSettings()).twitchExtensions.nopixel.autoOpenPacks,
          onOpened: (pack) =>
            publishDriverReward(publish, channel, "nopixel", { type: "pack", ...pack }),
        },
      )(session, emit, channel, publish),
  };
}
