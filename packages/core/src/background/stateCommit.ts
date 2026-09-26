import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { currentManagedPageContextTabs, currentManagedPageContextTabsRevision } from "../core/tabs";
import { heartbeatContextKey, validTablessHeartbeatCadence } from "../core/heartbeatCadence";
import { mergePlatformState, schedulerStateEquivalent } from "./platformState";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import type { BackgroundControllerDeps, ControllerCalls } from "./types";

// Platform locks and the scheduler-state commit.
export function createStateCommit<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { commitSlice }: Pick<ControllerSlices<S>, "commitSlice">,
  calls: Pick<ControllerCalls<S>, "reportBestEffort">,
): Pick<ControllerCalls<S>,
  | "withPlatformLock"
  | "withStateLock"
  | "withStateCommit"
  | "persistAndReport"
  | "persistPlatformAndReport"
  | "persistPlatformState"
  | "saveOperationalState"
  | "saveOperationalStateDirect"
> {
  const { reportBestEffort } = lateBound(calls);

  function withPlatformLock<T>(platform: Platform, operation: () => Promise<T>): Promise<T> {
    const run = commitSlice.platformMutations[platform].then(operation, operation);
    commitSlice.platformMutations[platform] = run.then(() => undefined, () => undefined);
    return run;
  }

  function withStateLock<T>(
    operation: () => Promise<T>,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<T> {
    const targets = PLATFORMS.filter((platform) => platforms.includes(platform));
    const acquire = (index: number): Promise<T> => {
      const platform = targets[index];
      if (!platform) return operation();
      return withPlatformLock(platform, () => acquire(index + 1));
    };
    return acquire(0);
  }

  function withStateCommit<T>(operation: () => Promise<T>): Promise<T> {
    const run = commitSlice.stateCommit.then(operation, operation);
    commitSlice.stateCommit = run.then(() => undefined, () => undefined);
    return run;
  }

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
    return withStateCommit(async () => {
      // The registry can change while storage I/O is in flight (for example a
      // page-context fallback reported by the heartbeat watcher). Retry the
      // short merge when its revision moved, so the last write is a compare-
      // and-swap style recapture rather than a stale snapshot overwrite.
      while (true) {
        const latest = await deps.loadState();
        const currentSession = latest.sessions[platform];
        const nextSession = state.sessions[platform];
        const currentCadence = validTablessHeartbeatCadence(currentSession);
        const nextCadence = validTablessHeartbeatCadence(nextSession);
        const retainsHeartbeatAuthority = currentCadence !== undefined
          && nextCadence !== undefined
          && currentCadence.generation === nextCadence.generation
          && currentCadence.contextKey === nextCadence.contextKey
          && heartbeatContextKey(currentSession) === currentCadence.contextKey
          && heartbeatContextKey(nextSession) === nextCadence.contextKey;
        const pageContextRevision = currentManagedPageContextTabsRevision();
        const livePageContexts = currentManagedPageContextTabs();
        const mergeSourcePageContexts = { ...state.managedPageContextTabs };
        const livePageContext = livePageContexts[platform];
        if (livePageContext) mergeSourcePageContexts[platform] = livePageContext;
        else delete mergeSourcePageContexts[platform];
        const stateForMerge = {
          ...state,
          managedPageContextTabs: mergeSourcePageContexts,
        };
        const mergeSource = retainsHeartbeatAuthority
          ? {
              ...stateForMerge,
              sessions: {
                ...state.sessions,
                [platform]: {
                  ...nextSession,
                  lastHeartbeatAt: currentSession.lastHeartbeatAt,
                  lastHeartbeatOk: currentSession.lastHeartbeatOk,
                  heartbeatChecks: currentSession.heartbeatChecks,
                  tablessHeartbeat: currentCadence,
                },
              },
            }
          : stateForMerge;
        if (isCurrent?.() === false) return false;
        const merged = mergePlatformState(latest, mergeSource, platform);
        // A tick that decided nothing still restamps lastTickAt, so an
        // unguarded write churns storage every poll interval forever. The
        // disabled platform is the clearest case: its tick reaches the
        // scheduler's disabled branch and rebuilds the very same session on
        // every pass, and both tick alarms keep firing whether or not the
        // platform is enabled. Skip the write and leave lastTickAt where it
        // was — storage already holds this state, so callers must still treat
        // it as persisted, and `latest` (not `merged`) is what they observe.
        const unchanged = schedulerStateEquivalent(latest, merged);
        if (!unchanged) await saveOperationalStateDirect(merged);
        if (currentManagedPageContextTabsRevision() === pageContextRevision) {
          onPersisted?.(unchanged ? latest : merged);
          return true;
        }
      }
    });
  }

  async function saveOperationalState(state: SchedulerState): Promise<void> {
    await withStateCommit(() => saveOperationalStateDirect(state));
  }

  async function saveOperationalStateDirect(state: SchedulerState): Promise<void> {
    const { events: _legacyEvents, ...operationalState } = state as SchedulerState & { events?: unknown };
    await deps.saveState(operationalState);
  }

  return {
    withPlatformLock,
    withStateLock,
    withStateCommit,
    persistAndReport,
    persistPlatformAndReport,
    persistPlatformState,
    saveOperationalState,
    saveOperationalStateDirect,
  };
}
