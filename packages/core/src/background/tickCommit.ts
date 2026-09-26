import type { Platform, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import { isPlaybackTelemetryHealthy, preserveClaimedRewards } from "../core/scheduler";
import { jsonEquivalent, SCHEDULER_STATE_MERGE } from "./platformState";

// How a scheduler tick commits (#599). The tick decides from the state it read
// at its start (`before`) and runs its effects with no lock held, so by the time
// it commits another writer may have saved `latest`. The commit is a three-way
// merge of the two, per platform-owned key:
// - only the other writer changed it: its value stands, as if it ran after the
//   tick (the order the platform lock used to impose);
// - only the tick changed it: the tick's value;
// - both changed it: a conflict, unless a rule below reconciles the two.
// A conflict makes the tick's decision stale: it never commits, and only the
// facts its effects produced (claims made, tabs closed) are recorded.

// Written by the heartbeat lane, concurrently with ticks, since before #599.
// commitPlatformSnapshot keeps the current heartbeat authority, so the tick's
// commit never treats them as a conflict.
const HEARTBEAT_FIELDS = new Set<keyof WatchSession>([
  "lastHeartbeatAt",
  "lastHeartbeatOk",
  "heartbeatChecks",
  "tablessHeartbeat",
]);

// Written by playback telemetry for the managed watch tab.
const TELEMETRY_FIELDS = new Set<keyof WatchSession>(["playback", "playbackChecks"]);

export type TickRebase =
  | { readonly status: "current"; readonly state: SchedulerState }
  | { readonly status: "conflict"; readonly reason: string };

function changedFields(from: WatchSession, to: WatchSession): (keyof WatchSession)[] {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)] as (keyof WatchSession)[]);
  return [...keys].filter((key) => !jsonEquivalent(from[key], to[key]));
}

// The tick's session with playback telemetry that arrived meanwhile applied on
// top, the way recordPlaybackTelemetry would have applied it after the tick.
// Undefined when the other writer changed anything else in the session.
function rebaseSession(draft: WatchSession, before: WatchSession, latest: WatchSession): WatchSession | undefined {
  const others = changedFields(before, latest).filter((key) => !HEARTBEAT_FIELDS.has(key));
  if (others.some((key) => !TELEMETRY_FIELDS.has(key))) return undefined;
  if (others.length === 0) return draft;
  // Telemetry for a tab the tick no longer watches would not have been
  // recorded against the tick's session.
  const sameTab = draft.status === "watching"
    && draft.watchMode !== "tabless"
    && draft.tabId !== undefined
    && draft.tabId === latest.tabId;
  if (!sameTab || !latest.playback) return draft;
  return {
    ...draft,
    playback: latest.playback,
    playbackChecks: isPlaybackTelemetryHealthy(latest.playback) ? 0 : draft.playbackChecks,
  };
}

function newestCheck<T extends { lastCheckedAt?: string } | undefined>(left: T, right: T): T {
  if (!left?.lastCheckedAt) return right;
  if (!right?.lastCheckedAt) return left;
  return Date.parse(right.lastCheckedAt) > Date.parse(left.lastCheckedAt) ? right : left;
}

export function rebaseTickState(
  draft: SchedulerState,
  before: SchedulerState,
  latest: SchedulerState,
  platform: Platform,
): TickRebase {
  const result: Record<string, unknown> = { ...draft };
  for (const [key, kind] of Object.entries(SCHEDULER_STATE_MERGE) as [keyof SchedulerState, string][]) {
    if (kind !== "platform" && kind !== "optionalPlatform") continue;
    const field = key as "sessions";
    const draftValue = (draft[field] as Partial<Record<Platform, unknown>> | undefined)?.[platform];
    const beforeValue = (before[field] as Partial<Record<Platform, unknown>> | undefined)?.[platform];
    const latestValue = (latest[field] as Partial<Record<Platform, unknown>> | undefined)?.[platform];
    const byOthers = !jsonEquivalent(beforeValue, latestValue);
    if (!byOthers) continue;
    const byTick = !jsonEquivalent(beforeValue, draftValue);
    let value: unknown;
    if (!byTick) {
      value = latestValue;
    } else if (key === "sessions") {
      value = rebaseSession(draft.sessions[platform], before.sessions[platform], latest.sessions[platform]);
      if (value === undefined) return { status: "conflict", reason: "the watch session changed" };
    } else if (key === "campaigns") {
      // Both refreshed the inventory; keep the tick's, with the other writer's
      // claims carried over.
      value = preserveClaimedRewards(draft.campaigns[platform], latest.campaigns[platform]);
    } else if (key === "gamification") {
      value = newestCheck(draft.gamification?.[platform], latest.gamification?.[platform]);
    } else if (key === "managedPageContextTabs") {
      // commitPlatformSnapshot takes the live page-context registry instead.
      value = draftValue;
    } else {
      return { status: "conflict", reason: `${key} changed` };
    }
    const record = { ...(result[key] as Partial<Record<Platform, unknown>> | undefined) };
    if (value === undefined) delete record[platform];
    else record[platform] = value;
    result[key] = record;
  }
  return { status: "current", state: result as unknown as SchedulerState };
}

// What a tick whose decision went stale still records: rewards it claimed, and
// managed watch tabs it closed. A tab it opened is returned for closing, since
// nothing will track it.
export function tickEffectFacts(
  draft: SchedulerState,
  before: SchedulerState,
  latest: SchedulerState,
  platform: Platform,
): { state: SchedulerState; openedTab?: WatchSession } {
  const state: SchedulerState = {
    ...latest,
    campaigns: {
      ...latest.campaigns,
      [platform]: preserveClaimedRewards(latest.campaigns[platform], draft.campaigns[platform]),
    },
  };
  const previousTab = before.managedWatchTabs?.[platform];
  const draftTab = draft.managedWatchTabs?.[platform];
  const latestTab = latest.managedWatchTabs?.[platform];
  if (previousTab && draftTab?.tabId !== previousTab.tabId && latestTab?.tabId === previousTab.tabId) {
    const managedWatchTabs = { ...latest.managedWatchTabs };
    delete managedWatchTabs[platform];
    state.managedWatchTabs = managedWatchTabs;
  }
  const opened = draftTab && draftTab.tabId !== previousTab?.tabId && draftTab.tabId !== latestTab?.tabId;
  return {
    state,
    ...(opened
      ? { openedTab: { ...draft.sessions[platform], status: "watching" as const, tabId: draftTab.tabId, tabManagedByExtension: true } }
      : {}),
  };
}
