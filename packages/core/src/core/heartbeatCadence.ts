import type { WatchSession } from "@lurkloot/shared/models";

export const HEARTBEAT_INTERVAL_MS = 60_000;

export function nextHeartbeatDueAt(previousDueAt: number, attemptAt: number): number {
  const elapsed = Math.max(0, attemptAt - previousDueAt);
  return previousDueAt
    + (Math.floor(elapsed / HEARTBEAT_INTERVAL_MS) + 1) * HEARTBEAT_INTERVAL_MS;
}

export function heartbeatContextKey(session: WatchSession): string | undefined {
  const channel = session.channel;
  if (session.watchMode !== "tabless" || !channel || !session.campaignId || !session.rewardId) return undefined;
  return JSON.stringify([
    session.platform,
    channel.url,
    channel.username,
    channel.broadcastId ?? "",
    channel.channelId ?? "",
    channel.categoryId ?? "",
    session.campaignId,
    session.rewardId,
  ]);
}
