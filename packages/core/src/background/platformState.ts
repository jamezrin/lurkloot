import type { Platform, SchedulerState } from "@lurkloot/shared/models";

function mergeOptionalEntry<T>(
  destination: Partial<Record<Platform, T>> | undefined,
  source: Partial<Record<Platform, T>> | undefined,
  platform: Platform,
): Partial<Record<Platform, T>> {
  const merged = { ...destination };
  const value = source?.[platform];
  if (value === undefined) delete merged[platform];
  else merged[platform] = value;
  return merged;
}

function newestTimestamp(
  destination: string | undefined,
  source: string | undefined,
): string | undefined {
  if (!destination) return source;
  if (!source) return destination;
  const destinationTime = Date.parse(destination);
  const sourceTime = Date.parse(source);
  if (!Number.isFinite(destinationTime)) return source;
  if (!Number.isFinite(sourceTime)) return destination;
  return sourceTime > destinationTime ? source : destination;
}

// How each SchedulerState key is merged when one platform commits. The map is
// exhaustive, so adding a key to SchedulerState fails to compile until it is
// classified here:
// - "platform": a record keyed by platform; the committing platform's entry
//   replaces the stored one, and the other platform's entry is kept.
// - "optionalPlatform": the same, except that an entry missing from the source
//   deletes the stored one.
// - "newestTimestamp": the newer of the two ISO timestamps wins.
// - "global": not owned by either platform, so the stored value is kept. Its
//   writers save it with a whole-state commit.
export const SCHEDULER_STATE_MERGE = {
  sessions: "platform",
  authHealth: "platform",
  campaigns: "platform",
  criticalHealth: "optionalPlatform",
  managedWatchTabs: "optionalPlatform",
  managedPageContextTabs: "optionalPlatform",
  manualWatch: "optionalPlatform",
  manualWatchTabs: "optionalPlatform",
  manualClosePause: "optionalPlatform",
  gamification: "optionalPlatform",
  campaignSearchBackoffs: "optionalPlatform",
  deadlineInfeasibleRewardIds: "optionalPlatform",
  lastTickAt: "newestTimestamp",
  twitchExtensions: "global",
  installedAt: "global",
} as const satisfies Record<keyof SchedulerState, "platform" | "optionalPlatform" | "newestTimestamp" | "global">;

export type SchedulerStateMergeKind = (typeof SCHEDULER_STATE_MERGE)[keyof SchedulerState];

type KeysOfKind<K extends SchedulerStateMergeKind> = {
  [Key in keyof SchedulerState]-?: (typeof SCHEDULER_STATE_MERGE)[Key] extends K ? Key : never;
}[keyof SchedulerState];

const MERGE_KEYS = Object.keys(SCHEDULER_STATE_MERGE) as (keyof SchedulerState)[];

export function mergePlatformState(
  destination: SchedulerState,
  source: SchedulerState,
  platform: Platform,
): SchedulerState {
  const merged: Record<string, unknown> = { ...destination };
  for (const key of MERGE_KEYS) {
    const kind = SCHEDULER_STATE_MERGE[key];
    if (kind === "platform") {
      const field = key as KeysOfKind<"platform">;
      merged[field] = { ...destination[field], [platform]: source[field][platform] };
    } else if (kind === "optionalPlatform") {
      const field = key as KeysOfKind<"optionalPlatform">;
      merged[field] = mergeOptionalEntry<unknown>(destination[field], source[field], platform);
    } else if (kind === "newestTimestamp") {
      const field = key as KeysOfKind<"newestTimestamp">;
      merged[field] = newestTimestamp(destination[field], source[field]);
    }
  }
  return merged as unknown as SchedulerState;
}

// Structural comparison for the JSON-shaped scheduler state. Every field that
// reaches storage is JSON-serializable — the extension writes it to
// storage.local, the CLI to a file — so a plain structural walk is exact here:
// there are no Dates, Maps or class instances to miscompare.
//
// Keys whose value is undefined are ignored on both sides. That is not a
// convenience: a round trip through storage drops them, so the freshly built
// state (which sets `channel: undefined` and friends explicitly) must compare
// equal to the stored state that simply lacks those keys.
function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => jsonEquivalent(leftRecord[key], rightRecord[key]));
}

// True when two scheduler states differ only by `lastTickAt`, which every tick
// restamps whether or not it decided anything. It is display-only (the popup's
// last-check line), so it must not by itself justify a storage write.
export function schedulerStateEquivalent(left: SchedulerState, right: SchedulerState): boolean {
  const { lastTickAt: _leftTickAt, ...leftRest } = left;
  const { lastTickAt: _rightTickAt, ...rightRest } = right;
  return jsonEquivalent(leftRest, rightRest);
}
