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

export function mergePlatformState(
  destination: SchedulerState,
  source: SchedulerState,
  platform: Platform,
): SchedulerState {
  return {
    ...destination,
    sessions: {
      ...destination.sessions,
      [platform]: source.sessions[platform],
    },
    authHealth: {
      ...destination.authHealth,
      [platform]: source.authHealth[platform],
    },
    campaigns: {
      ...destination.campaigns,
      [platform]: source.campaigns[platform],
    },
    criticalHealth: mergeOptionalEntry(
      destination.criticalHealth,
      source.criticalHealth,
      platform,
    ),
    managedWatchTabs: mergeOptionalEntry(
      destination.managedWatchTabs,
      source.managedWatchTabs,
      platform,
    ),
    managedPageContextTabs: mergeOptionalEntry(
      destination.managedPageContextTabs,
      source.managedPageContextTabs,
      platform,
    ),
    manualWatch: mergeOptionalEntry(
      destination.manualWatch,
      source.manualWatch,
      platform,
    ),
    manualClosePause: mergeOptionalEntry(
      destination.manualClosePause,
      source.manualClosePause,
      platform,
    ),
    gamification: mergeOptionalEntry(
      destination.gamification,
      source.gamification,
      platform,
    ),
    campaignSearchBackoffs: mergeOptionalEntry(
      destination.campaignSearchBackoffs,
      source.campaignSearchBackoffs,
      platform,
    ),
    deadlineInfeasibleRewardIds: mergeOptionalEntry(
      destination.deadlineInfeasibleRewardIds,
      source.deadlineInfeasibleRewardIds,
      platform,
    ),
    lastTickAt: newestTimestamp(destination.lastTickAt, source.lastTickAt),
  };
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
