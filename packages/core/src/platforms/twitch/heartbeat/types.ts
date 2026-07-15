import type { ChannelCandidate } from "@lurkloot/shared/models";
import type { HeartbeatResult } from "../../../core/tablessWatch";

export interface TwitchHeartbeatContext {
  channel: ChannelCandidate;
  broadcastId: string;
  channelId: string;
  userId: string;
  gameId?: string;
  gameName?: string;
}

export interface TwitchHeartbeatStrategy {
  readonly id: string;
  tick(context: TwitchHeartbeatContext): Promise<HeartbeatResult>;
}

export type TwitchHeartbeatFetchText = (url: string, init?: RequestInit) => Promise<string>;

export interface TwitchHeartbeatResponse {
  status: number;
}

export type TwitchHeartbeatPost = (
  url: string,
  init: RequestInit,
) => Promise<TwitchHeartbeatResponse>;
