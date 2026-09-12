import type { TwitchExtensionProviderDescriptor } from "./types";

export const twitchExtensionProviders: readonly TwitchExtensionProviderDescriptor[] = Object.freeze([
  Object.freeze({
    id: "nopixel" as const,
    extensionId: "nstuq90nghenyqwqme61jgvmtp253a",
    backendOrigin: "https://nopixel.streamingtoolsmith.com/*" as const,
    discoveryCategoryIds: Object.freeze(["32982"]),
    minRefreshIntervalMs: 60_000,
  }),
  Object.freeze({
    id: "fortnite" as const,
    extensionId: "x2nfeda4neuzvsp2zdqfln9nwxc7tp",
    backendOrigin: "https://backend.p-n6412w7dsu.exmggames.com/*" as const,
    discoveryCategoryIds: Object.freeze(["33214"]),
    minRefreshIntervalMs: 10_000,
  }),
]);

export function twitchExtensionProvider(id: string): TwitchExtensionProviderDescriptor | undefined {
  return twitchExtensionProviders.find((provider) => provider.id === id);
}
