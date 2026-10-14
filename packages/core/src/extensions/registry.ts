import type { TwitchExtensionProviderDescriptor } from "./types";

export const twitchExtensionProviders: readonly TwitchExtensionProviderDescriptor[] = Object.freeze(
  [
    Object.freeze({
      id: "nopixel" as const,
      extensionId: "nstuq90nghenyqwqme61jgvmtp253a",
      backendOrigin: "https://nopixel.streamingtoolsmith.com/*" as const,
      discoveryCategoryIds: Object.freeze(["32982"]),
      minRefreshIntervalMs: 60_000,
      needsChatPresence: true,
      // Its overlay sets and clears the open giveaway from these (1.1.4).
      broadcastRefreshEvents: Object.freeze(["cards.giveaway.started", "cards.giveaway.ended"]),
    }),
    Object.freeze({
      id: "fortnite" as const,
      extensionId: "x2nfeda4neuzvsp2zdqfln9nwxc7tp",
      backendOrigin: "https://backend.p-n6412w7dsu.exmggames.com/*" as const,
      backendSocketOrigin: "wss://backend.p-n6412w7dsu.exmggames.com/*" as const,
      discoveryCategoryIds: Object.freeze(["33214"]),
      minRefreshIntervalMs: 10_000,
      needsChatPresence: false,
    }),
  ],
);

// Every host the provider needs granted: its backend and, where it has one,
// its socket backend. Requested together and required together.
export function twitchExtensionProviderOrigins(
  provider: TwitchExtensionProviderDescriptor,
): string[] {
  return provider.backendSocketOrigin
    ? [provider.backendOrigin, provider.backendSocketOrigin]
    : [provider.backendOrigin];
}

// The origin the provider's extension frame has on Twitch.
export function twitchExtensionFrameOrigin(provider: TwitchExtensionProviderDescriptor): string {
  return `https://${provider.extensionId}.ext-twitch.tv`;
}

export function twitchExtensionProvider(id: string): TwitchExtensionProviderDescriptor | undefined {
  return twitchExtensionProviders.find((provider) => provider.id === id);
}
