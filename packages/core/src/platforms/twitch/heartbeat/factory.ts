import type { EventEmitter } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { TwitchHeartbeatId, TwitchIdentity } from "../../../compatibility/types";
import type { TwitchGqlTransport } from "../index";
import { createTwitchGqlV1HeartbeatStrategy } from "./gql-v1";
import { createSpadeHeartbeat } from "./spade";
import { createTrowelHeartbeat } from "./trowel";
import type {
  TwitchHeartbeatFetchText,
  TwitchHeartbeatPost,
  TwitchHeartbeatStrategy,
} from "./types";

export interface TwitchHeartbeatFactoryOptions {
  gql: TwitchGqlTransport;
  emit: EventEmitter;
  log: (level: LogLevel, message: string) => void;
  identity: TwitchIdentity;
  fetchText?: TwitchHeartbeatFetchText;
  post?: TwitchHeartbeatPost;
}

function requireOption<T>(value: T | undefined, capabilityId: TwitchHeartbeatId, name: string): T {
  if (value === undefined) throw new Error(`${capabilityId} requires a ${name} transport`);
  return value;
}

export function createTwitchHeartbeat(
  capabilityId: TwitchHeartbeatId,
  options: TwitchHeartbeatFactoryOptions,
): TwitchHeartbeatStrategy {
  switch (capabilityId) {
    case "twitch-heartbeat-gql-v1":
      return createTwitchGqlV1HeartbeatStrategy(options.gql, options.emit, options.log);
    case "twitch-heartbeat-spade-v1":
      return createSpadeHeartbeat({
        fetchText: requireOption(options.fetchText, capabilityId, "page fetch"),
        post: requireOption(options.post, capabilityId, "beacon request"),
      });
    case "twitch-heartbeat-trowel-v1":
      return createTrowelHeartbeat({
        identity: options.identity,
        post: requireOption(options.post, capabilityId, "request"),
      });
    default: {
      const exhaustive: never = capabilityId;
      throw new Error(`Unsupported Twitch heartbeat capability: ${String(exhaustive)}`);
    }
  }
}
