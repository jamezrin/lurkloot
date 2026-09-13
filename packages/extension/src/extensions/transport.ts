import { withHeartbeatTimeout } from "@lurkloot/core/twitch/heartbeat";
import type { SessionSource } from "./session";

// The existing browser fetcher reads auth-token locally and adds Twitch's
// explicit OAuth header. This source never exports cookies or credentials and
// needs no page context/integrity acquisition tab for this session read.
export function createTwitchExtensionSessionSource(options: {
  hasSession(): Promise<boolean>;
  fetchJson(url: string, init: RequestInit): Promise<unknown>;
  now?: () => number;
}): SessionSource {
  return {
    hasSession: options.hasSession,
    now: options.now ?? Date.now,
    query: (query, variables, parent) => withHeartbeatTimeout((signal) => options.fetchJson("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "text/plain; charset=UTF-8" },
      body: JSON.stringify({ operationName: query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? "CoordinatorExtensionsForChannel", query, variables }),
      signal,
    }), parent),
  };
}
