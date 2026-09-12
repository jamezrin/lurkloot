import type { TwitchExtensionProviderDescriptor } from "./types";

export const twitchExtensionProviders: readonly TwitchExtensionProviderDescriptor[] = Object.freeze([
  Object.freeze({
    id: "nopixel" as const,
    extensionId: "nstuq90nghenyqwqme61jgvmtp253a",
    origin: "https://nstuq90nghenyqwqme61jgvmtp253a.ext-twitch.tv/*" as const,
    discoveryCategoryIds: Object.freeze(["32982"]),
    minRefreshIntervalMs: 30_000,
  }),
  Object.freeze({
    id: "fortnite" as const,
    extensionId: "x2nfeda4neuzvsp2zdqfln9nwxc7tp",
    origin: "https://x2nfeda4neuzvsp2zdqfln9nwxc7tp.ext-twitch.tv/*" as const,
    discoveryCategoryIds: Object.freeze(["33214"]),
    minRefreshIntervalMs: 10_000,
  }),
]);

export function providerForOrigin(origin: string): TwitchExtensionProviderDescriptor | undefined {
  return twitchExtensionProviders.find((provider) => origin === provider.origin.slice(0, -2));
}
