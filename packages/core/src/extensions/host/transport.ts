import { withHeartbeatTimeout } from "../../platforms/twitch/heartbeat";
import type { SessionSource } from "./session";

export interface TwitchExtensionSessionSourceOptions {
  clientId: string;
  hasSession(): Promise<boolean>;
  fetchJson(url: string, init: RequestInit): Promise<unknown>;
  now?: () => number;
}

// The host supplies the Client-ID for its authenticated Twitch transport.
// Only that transport attaches credentials.
export function createTwitchExtensionSessionSource(
  options: TwitchExtensionSessionSourceOptions,
): SessionSource {
  return {
    hasSession: options.hasSession,
    now: options.now ?? Date.now,
    query: (query, variables, parent) =>
      withHeartbeatTimeout(
        (signal) =>
          options.fetchJson("https://gql.twitch.tv/gql", {
            method: "POST",
            headers: {
              "Client-ID": options.clientId,
              "Content-Type": "text/plain; charset=UTF-8",
            },
            body: JSON.stringify({
              operationName:
                query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
                ?? "CoordinatorExtensionsForChannel",
              query,
              variables,
            }),
            signal,
          }),
        parent,
      ),
  };
}
