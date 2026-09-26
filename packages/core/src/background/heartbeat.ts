import type { EngineSettings, Platform, SchedulerState, TablessHeartbeatCadence, WatchSession } from "@lurkloot/shared/models";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import { isFarmingActive } from "@lurkloot/shared/settings";
import {
  currentManagedPageContextTabs,
  currentManagedPageContextTabsRevision,
  hydrateManagedPageContextTabs,
} from "../core/tabs";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TablessWatchController, WatchContext } from "../core/tablessWatch";
import {
  heartbeatContextKey,
  HEARTBEAT_INTERVAL_MS,
  nextHeartbeatDueAt,
  nextHeartbeatGeneration,
  validHeartbeatGeneration,
  validTablessHeartbeatCadence,
} from "../core/heartbeatCadence";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError } from "./helpers";
import type {
  BackgroundControllerDeps,
  CommittedHeartbeatContext,
  ControllerCalls,
  HeartbeatAttempt,
  HeartbeatAttemptKind,
  HeartbeatContextPublication,
  HeartbeatContextPublicationDecision,
  HeartbeatFallback,
  HeartbeatLane,
  HeartbeatPublicationLease,
  HeartbeatRecoveryCommit,
  HeartbeatResultCommit,
  HeartbeatWatcherRemoval,
  HeartbeatWatcherRemovalDecision,
} from "./types";

// How recently a heartbeat must have landed for the post-claim handoff to treat
// the channel as already covered. Half the fixed one-minute alarm period: long
// enough to suppress a genuine double-send, short enough that a real handoff
// still transmits.
const RECENT_HEARTBEAT_MS = 30_000;

// Tabless watchers, heartbeat lanes and heartbeat commits.
export function createHeartbeats<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { heartbeatSlice, tickSlice, lifecycleSlice }: Pick<ControllerSlices<S>, "heartbeatSlice" | "tickSlice" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "createSelectedAdapters"
    | "diagnosticEvent"
    | "invalidateSelection"
    | "reportBestEffort"
    | "saveOperationalStateDirect"
    | "tick"
    | "withEventCollector"
    | "withStateCommit"
  >,
): Pick<ControllerCalls<S>,
  | "releaseHeartbeatPublicationLease"
  | "cancelHeartbeatPublicationLeases"
  | "reconcileTablessWatchers"
  | "clearHeartbeatOwnership"
  | "clearHeartbeatOwnershipInBackground"
  | "runWatchHeartbeat"
  | "requestPlatformHeartbeat"
> {
  const {
    createSelectedAdapters,
    diagnosticEvent,
    invalidateSelection,
    reportBestEffort,
    saveOperationalStateDirect,
    tick,
    withEventCollector,
    withStateCommit,
  } = lateBound(calls);

  function withHeartbeatLane<T>(
    platform: Platform,
    operation: (lane: HeartbeatLane) => Promise<T>,
  ): Promise<T> {
    const lane = heartbeatSlice.heartbeatLanes[platform];
    const run = lane.mutation.then(() => operation(lane), () => operation(lane));
    lane.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  function newHeartbeatPublicationLease(): HeartbeatPublicationLease {
    let signalAdmission!: () => void;
    let settleLease!: () => void;
    let admissionSignalled = false;
    const admissionReady = new Promise<void>((resolve) => {
      signalAdmission = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      settleLease = resolve;
    });
    const signalAdmissionOnce = () => {
      if (admissionSignalled) return;
      admissionSignalled = true;
      signalAdmission();
    };
    const lease: HeartbeatPublicationLease = {
      admissionReady,
      markPublished: (context) => {
        lease.published = context;
        signalAdmissionOnce();
      },
      settled,
      settle: () => {
        signalAdmissionOnce();
        settleLease();
      },
    };
    return lease;
  }

  async function releaseHeartbeatPublicationLease(
    platform: Platform,
    lease: HeartbeatPublicationLease,
  ): Promise<void> {
    await withHeartbeatLane(platform, async (lane) => {
      if (lane.publicationLease !== lease) return;
      lane.publicationLease = undefined;
      lease.settle();
    });
  }

  async function cancelHeartbeatPublicationLeases(
    platforms: readonly Platform[],
  ): Promise<void> {
    await Promise.all(platforms.map((platform) => withHeartbeatLane(platform, async (lane) => {
      const lease = lane.publicationLease;
      if (!lease) return;
      lane.publicationLease = undefined;
      lease.settle();
    })));
  }

  function frozenHeartbeatSession(
    session: WatchSession,
    cadence: TablessHeartbeatCadence,
  ): Readonly<WatchSession> {
    return Object.freeze({
      ...session,
      channel: session.channel ? Object.freeze({ ...session.channel }) : undefined,
      tablessHeartbeat: Object.freeze({ ...cadence }),
    });
  }

  async function commitHeartbeatContext(
    platform: Platform,
    session: WatchSession,
    watcher: TablessWatchController,
    expectedRevision: number,
    publicationLease?: HeartbeatPublicationLease,
  ): Promise<HeartbeatContextPublication> {
    const contextKey = heartbeatContextKey(session);
    while (true) {
      const decision: HeartbeatContextPublicationDecision = await withHeartbeatLane(
        platform,
        async (lane) => {
          if (lane.revision !== expectedRevision) {
            return { accepted: false, committed: lane.committed };
          }
          if (lane.publicationLease && lane.publicationLease !== publicationLease) {
            return { waitFor: lane.publicationLease.settled };
          }
          if (lane.recoveryCommit) return { waitFor: lane.recoveryCommit.settled };
          if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };
          const previous = lane.committed;
          if (!contextKey) {
            lane.committed = undefined;
            heartbeatSlice.tablessWatchers.set(platform, watcher);
            lane.revision += 1;
            return {
              accepted: true,
              replaced: previous?.watcher === watcher ? undefined : previous?.watcher,
            };
          }

          const persistedMetadata = session.tablessHeartbeat;
          const persisted = validTablessHeartbeatCadence(session);
          const previousCadence = previous?.contextKey === contextKey
            ? previous.session.tablessHeartbeat
            : undefined;
          const mayRestorePersisted = persisted !== undefined
            && (lane.generationHighWater === undefined
              || persisted.generation > lane.generationHighWater);
          const generation = previousCadence?.generation
            ?? (mayRestorePersisted
              ? persisted.generation
              : nextHeartbeatGeneration(
                  lane.generationHighWater,
                  previous?.generation,
                  persistedMetadata?.generation,
                ));
          const cadence: TablessHeartbeatCadence = Object.freeze(previousCadence
            ? { ...previousCadence }
            : mayRestorePersisted
              ? { ...persisted }
              : {
                  generation,
                  contextKey,
                  nextDueAt: persisted
                    ? persisted.nextDueAt
                    : new Date(Date.now() + HEARTBEAT_INTERVAL_MS).toISOString(),
                });
          const committed = Object.freeze({
            generation,
            contextKey,
            session: frozenHeartbeatSession(session, cadence),
            watcher,
          });
          lane.generationHighWater = Math.max(lane.generationHighWater ?? 0, generation);
          lane.committed = committed;
          heartbeatSlice.tablessWatchers.set(platform, watcher);
          if (publicationLease && lane.publicationLease === publicationLease) {
            publicationLease.markPublished(committed);
          }
          lane.revision += 1;
          return {
            accepted: true,
            cadence,
            committed,
            replaced: previous?.watcher === watcher ? undefined : previous?.watcher,
          };
        },
      );
      if ("waitFor" in decision) {
        await decision.waitFor;
        continue;
      }
      return decision;
    }
  }

  async function takeHeartbeatWatcher(
    platform: Platform,
    expectedRevision?: number,
  ): Promise<HeartbeatWatcherRemoval> {
    while (true) {
      const decision: HeartbeatWatcherRemovalDecision = await withHeartbeatLane(
        platform,
        async (lane) => {
          if (expectedRevision !== undefined && lane.revision !== expectedRevision) {
            return { accepted: false };
          }
          if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };
          const watcher = lane.committed?.watcher ?? heartbeatSlice.tablessWatchers.get(platform);
          lane.committed = undefined;
          heartbeatSlice.tablessWatchers.delete(platform);
          lane.revision += 1;
          return { accepted: true, watcher };
        },
      );
      if ("waitFor" in decision) {
        await decision.waitFor;
        continue;
      }
      return decision;
    }
  }

  function tablessWatchContext(): WatchContext {
    // The Twitch watcher resolves the viewer id itself; nothing extra needed yet.
    return {};
  }

  // Aligns the live tabless watchers with the scheduler's session state: starts
  // or switches a watcher for each platform farming tablessly, and stops the
  // rest (idle, paused, fell back to a tab, or watching with a real tab).
  async function reconcileTablessWatchers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: Platform[],
  ): Promise<Array<readonly [Platform, HeartbeatPublicationLease]>> {
    const targets = platforms ?? PLATFORMS;
    const publicationLeases: Array<readonly [Platform, HeartbeatPublicationLease]> = [];
    for (const platform of targets) {
      const session = state.sessions[platform];
      const adapter = adapters[platform];
      const wantsTabless = settings.platform[platform].enabled
        && state.authHealth[platform].status === "healthy"
        && session.status === "watching"
        && session.watchMode === "tabless"
        && Boolean(session.channel);
      const contextKey = heartbeatContextKey(session);
      const ownership = await withHeartbeatLane(platform, async (lane) => {
        const committed = lane.committed;
        const watcher = committed?.watcher ?? heartbeatSlice.tablessWatchers.get(platform);
        const keepsCommittedContext = wantsTabless
          && adapter.createTablessWatcher !== undefined
          && contextKey !== undefined
          && committed?.contextKey === contextKey;
        const needsPublicationLease = keepsCommittedContext
          ? false
          : (wantsTabless && adapter.createTablessWatcher !== undefined) || watcher !== undefined;
        let publicationLease: HeartbeatPublicationLease | undefined;
        if (needsPublicationLease) {
          publicationLease = lane.publicationLease;
          if (!publicationLease) {
            publicationLease = newHeartbeatPublicationLease();
            lane.publicationLease = publicationLease;
            // Invalidate recovery that captured storage before this handoff
            // started. The lease remains held until scheduler persistence.
            lane.revision += 1;
          }
        }
        return {
          revision: lane.revision,
          committed,
          watcher,
          publicationLease,
        };
      });
      if (ownership.publicationLease) {
        publicationLeases.push([platform, ownership.publicationLease]);
      }
      const existing = ownership.watcher;

      try {
        if (wantsTabless && session.channel && adapter.createTablessWatcher) {
          const changingContext = ownership.committed != null
            && ownership.committed.contextKey !== contextKey;
          const watcher = !existing || changingContext
            ? adapter.createTablessWatcher()
            : existing;
          const created = watcher !== existing;
          drainWatcherEvents(watcher, emit);
          if (watcher.channelUrl !== session.channel.url) {
            let startFailed = false;
            let startError: unknown;
            try {
              await watcher.start(session.channel, tablessWatchContext());
            } catch (error) {
              startFailed = true;
              startError = error;
            } finally {
              drainWatcherEvents(watcher, emit);
            }
            if (startFailed) {
              emit({
                category: "diagnostic",
                platform,
                level: "warn",
                message: startError instanceof Error ? startError.message : "Could not start the tabless watcher",
              });
            }
          }
          const publication = await commitHeartbeatContext(
            platform,
            session,
            watcher,
            ownership.revision,
            ownership.publicationLease,
          );
          const winningContext = publication.committed;
          session.tablessHeartbeat = publication.accepted || !winningContext
            || winningContext.contextKey !== contextKey
            ? publication.cadence
            : winningContext.session.tablessHeartbeat;
          const discarded = publication.accepted
            ? publication.replaced
            : created ? watcher : undefined;
          if (discarded) await stopTablessWatcher(discarded, platform, emit);
        } else if (existing) {
          const removal = await takeHeartbeatWatcher(platform, ownership.revision);
          session.tablessHeartbeat = undefined;
          if (!removal.accepted || !removal.watcher) continue;
          await stopTablessWatcher(removal.watcher, platform, emit);
        } else {
          await takeHeartbeatWatcher(platform, ownership.revision);
          session.tablessHeartbeat = undefined;
        }
      } catch (error) {
        if (ownership.publicationLease) {
          await releaseHeartbeatPublicationLease(platform, ownership.publicationLease);
          const index = publicationLeases.findIndex(([leasePlatform, lease]) =>
            leasePlatform === platform && lease === ownership.publicationLease);
          if (index >= 0) publicationLeases.splice(index, 1);
        }
        throw error;
      }
    }
    return publicationLeases;
  }

  function drainWatcherEvents(watcher: TablessWatchController, emit: EventEmitter): void {
    for (const event of watcher.drainEvents()) emit(event);
  }

  async function stopTablessWatcher(
    watcher: TablessWatchController,
    platform: Platform,
    emit: EventEmitter,
  ): Promise<void> {
    drainWatcherEvents(watcher, emit);
    try {
      await watcher.stop();
    } catch (error) {
      emitHostCallbackError(emit, platform, error, "Could not stop the tabless watcher");
    } finally {
      drainWatcherEvents(watcher, emit);
    }
  }

  async function clearHeartbeatOwnership(platforms: readonly Platform[]): Promise<void> {
    await withEventCollector(async (emit, events) => {
      for (const platform of platforms) {
        const removal = await takeHeartbeatWatcher(platform);
        if (removal.watcher) await stopTablessWatcher(removal.watcher, platform, emit);
      }
      await reportBestEffort(events);
    });
  }

  function clearHeartbeatOwnershipInBackground(platforms: readonly Platform[]): void {
    const run = clearHeartbeatOwnership(platforms).catch((error) => {
      const platform = platforms.length === 1 ? platforms[0] : undefined;
      diagnosticEvent(
        "warn",
        `Tabless watcher cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        platform,
      );
    });
    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  // Fired by the 1-minute watch alarm. Runs one heartbeat per active tabless
  // watcher and records its health on the session, falling back to a real tab
  // (by re-running the scheduler) when a heartbeat keeps failing.
  async function runWatchHeartbeat(): Promise<void> {
    const settings = await deps.loadSettings();
    if (!isFarmingActive(settings)) return;

    const heartbeatResults = await Promise.allSettled(PLATFORMS.map((platform) =>
      runPlatformWatchHeartbeat(platform, settings)));
    const fallbacks = heartbeatResults.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : []);
    const fallbackResults = await Promise.allSettled(fallbacks.map(runHeartbeatFallback));
    const failures = [...heartbeatResults, ...fallbackResults].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Platform watch heartbeats failed");
    }
  }

  async function runPlatformWatchHeartbeat(
    platform: Platform,
    settings: S,
  ): Promise<HeartbeatFallback | undefined> {
    if (lifecycleSlice.controllerShutdown) return undefined;
    await withEventCollector(async (emit, events) => {
      while (!lifecycleSlice.controllerShutdown) {
        // Capture the lane revision before loading storage. If another recovery
        // publishes while this read is pending, the loaded snapshot must not
        // remove or replace that newer owner.
        const expectedRevision = heartbeatSlice.heartbeatLanes[platform].revision;
        const expectedPageContextRevision = currentManagedPageContextTabsRevision();
        const nextState = await deps.loadState();
        hydrateManagedPageContextTabs(
          nextState.managedPageContextTabs ?? {},
          [platform],
          expectedPageContextRevision,
        );
        const adapters = createSelectedAdapters(settings, emit, [platform]);
        const prepared = await preparePlatformHeartbeatContext(
          platform,
          settings,
          nextState,
          adapters,
          emit,
          expectedRevision,
        );
        if (prepared) break;
      }
      await reportBestEffort(events);
    });
    if (lifecycleSlice.controllerShutdown) return undefined;
    return requestPlatformHeartbeat(platform, settings, "scheduled");
  }

  async function preparePlatformHeartbeatContext(
    platform: Platform,
    settings: S,
    state: SchedulerState,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    expectedRevision: number,
  ): Promise<boolean> {
    const session = state.sessions[platform];
    const contextKey = heartbeatContextKey(session);
    const wantsTabless = settings.platform[platform].enabled
      && state.authHealth[platform].status === "healthy"
      && session.status === "watching"
      && session.watchMode === "tabless"
      && Boolean(session.channel)
      && Boolean(contextKey)
      && Boolean(adapters[platform].createTablessWatcher);

    let recoveryCommit: HeartbeatRecoveryCommit | undefined;
    const decision = await withHeartbeatLane(platform, async (lane) => {
      if (lane.publicationLease) {
        if (
          lane.committed
          && lane.publicationLease.published === lane.committed
        ) {
          return { ready: true };
        }
        return { waitFor: lane.publicationLease.admissionReady };
      }
      if (lane.recoveryCommit) return { waitFor: lane.recoveryCommit.settled };
      if (lane.revision !== expectedRevision) {
        // A same-context winner makes this invocation redundant. A different
        // normalized target asks the caller to reload storage and retry. An
        // invalid stale snapshot never tears down the winner that appeared
        // after its read began.
        if (contextKey && lane.committed?.contextKey !== contextKey) return { retry: true };
        return { ready: true };
      }

      const persistedMetadata = session.tablessHeartbeat;
      const retainedCadence = validTablessHeartbeatCadence(session);
      if (lane.committed) {
        const sameAuthority = wantsTabless
          && lane.committed.contextKey === contextKey
          && retainedCadence?.generation === lane.committed.generation;
        const stalePersistedAuthority = wantsTabless
          && retainedCadence !== undefined
          && retainedCadence.generation < lane.committed.generation;
        if (sameAuthority || stalePersistedAuthority) return { ready: true };
        if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };
        const discarded = lane.committed.watcher;
        lane.committed = undefined;
        heartbeatSlice.tablessWatchers.delete(platform);
        lane.revision += 1;
        return { discarded, retry: wantsTabless };
      }
      if (!wantsTabless || !session.channel || !contextKey) return { ready: true };
      if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };

      // A fresh service worker has no watcher instance to reserve. Construct
      // and start exactly one under the narrow lane synchronization, then make
      // the immutable context visible before any provider heartbeat transport.
      const watcher = adapters[platform].createTablessWatcher!();
      drainWatcherEvents(watcher, emit);
      try {
        await watcher.start(session.channel, tablessWatchContext());
      } catch (error) {
        emit({
          category: "diagnostic",
          platform,
          level: "warn",
          message: error instanceof Error ? error.message : "Could not start the tabless watcher",
        });
      } finally {
        drainWatcherEvents(watcher, emit);
      }
      if (lifecycleSlice.controllerShutdown) return { discarded: watcher, ready: true };

      const persistedGeneration = validHeartbeatGeneration(persistedMetadata?.generation)
        ? persistedMetadata.generation
        : 0;
      const mayRestorePersisted = retainedCadence
        && (lane.generationHighWater === undefined
          || retainedCadence.generation > lane.generationHighWater);
      const generation = mayRestorePersisted
        ? retainedCadence.generation
        : nextHeartbeatGeneration(lane.generationHighWater, persistedGeneration);
      const cadence: TablessHeartbeatCadence = Object.freeze(mayRestorePersisted
        ? { ...retainedCadence }
        : {
            generation,
            contextKey,
            nextDueAt: retainedCadence?.nextDueAt ?? new Date(Date.now()).toISOString(),
          });
      if (!mayRestorePersisted) {
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        recoveryCommit = {
          generation,
          contextKey,
          expectedPersistedCadence: retainedCadence
            ? Object.freeze({ ...retainedCadence })
            : undefined,
          settled,
          settle,
        };
        lane.recoveryCommit = recoveryCommit;
      }
      lane.committed = Object.freeze({
        generation,
        contextKey,
        session: frozenHeartbeatSession(session, cadence),
        watcher,
      });
      lane.generationHighWater = Math.max(lane.generationHighWater ?? 0, generation);
      heartbeatSlice.tablessWatchers.set(platform, watcher);
      lane.revision += 1;
      return { cadence, ready: true };
    });

    if ("waitFor" in decision) {
      await decision.waitFor;
      return false;
    }
    if ("discarded" in decision && decision.discarded) {
      await stopTablessWatcher(decision.discarded, platform, emit);
      return !("retry" in decision && decision.retry);
    }
    if ("retry" in decision) return false;
    const candidateRecovery = recoveryCommit;
    const candidateCadence = "cadence" in decision ? decision.cadence : undefined;
    if (!candidateRecovery || !candidateCadence) return true;

    let accepted = false;
    try {
      accepted = await persistRecoveredHeartbeatCadence(
        platform,
        settings,
        candidateRecovery,
        candidateCadence,
      );
    } finally {
      let discarded: TablessWatchController | undefined;
      await withHeartbeatLane(platform, async (lane) => {
        if (lane.recoveryCommit === candidateRecovery) {
          lane.recoveryCommit = undefined;
          if (
            !accepted
            && lane.committed?.generation === candidateRecovery.generation
            && lane.committed.contextKey === candidateRecovery.contextKey
          ) {
            discarded = lane.committed.watcher;
            lane.committed = undefined;
            heartbeatSlice.tablessWatchers.delete(platform);
            lane.revision += 1;
          }
          candidateRecovery.settle();
        }
      });
      if (discarded) await stopTablessWatcher(discarded, platform, emit);
    }
    return accepted;
  }

  async function persistRecoveredHeartbeatCadence(
    platform: Platform,
    settings: S,
    recovery: HeartbeatRecoveryCommit,
    cadence: TablessHeartbeatCadence,
  ): Promise<boolean> {
    return withStateCommit(async () => {
      if (lifecycleSlice.controllerShutdown || !settings.platform[platform].enabled) return false;
      const latest = await deps.loadState();
      const current = latest.sessions[platform];
      if (
        latest.authHealth[platform].status !== "healthy"
        || current.status !== "watching"
        || current.watchMode !== "tabless"
        || heartbeatContextKey(current) !== recovery.contextKey
      ) {
        return false;
      }
      const persisted = validTablessHeartbeatCadence(current);
      if (persisted) {
        if (
          persisted.generation === recovery.generation
          && persisted.nextDueAt === cadence.nextDueAt
        ) {
          return true;
        }
        if (
          !recovery.expectedPersistedCadence
          || persisted.generation !== recovery.expectedPersistedCadence.generation
          || persisted.nextDueAt !== recovery.expectedPersistedCadence.nextDueAt
        ) {
          return false;
        }
      }
      await saveOperationalStateDirect({
        ...latest,
        sessions: {
          ...latest.sessions,
          [platform]: {
            ...current,
            tablessHeartbeat: cadence,
          },
        },
      });
      return true;
    });
  }

  async function requestPlatformHeartbeat(
    platform: Platform,
    settings: S,
    kind: HeartbeatAttemptKind,
    session?: WatchSession,
  ): Promise<HeartbeatFallback | undefined> {
    return withEventCollector(async (emit, events) => {
      if (lifecycleSlice.controllerShutdown) return undefined;
      const requestedAt = Date.now();
      let resolveAttempt!: (fallback: HeartbeatFallback | undefined) => void;
      let rejectAttempt!: (error: unknown) => void;
      const attemptPromise = new Promise<HeartbeatFallback | undefined>((resolve, reject) => {
        resolveAttempt = resolve;
        rejectAttempt = reject;
      });
      let reservation: {
        start: boolean;
        standaloneCoalescedCalls: number;
        attempt?: HeartbeatAttempt;
        committed?: CommittedHeartbeatContext;
      };
      while (true) {
        const decision = await withHeartbeatLane(platform, async (lane) => {
          if (lifecycleSlice.controllerShutdown) {
            return { start: false, standaloneCoalescedCalls: 0 };
          }
          if (
            lane.publicationLease
            && lane.publicationLease.published !== lane.committed
          ) {
            return { waitFor: lane.publicationLease.admissionReady };
          }
          const committed = lane.committed;
          const requestedContextKey = session ? heartbeatContextKey(session) : committed?.contextKey;
          const requestedGeneration = session
            ? validTablessHeartbeatCadence(session)?.generation
            : undefined;
          if (
            !committed
            || requestedContextKey !== committed.contextKey
            || (kind === "immediate" && requestedGeneration !== committed.generation)
          ) {
            const standaloneCoalescedCalls = lane.coalescedWithoutAttempt;
            lane.coalescedWithoutAttempt = 0;
            return { start: false, standaloneCoalescedCalls };
          }

          if (
            lane.inFlight
            && lane.inFlight.generation === committed.generation
            && lane.inFlight.contextKey === committed.contextKey
          ) {
            lane.inFlight.coalescedCalls += 1;
            return { attempt: lane.inFlight, start: false, standaloneCoalescedCalls: 0 };
          }

          const attemptAt = Date.now();
          let dueAt = attemptAt;
          if (kind === "scheduled") {
            dueAt = Date.parse(committed.session.tablessHeartbeat?.nextDueAt ?? "");
            if (!Number.isFinite(dueAt) || attemptAt < dueAt) {
              return { start: false, standaloneCoalescedCalls: 0 };
            }
          } else if (
            lane.lastCompletedGeneration === committed.generation
            && lane.lastCompletedContextKey === committed.contextKey
          ) {
            const lastHeartbeatAt = Date.parse(committed.session.lastHeartbeatAt ?? "");
            if (Number.isFinite(lastHeartbeatAt) && attemptAt - lastHeartbeatAt < RECENT_HEARTBEAT_MS) {
              return { start: false, standaloneCoalescedCalls: 0 };
            }
          }

          const attempt: HeartbeatAttempt = {
            generation: committed.generation,
            contextKey: committed.contextKey,
            dueAt,
            attemptAt,
            synchronizationDelayMs: Math.max(0, attemptAt - requestedAt),
            coalescedCalls: lane.coalescedWithoutAttempt,
            promise: attemptPromise,
          };
          lane.coalescedWithoutAttempt = 0;
          lane.inFlight = attempt;
          return { attempt, committed, start: true, standaloneCoalescedCalls: 0 };
        });
        if ("waitFor" in decision) {
          await decision.waitFor;
          continue;
        }
        reservation = decision;
        break;
      }

      if (!reservation.attempt) {
        if (reservation.standaloneCoalescedCalls > 0) {
          emit({
            category: "diagnostic",
            platform,
            level: "debug",
            message: `Tabless heartbeat coalescing ended without an attempt coalescedCalls=${reservation.standaloneCoalescedCalls}`,
          });
        }
        await reportBestEffort(events);
        return undefined;
      }

      if (!reservation.start || !reservation.committed) {
        await reportBestEffort(events);
        return reservation.attempt.promise;
      }

      const { attempt, committed } = reservation;
      if (lifecycleSlice.controllerShutdown) {
        await withHeartbeatLane(platform, async (lane) => {
          if (lane.inFlight === attempt) lane.inFlight = undefined;
        });
        resolveAttempt(undefined);
        await reportBestEffort(events);
        return attempt.promise;
      }
      void (async () => {
        try {
          const fallback = await performReservedHeartbeatAttempt(
            platform,
            settings,
            committed,
            attempt,
            emit,
            events,
          );
          resolveAttempt(fallback);
        } catch (error) {
          rejectAttempt(error);
        }
      })();
      return attempt.promise;
    });
  }

  async function performReservedHeartbeatAttempt(
    platform: Platform,
    settings: S,
    committed: CommittedHeartbeatContext,
    attempt: HeartbeatAttempt,
    emit: EventEmitter,
    events: EngineEvent[],
  ): Promise<HeartbeatFallback | undefined> {
    const { watcher } = committed;
    let ok = false;
    let message: string | undefined;
    drainWatcherEvents(watcher, emit);
    try {
      const result = await watcher.tick(tablessWatchContext());
      ok = result.ok;
      message = result.message;
    } catch (error) {
      message = error instanceof Error ? error.message : "Tabless heartbeat failed";
    } finally {
      drainWatcherEvents(watcher, emit);
    }

    let commit = { stale: false, fallback: false };
    let commitError: unknown;
    try {
      commit = await commitHeartbeatResult(platform, settings, attempt, ok, message, emit);
      await reportBestEffort(events);
    } catch (error) {
      commitError = error;
    }

    const coalescedCalls = await withHeartbeatLane(platform, async (lane) => {
      if (lane.inFlight === attempt) lane.inFlight = undefined;
      return attempt.coalescedCalls;
    });
    await reportBestEffort([{
      category: "diagnostic",
      platform,
      level: ok ? "debug" : "warn",
      message: [
        "Tabless heartbeat timing",
        `scheduledDueAt=${new Date(attempt.dueAt).toISOString()}`,
        `actualAttemptAt=${new Date(attempt.attemptAt).toISOString()}`,
        `latenessMs=${Math.max(0, attempt.attemptAt - attempt.dueAt)}`,
        `synchronizationDelayMs=${attempt.synchronizationDelayMs}`,
        `coalescedCalls=${coalescedCalls}`,
        `outcome=${ok ? "ok" : "failed"}`,
        `staleResult=${commit.stale}`,
      ].join(" "),
    }]);

    if (commitError) throw commitError;
    return commit.fallback
      ? { platform, generation: attempt.generation, contextKey: attempt.contextKey }
      : undefined;
  }

  async function commitHeartbeatResult(
    platform: Platform,
    settings: S,
    attempt: HeartbeatAttempt,
    ok: boolean,
    message: string | undefined,
    emit: EventEmitter,
  ): Promise<{ stale: boolean; fallback: boolean }> {
    const reservation = await reserveHeartbeatResultCommit(platform, attempt);
    if (!reservation) return { stale: true, fallback: false };

    let committedSession: WatchSession | undefined;
    try {
      return await withStateCommit(async () => {
        const latest = await deps.loadState();
        const current = latest.sessions[platform];
        if (!heartbeatAuthorityMatches(current, attempt.generation, attempt.contextKey)) {
          return { stale: true, fallback: false };
        }

        const previousChecks = current.heartbeatChecks ?? 0;
        const heartbeatChecks = ok ? 0 : previousChecks + 1;
        const nextSession: WatchSession = {
          ...current,
          lastHeartbeatAt: new Date().toISOString(),
          lastHeartbeatOk: ok,
          heartbeatChecks,
          tablessHeartbeat: {
            generation: attempt.generation,
            contextKey: attempt.contextKey,
            nextDueAt: new Date(nextHeartbeatDueAt(attempt.dueAt, attempt.attemptAt)).toISOString(),
          },
        };
        const managedPageContextTabs = { ...latest.managedPageContextTabs };
        const pageContext = currentManagedPageContextTabs()[platform];
        if (pageContext) managedPageContextTabs[platform] = pageContext;
        else delete managedPageContextTabs[platform];

        if (ok && previousChecks > 0) {
          emit({ category: "diagnostic", platform, level: "info", message: "Tabless watch heartbeat recovered" });
        } else if (!ok && previousChecks === 0) {
          emit({ category: "diagnostic", platform, level: "warn", message: message ?? "Tabless watch heartbeat failed" });
        }
        const fallback = !current.supplementalWatch?.tablessOnly && !ok && heartbeatChecks >= settings.tablessFallbackFailureLimit;
        if (fallback) {
          emit({ category: "diagnostic", platform, level: "warn", message: "Tabless watch heartbeat keeps failing; falling back to a watch tab" });
        }

        await saveOperationalStateDirect({
          ...latest,
          sessions: {
            ...latest.sessions,
            [platform]: nextSession,
          },
          managedPageContextTabs,
        });
        if (current.lastHeartbeatOk !== ok || previousChecks !== heartbeatChecks) {
          invalidateSelection(platform);
        }
        committedSession = nextSession;
        return { stale: false, fallback };
      });
    } finally {
      await finishHeartbeatResultCommit(platform, reservation, committedSession);
    }
  }

  async function reserveHeartbeatResultCommit(
    platform: Platform,
    attempt: HeartbeatAttempt,
  ): Promise<HeartbeatResultCommit | undefined> {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const reservation: HeartbeatResultCommit = { attempt, settled, settle };
    while (true) {
      const decision = await withHeartbeatLane(platform, async (lane) => {
        if (lane.publicationLease && !lane.publicationLease.published) {
          return { waitFor: lane.publicationLease.admissionReady };
        }
        if (
          lane.committed?.generation !== attempt.generation
          || lane.committed.contextKey !== attempt.contextKey
        ) {
          return { accepted: false };
        }
        if (lane.publicationLease?.published === lane.committed) {
          return { waitFor: lane.publicationLease.settled };
        }
        if (lane.resultCommit) return { accepted: false };
        lane.resultCommit = reservation;
        return { accepted: true };
      });
      if ("waitFor" in decision) {
        await decision.waitFor;
        continue;
      }
      return decision.accepted ? reservation : undefined;
    }
  }

  async function finishHeartbeatResultCommit(
    platform: Platform,
    reservation: HeartbeatResultCommit,
    committedSession: WatchSession | undefined,
  ): Promise<void> {
    await withHeartbeatLane(platform, async (lane) => {
      try {
        if (
          committedSession
          && lane.committed?.generation === reservation.attempt.generation
          && lane.committed.contextKey === reservation.attempt.contextKey
        ) {
          lane.lastCompletedGeneration = reservation.attempt.generation;
          lane.lastCompletedContextKey = reservation.attempt.contextKey;
          lane.committed = Object.freeze({
            ...lane.committed,
            session: frozenHeartbeatSession(
              committedSession,
              committedSession.tablessHeartbeat!,
            ),
          });
        }
      } finally {
        if (lane.resultCommit === reservation) lane.resultCommit = undefined;
        reservation.settle();
      }
    });
  }

  function heartbeatAuthorityMatches(
    session: WatchSession,
    generation: number,
    contextKey: string,
  ): boolean {
    const cadence = validTablessHeartbeatCadence(session);
    return cadence?.generation === generation && cadence.contextKey === contextKey;
  }

  async function runHeartbeatFallback(fallback: HeartbeatFallback): Promise<void> {
    const ownsLane = await withHeartbeatLane(fallback.platform, async (lane) =>
      lane.committed?.generation === fallback.generation
      && lane.committed.contextKey === fallback.contextKey);
    if (!ownsLane) return;

    const ownsPersistedContext = await withStateCommit(async () => {
      const latest = await deps.loadState();
      return heartbeatAuthorityMatches(
        latest.sessions[fallback.platform],
        fallback.generation,
        fallback.contextKey,
      );
    });
    if (!ownsPersistedContext) return;

    const stillOwnsLane = await withHeartbeatLane(fallback.platform, async (lane) =>
      lane.committed?.generation === fallback.generation
      && lane.committed.contextKey === fallback.contextKey);
    if (!stillOwnsLane) return;
    await tick([fallback.platform], "tabless_fallback");
  }

  return {
    releaseHeartbeatPublicationLease,
    cancelHeartbeatPublicationLeases,
    reconcileTablessWatchers,
    clearHeartbeatOwnership,
    clearHeartbeatOwnershipInBackground,
    runWatchHeartbeat,
    requestPlatformHeartbeat,
  };
}
