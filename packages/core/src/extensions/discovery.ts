import type { ChannelCandidate } from "@lurkloot/shared/models";
import type { TwitchExtensionProviderDescriptor } from "./types";
const directoryQuery = `query ExtensionDirectory($gameID: ID!, $limit: Int!) {
  game(id: $gameID) { streams(first: $limit) { edges { node { id viewersCount broadcaster { id login displayName } } } } }
}`;
const installationsQuery = `query ExtensionInstallations($logins: [String!]!) {
  users(logins: $logins) { id login channel { selfInstalledExtensions { installation { extension { id } activationConfig { state } } } } }
}`;
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value.slice(0, 25) : []; }
export async function discoverTwitchExtensionChannels(options: {
  provider: TwitchExtensionProviderDescriptor;
  query(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  excludedChannels: readonly string[];
  signal?: AbortSignal;
}): Promise<ChannelCandidate[]> {
  const excluded = new Set(options.excludedChannels.map(value => value.toLowerCase()));
  const candidates = new Map<string, ChannelCandidate>();
  for (const categoryId of options.provider.discoveryCategoryIds.slice(0, 2)) {
    options.signal?.throwIfAborted();
    const envelope = object(await options.query(directoryQuery, { gameID: categoryId, limit: 25 }, options.signal));
    if (envelope?.errors || envelope?.error) throw new Error("Twitch Extension directory unavailable.");
    const edges = object(object(object(envelope?.data)?.game)?.streams)?.edges;
    if (!Array.isArray(edges)) throw new Error("Twitch Extension directory is incompatible.");
    for (const raw of array(edges)) {
      const node = object(object(raw)?.node), broadcaster = object(node?.broadcaster);
      if (typeof broadcaster?.id !== "string" || !/^\d{1,20}$/.test(broadcaster.id) || typeof broadcaster.login !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(broadcaster.login)) continue;
      const username = broadcaster.login.toLowerCase();
      if (excluded.has(username)) continue;
      candidates.set(username, { platform: "twitch", username, channelId: broadcaster.id, categoryId, ...(typeof node?.id === "string" && /^\d{1,20}$/.test(node.id) ? { broadcastId: node.id } : {}), url: `https://www.twitch.tv/${username}`, live: true });
      if (candidates.size >= 25) break;
    }
  }
  if (!candidates.size) return [];
  options.signal?.throwIfAborted();
  const envelope = object(await options.query(installationsQuery, { logins: [...candidates.keys()] }, options.signal));
  if (envelope?.errors || envelope?.error) throw new Error("Twitch Extension installation discovery unavailable.");
  const users = object(envelope?.data)?.users;
  if (!Array.isArray(users)) throw new Error("Twitch Extension installation discovery is incompatible.");
  const enabled = new Set<string>();
  for (const raw of array(users)) {
    const user = object(raw);
    if (typeof user?.login !== "string") continue;
    const username = user.login.toLowerCase(), candidate = candidates.get(username);
    if (!candidate || candidate.channelId !== user.id) continue;
    for (const entry of array(object(user.channel)?.selfInstalledExtensions)) {
      const installation = object(object(entry)?.installation), extensionId = object(installation?.extension)?.id;
      if (typeof extensionId === "string" && extensionId.split(":")[0] === options.provider.extensionId && object(installation?.activationConfig)?.state === "ACTIVE") enabled.add(username);
    }
  }
  options.signal?.throwIfAborted();
  return [...candidates.values()].filter(candidate => enabled.has(candidate.username));
}
