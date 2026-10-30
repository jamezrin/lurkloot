import type { ActivityEvent } from "./events";
import type { Platform } from "./models";
import type { RewardCountKey, TalliedKind } from "./rewardEvents";

export interface TallyEntry {
  kind: TalliedKind;
  subject: { id: string; login?: string; name?: string; imageUrl?: string };
  total: number;
  // Per reason code: how many gains and how much they added up to.
  breakdown: Record<string, { count: number; amount: number }>;
}

export interface FarmingSessionSummary {
  id: string;
  platform: Platform;
  startedAt: string;
  endedAt?: string;
  tallies: Record<string, TallyEntry>;
  rewardCounts: Partial<Record<RewardCountKey, number>>;
}

// Tab open/close is plumbing: it stays in the engine's event contract (the
// churn breaker reads it) but is shown only in diagnostics.
const NON_TIMELINE_CODES: ReadonlySet<string> = new Set([
  "page_context_opened",
  "page_context_closed",
]);

export function isActivityTimelineEvent(event: { category: string; code?: string }): boolean {
  return event.category === "activity" && !NON_TIMELINE_CODES.has(event.code ?? "");
}

export function rewardCountKey(event: ActivityEvent): RewardCountKey | undefined {
  if (event.code === "reward_claimed") return "drop";
  if (event.code === "reward_obtained") return event.data.kind;
  return undefined;
}

export function tallyKey(event: ActivityEvent): string | undefined {
  if (event.code === "points_earned") return `channel_points:${event.data.channelId}`;
  return undefined;
}
