import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { lateBound } from "./context";
import type { StateTransaction } from "./stateTransaction";
import type { ControllerCalls } from "./types";

// Locks, scheduler-state commits and the operational events published after
// them. The locks and commits belong to the state transaction
// (stateTransaction.ts); this module publishes a commit's events only once the
// commit is accepted, or found already stored, and never for a stale one.
export function createStateCommit<S extends EngineSettings>(
  transaction: StateTransaction<S>,
  calls: Pick<ControllerCalls<S>, "reportBestEffort">,
): Pick<ControllerCalls<S>,
  | "withSettingsLock"
  | "withPlatformLock"
  | "withStateLock"
  | "trackHeartbeatLane"
  | "readState"
  | "stateRevision"
  | "readSettingsAndState"
  | "commitState"
  | "persistAndReport"
  | "persistPlatformAndReport"
  | "persistPlatformState"
  | "saveOperationalState"
> {
  const { reportBestEffort } = lateBound(calls);

  async function persistAndReport(state: SchedulerState, events: readonly EngineEvent[] = []): Promise<void> {
    await saveOperationalState(state);
    await reportBestEffort(events);
  }

  async function persistPlatformAndReport(
    platform: Platform,
    state: SchedulerState,
    events: readonly EngineEvent[] = [],
    isCurrent?: () => boolean,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<boolean> {
    const persisted = await persistPlatformState(platform, state, isCurrent, onPersisted);
    if (!persisted) return false;
    await reportBestEffort(events);
    return true;
  }

  async function persistPlatformState(
    platform: Platform,
    state: SchedulerState,
    isCurrent?: () => boolean,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<boolean> {
    const result = await transaction.commitPlatformSnapshot(platform, state, isCurrent, onPersisted);
    return result.status !== "stale";
  }

  async function saveOperationalState(state: SchedulerState): Promise<void> {
    await transaction.commitWholeState(state);
  }

  return {
    withSettingsLock: transaction.withSettingsLock,
    withPlatformLock: transaction.withPlatformLock,
    withStateLock: transaction.withStateLock,
    trackHeartbeatLane: transaction.trackHeartbeatLane,
    readState: transaction.readState,
    stateRevision: transaction.stateRevision,
    readSettingsAndState: transaction.readSettingsAndState,
    commitState: transaction.commit,
    persistAndReport,
    persistPlatformAndReport,
    persistPlatformState,
    saveOperationalState,
  };
}
