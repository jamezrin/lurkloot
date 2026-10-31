import type { ActivityEvent, StoredEngineEvent } from "./events";
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

// Folds one stored event into its session's summary. Pure: the host applies it
// inside the transaction that stores the event, so concurrent writers each fold
// onto the latest record. An event outside any session leaves it unchanged.
export function foldSessionEvent(
  summary: FarmingSessionSummary | undefined,
  event: StoredEngineEvent,
): FarmingSessionSummary | undefined {
  if (event.category !== "activity" || typeof event.sessionId !== "string" || !event.platform)
    return summary;
  const base: FarmingSessionSummary = summary ?? {
    id: event.sessionId,
    platform: event.platform,
    startedAt: event.code === "session_started" ? event.data.startedAt : event.at,
    tallies: {},
    rewardCounts: {},
  };
  if (event.code === "session_started") {
    return event.data.startedAt < base.startedAt
      ? { ...base, startedAt: event.data.startedAt }
      : base;
  }
  if (event.code === "session_ended") return { ...base, endedAt: event.data.endedAt };
  const key = tallyKey(event);
  if (key !== undefined && event.code === "points_earned") {
    const previous = base.tallies[key];
    const reason = previous?.breakdown[event.data.reason] ?? { count: 0, amount: 0 };
    const subject = {
      ...(previous?.subject ?? { id: event.data.channelId }),
      ...(event.data.channelLogin ? { login: event.data.channelLogin } : {}),
      ...(event.data.channelDisplayName ? { name: event.data.channelDisplayName } : {}),
      ...(event.data.channelImageUrl ? { imageUrl: event.data.channelImageUrl } : {}),
    };
    return {
      ...base,
      tallies: {
        ...base.tallies,
        [key]: {
          kind: "channel_points",
          subject,
          total: (previous?.total ?? 0) + event.data.amount,
          breakdown: {
            ...previous?.breakdown,
            [event.data.reason]: {
              count: reason.count + 1,
              amount: reason.amount + event.data.amount,
            },
          },
        },
      },
    };
  }
  const counted = rewardCountKey(event);
  if (counted !== undefined) {
    return {
      ...base,
      rewardCounts: { ...base.rewardCounts, [counted]: (base.rewardCounts[counted] ?? 0) + 1 },
    };
  }
  return summary === undefined ? base : summary;
}
