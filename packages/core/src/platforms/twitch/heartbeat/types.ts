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
  // A poll between health commits, with the context of the last tick. Present
  // only on a strategy that has work to do between them (HLS). Resolves
  // undefined when there is nothing to do yet, e.g. while a failed playback
  // token request is waiting to be retried.
  sustain?(context: TwitchHeartbeatContext): Promise<HeartbeatResult | undefined>;
  // Drop in-flight playlist work and cached segment URLs. The watcher calls
  // this on stop and when the channel changes.
  reset?(): void;
}

export interface TwitchHeartbeatExchangeResult {
  status: number;
  body: string;
  // The URL this response is for. Required on a completed response: a missing
  // value is rejected, because falling back to the request URL hides a hop
  // the transport followed but did not report. Never logged.
  url?: string;
  // Redirect target when the transport was told not to follow it. The
  // strategy checks the host before requesting it. Never logged.
  location?: string;
}

// GET returns the body. HEAD leaves it empty. HTTP statuses are returned, not
// thrown, so a 401 can refresh a signed playlist URL. Network failures throw
// a message that names only the hostname.
export type TwitchHeartbeatExchange = (
  url: string,
  init: RequestInit,
) => Promise<TwitchHeartbeatExchangeResult>;

export type TwitchHeartbeatFetchText = (url: string, init?: RequestInit) => Promise<string>;

export interface TwitchHeartbeatResponse {
  status: number;
}

export type TwitchHeartbeatPost = (
  url: string,
  init: RequestInit,
) => Promise<TwitchHeartbeatResponse>;
