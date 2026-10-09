import type { EngineSettings, Platform, SchedulerState, TablessHeartbeatCadence, WatchSession } from "@lurkloot/shared/models";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import { isFarmingActive } from "@lurkloot/shared/settings";
import {
  currentManagedPageContextTabs,
  currentManagedPageContextTabsRevision,
  hydrateManagedPageContextTabs,
} from "../core/tabRegistry";
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
import { PLATFORMS, WATCH_ALARM_NAME, WATCH_ALARM_PERIOD_MINUTES } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import type { BackgroundJob } from "./jobs";
import type { StateTransaction } from "./stateTransaction";
import type {
  CommittedHeartbeatContext,
  ControllerCalls,
  HeartbeatAttempt,
  HeartbeatAttemptKind,
  HeartbeatFallback,
  HeartbeatLane,
  HeartbeatPublicationLease,
  HeartbeatRecoveryCommit,
  HeartbeatReservation,
  HeartbeatResultCommit,
  HeartbeatWatcherRemoval,
  HeartbeatWatcherRemovalDecision,
  WatcherPlan,
} from "./types";

// How recently a heartbeat must have landed for the post-claim handoff to treat
// the channel as already covered. Half the fixed one-minute alarm period: long
// enough to suppress a genuine double-send, short enough that a real handoff
// still transmits.
const RECENT_HEARTBEAT_MS = 30_000;

// The one-minute watch job, which runs every due heartbeat. Both hosts fire it:
// the extension from browser.alarms, the CLI from its Node scheduler.
export const HEARTBEAT_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [WATCH_ALARM_NAME]: { run: (runner) => runner.runWatchHeartbeat() },
};

function newHeartbeatLane(): HeartbeatLane {
  return { mutation: Promise.resolve(), revision: 0, coalescedWithoutAttempt: 0 };
}

// The tabless heartbeat coordinator (#586). It owns each platform's watcher,
// heartbeat lane, generation high-water mark and publication lease, admits due
// heartbeats, commits their results, recovers watchers after a restart, and
// asks for a tab fallback. The Twitch and Kick heartbeat transports stay in
// their TablessWatchController implementations.
export function createHeartbeatCoordinator<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  transaction: Pick<StateTransaction<S>, "onCommit">,
  { lifecycleSlice, tabRegistry }: Pick<ControllerSlices<S>, "lifecycleSlice" | "tabRegistry">,
  calls: Pick<ControllerCalls<S>,
    | "createSelectedAdapters"
    | "diagnosticEvent"
    | "invalidateSelection"
    | "reportBestEffort"
    | "settleCommitHooks"
    | "tickInBackground"
    | "withEventCollector"
    | "commitState"
    | "readState"
    | "trackHeartbeatLane"
    | "trackBackgroundWork"
  >,
): Pick<ControllerCalls<S>,
  | "ensureHeartbeatJob"
  | "cancelHeartbeatPublicationLeases"
  | "reserveTablessWatchers"
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
    settleCommitHooks,
    tickInBackground,
    withEventCollector,
    commitState,
    readState,
    trackHeartbeatLane,
    trackBackgroundWork,
  } = lateBound(calls);

  // Persistent tabless watchers, one per platform, kept alive across ticks (the
  // WebSocket-based Kick watcher in particular must not be recreated each tick).
  const tablessWatchers = new Map<Platform, TablessWatchController>();
  // Scheduled heartbeat results past the fallback limit, keyed by the state
  // their commit saved; the commit hook below picks them up.
  const tabFallbacks = new WeakMap<SchedulerState, HeartbeatFallback>();
  // Platforms whose watch job is waiting for its fallback to reach the hook.
  const fallbacksRequested = new Set<Platform>();
  const heartbeatLanes: Record<Platform, HeartbeatLane> = {
    twitch: newHeartbeatLane(),
    kick: newHeartbeatLane(),
  };

  // Health commits stay one minute apart (#336). The watch alarm is shorter so
  // a suspended runtime can still request new HLS segments between them.
  async function ensureHeartbeatJob(): Promise<void> {
    await ports.jobs.ensure(WATCH_ALARM_NAME, { periodInMinutes: WATCH_ALARM_PERIOD_MINUTES });
  }

  function withHeartbeatLane<T>(
    platform: Platform,
    operation: (lane: HeartbeatLane) => Promise<T>,
  ): Promise<T> {
    const lane = heartbeatLanes[platform];
    const previous = lane.mutation;
    let release!: () => void;
    lane.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    return trackHeartbeatLane(async () => {
      try {
        await previous;
        return await operation(lane);
      } finally {
        release();
      }
    });
  }

  function newHeartbeatPublicationLease(): HeartbeatPublicationLease {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { settled, settle };
  }

  // Ends a lease if it is still the lane's. Every waiter on it then re-reads the
  // lane.
  function dropPublicationLease(lane: HeartbeatLane, lease: HeartbeatPublicationLease): void {
    if (lane.publicationLease !== lease) return;
    lane.publicationLease = undefined;
    lease.settle();
  }

  async function cancelHeartbeatPublicationLeases(
    platforms: readonly Platform[],
  ): Promise<void> {
    await Promise.all(platforms.map((platform) => withHeartbeatLane(platform, async (lane) => {
      if (lane.publicationLease) dropPublicationLease(lane, lane.publicationLease);
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

  // Detaches the platform's watcher from its lane. Without an expected revision
  // it also ends a pending publication, so the tick that reserved it publishes
  // nothing.
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
          const watcher = lane.committed?.watcher ?? tablessWatchers.get(platform);
          lane.committed = undefined;
          tablessWatchers.delete(platform);
          if (expectedRevision === undefined && lane.publicationLease) {
            dropPublicationLease(lane, lane.publicationLease);
          }
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

  // Starts a watcher on its channel, reporting a failed start as a diagnostic.
  // The watcher is still published: its heartbeats fail, which is what moves
  // the session on.
  async function startTablessWatcher(
    watcher: TablessWatchController,
    platform: Platform,
    channel: NonNullable<WatchSession["channel"]>,
    emit: EventEmitter,
  ): Promise<void> {
    drainWatcherEvents(watcher, emit);
    try {
      await watcher.start(channel, tablessWatchContext());
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
  }

  // Aligns the tabless watchers with the scheduler state a tick is about to
  // commit (#586). Runs inside the tick's platform lock, so it does no watcher
  // or provider I/O and waits on nothing: it allocates each new context's
  // generation, stamps the cadence on the session the tick persists, and takes
  // a publication lease that holds heartbeats back until the watcher is
  // published. The tick then publishes after its commit, with no lock held, or
  // releases the reservation when it does not commit.
  async function reserveTablessWatchers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<HeartbeatReservation> {
    const plans: WatcherPlan[] = [];
    const releasePlans = (): Promise<unknown> => Promise.all(plans.map((plan) =>
      plan.kind === "start" || plan.kind === "stop"
        ? withHeartbeatLane(plan.platform, async (lane) => dropPublicationLease(lane, plan.lease))
        : Promise.resolve()));
    try {
      for (const platform of platforms) {
        const session = state.sessions[platform];
        const adapter = adapters[platform];
        const wantsTabless = settings.platform[platform].enabled
          && state.authHealth[platform].status === "healthy"
          && session.status === "watching"
          && session.watchMode === "tabless"
          && Boolean(session.channel)
          && adapter.createTablessWatcher !== undefined;
        const contextKey = heartbeatContextKey(session);
        const plan = await withHeartbeatLane(platform, async (lane): Promise<WatcherPlan> => {
          const committed = lane.committed;
          const watcher = committed?.watcher ?? tablessWatchers.get(platform);
          if (wantsTabless && contextKey !== undefined && committed?.contextKey === contextKey) {
            return { kind: "keep", platform, watcher: committed.watcher, cadence: committed.session.tablessHeartbeat };
          }
          // A watcher published without a context (no committed lane context)
          // is started again rather than replaced. Constructing one does no I/O,
          // so a factory that throws still fails the tick before it commits.
          const next = wantsTabless
            ? (!committed && watcher) || adapter.createTablessWatcher!()
            : undefined;
          // Whatever the lane held is being replaced: a newer reservation wins
          // over one not yet published, and over a recovery still starting.
          if (lane.publicationLease) dropPublicationLease(lane, lane.publicationLease);
          lane.revision += 1;
          if (!next) {
            if (!watcher) return { kind: "none", platform };
            const lease = newHeartbeatPublicationLease();
            lane.publicationLease = lease;
            return { kind: "stop", platform, lease };
          }
          const lease = newHeartbeatPublicationLease();
          lane.publicationLease = lease;
          const created = next !== watcher;
          if (!contextKey) return { kind: "start", platform, lease, session, watcher: next, created };

          const persistedMetadata = session.tablessHeartbeat;
          const persisted = validTablessHeartbeatCadence(session);
          const mayRestorePersisted = persisted !== undefined
            && (lane.generationHighWater === undefined
              || persisted.generation > lane.generationHighWater);
          const generation = mayRestorePersisted
            ? persisted.generation
            : nextHeartbeatGeneration(
                lane.generationHighWater,
                committed?.generation,
                persistedMetadata?.generation,
              );
          const cadence: TablessHeartbeatCadence = Object.freeze(mayRestorePersisted
            ? { ...persisted }
            : {
                generation,
                contextKey,
                nextDueAt: persisted
                  ? persisted.nextDueAt
                  : new Date(Date.now() + HEARTBEAT_INTERVAL_MS).toISOString(),
              });
          lane.generationHighWater = Math.max(lane.generationHighWater ?? 0, generation);
          return {
            kind: "start",
            platform,
            lease,
            session,
            watcher: next,
            created,
            context: { generation, contextKey, cadence },
          };
        });
        session.tablessHeartbeat = plan.kind === "keep"
          ? plan.cadence
          : plan.kind === "start" ? plan.context?.cadence : undefined;
        plans.push(plan);
      }
    } catch (error) {
      await releasePlans();
      throw error;
    }

    let settled = false;
    return {
      publish: async (emit) => {
        if (settled) return;
        settled = true;
        for (const plan of plans) {
          try {
            await publishWatcherPlan(plan, state.sessions[plan.platform], emit);
          } finally {
            if (plan.kind === "start" || plan.kind === "stop") {
              await withHeartbeatLane(plan.platform, async (lane) => dropPublicationLease(lane, plan.lease));
            }
          }
        }
      },
      // A watcher constructed for the reservation never started, so there is
      // nothing to stop.
      release: async () => {
        if (settled) return;
        settled = true;
        await releasePlans();
      },
    };
  }

  async function publishWatcherPlan(
    plan: WatcherPlan,
    session: WatchSession,
    emit: EventEmitter,
  ): Promise<void> {
    const { platform } = plan;
    if (plan.kind === "none") return;
    if (plan.kind === "keep") {
      // The same context: restart a watcher that lost its channel.
      if (session.channel && plan.watcher.channelUrl !== session.channel.url) {
        await startTablessWatcher(plan.watcher, platform, session.channel, emit);
      }
      return;
    }
    if (plan.kind === "stop") {
      const removed = await withHeartbeatLane(platform, async (lane) => {
        if (lane.publicationLease !== plan.lease) return undefined;
        const watcher = lane.committed?.watcher ?? tablessWatchers.get(platform);
        lane.committed = undefined;
        tablessWatchers.delete(platform);
        lane.revision += 1;
        dropPublicationLease(lane, plan.lease);
        return watcher;
      });
      if (removed) await stopTablessWatcher(removed, platform, emit);
      return;
    }

    if (lifecycleSlice.controllerShutdown || !session.channel) return;
    const { watcher } = plan;
    drainWatcherEvents(watcher, emit);
    if (watcher.channelUrl !== session.channel.url) {
      await startTablessWatcher(watcher, platform, session.channel, emit);
    }
    const publication = await withHeartbeatLane(platform, async (lane) => {
      if (lane.publicationLease !== plan.lease || lifecycleSlice.controllerShutdown) {
        return { accepted: false as const };
      }
      const previous = lane.committed?.watcher ?? tablessWatchers.get(platform);
      if (plan.context) {
        const { generation, contextKey, cadence } = plan.context;
        lane.committed = Object.freeze({
          generation,
          contextKey,
          session: frozenHeartbeatSession(session, cadence),
          watcher,
        });
      } else {
        lane.committed = undefined;
      }
      tablessWatchers.set(platform, watcher);
      lane.revision += 1;
      dropPublicationLease(lane, plan.lease);
      return { accepted: true as const, replaced: previous === watcher ? undefined : previous };
    });
    const discarded = publication.accepted
      ? publication.replaced
      : plan.created ? watcher : undefined;
    if (discarded) await stopTablessWatcher(discarded, platform, emit);
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
    trackBackgroundWork(run);
  }

  // Fired by the 1-minute watch job. Runs one heartbeat per active tabless
  // watcher and records its health on the session. A result that crosses the
  // fallback limit asks for a tab through the commit hook above.
  async function runWatchHeartbeat(): Promise<void> {
    const settings = await ports.storage.loadSettings();
    if (!isFarmingActive(settings)) return;

    const heartbeatResults = await Promise.allSettled(PLATFORMS.map((platform) =>
      runPlatformWatchHeartbeat(platform, settings)));
    const failures = heartbeatResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Platform watch heartbeats failed");
    }
  }

  async function runPlatformWatchHeartbeat(
    platform: Platform,
    settings: S,
  ): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    await withEventCollector(async (emit, events) => {
      while (!lifecycleSlice.controllerShutdown) {
        // Capture the lane revision before loading storage. If another recovery
        // publishes while this read is pending, the loaded snapshot must not
        // remove or replace that newer owner.
        const expectedRevision = heartbeatLanes[platform].revision;
        const expectedPageContextRevision = currentManagedPageContextTabsRevision(tabRegistry);
        const nextState = await ports.storage.loadState();
        hydrateManagedPageContextTabs(
          tabRegistry,
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
    if (lifecycleSlice.controllerShutdown) return;
    await requestPlatformHeartbeat(platform, settings, "scheduled");
    // A job that asked for a tab fallback ends once the hook has handed it to
    // the tick coordinator. Waiting is only for that: a heartbeat never waits
    // on the platform's locks otherwise.
    if (fallbacksRequested.delete(platform)) await settleCommitHooks([platform]);
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

    const decide = () => withHeartbeatLane(platform, async (lane) => {
      // A tick's reservation is unpublished until the tick has committed.
      if (lane.publicationLease) return { waitFor: lane.publicationLease.settled };
      // A recovery still starting its watcher: once it settles, this snapshot
      // is judged against the lane it left, as if it had waited for the lane.
      if (lane.recoveryCommit) {
        return { waitFor: lane.recoveryCommit.settled, recheck: !lane.committed };
      }
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
        tablessWatchers.delete(platform);
        lane.revision += 1;
        return { discarded, retry: wantsTabless };
      }
      if (!wantsTabless || !session.channel || !contextKey) return { ready: true };
      if (lane.resultCommit) return { waitFor: lane.resultCommit.settled };

      // A fresh service worker has no watcher to reuse. Reserve the recovery
      // here; the watcher starts with no lane held (#586) and is published
      // only if nothing replaced the reservation meanwhile.
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
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const recovery: HeartbeatRecoveryCommit = {
        generation,
        contextKey,
        expectedPersistedCadence: retainedCadence
          ? Object.freeze({ ...retainedCadence })
          : undefined,
        settled,
        settle,
      };
      lane.recoveryCommit = recovery;
      lane.generationHighWater = Math.max(lane.generationHighWater ?? 0, generation);
      lane.revision += 1;
      return {
        start: { recovery, cadence, channel: session.channel, revision: lane.revision },
        persist: !mayRestorePersisted,
      };
    });

    let decision = await decide();
    while ("waitFor" in decision && decision.recheck) {
      await decision.waitFor;
      decision = await decide();
    }
    if ("waitFor" in decision) {
      await decision.waitFor;
      return false;
    }
    if ("discarded" in decision && decision.discarded) {
      await stopTablessWatcher(decision.discarded, platform, emit);
      return !("retry" in decision && decision.retry);
    }
    if ("retry" in decision) return false;
    if (!("start" in decision) || !decision.start) return true;

    const { recovery, cadence, channel, revision } = decision.start;
    const watcher = adapters[platform].createTablessWatcher!();
    await startTablessWatcher(watcher, platform, channel, emit);
    const published = await withHeartbeatLane(platform, async (lane) => {
      const current = lane.recoveryCommit === recovery
        && lane.revision === revision
        && !lane.publicationLease
        && !lifecycleSlice.controllerShutdown;
      if (!current) {
        if (lane.recoveryCommit === recovery) {
          lane.recoveryCommit = undefined;
          recovery.settle();
        }
        return false;
      }
      lane.committed = Object.freeze({
        generation: recovery.generation,
        contextKey: recovery.contextKey,
        session: frozenHeartbeatSession(session, cadence),
        watcher,
      });
      tablessWatchers.set(platform, watcher);
      lane.revision += 1;
      if (!decision.persist) {
        // Restored from storage: nothing to persist.
        lane.recoveryCommit = undefined;
        recovery.settle();
      }
      return true;
    });
    if (!published) {
      // Replaced while starting: a tick reserved the lane, or ownership was
      // cleared. The caller reloads and retries, unless shutting down.
      await stopTablessWatcher(watcher, platform, emit);
      return lifecycleSlice.controllerShutdown;
    }
    if (!decision.persist) return true;

    let accepted = false;
    try {
      accepted = await persistRecoveredHeartbeatCadence(
        platform,
        settings,
        recovery,
        cadence,
      );
    } finally {
      let discarded: TablessWatchController | undefined;
      await withHeartbeatLane(platform, async (lane) => {
        if (lane.recoveryCommit === recovery) {
          lane.recoveryCommit = undefined;
          if (
            !accepted
            && lane.committed?.generation === recovery.generation
            && lane.committed.contextKey === recovery.contextKey
          ) {
            discarded = lane.committed.watcher;
            lane.committed = undefined;
            tablessWatchers.delete(platform);
            lane.revision += 1;
          }
          recovery.settle();
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
    let recovered = false;
    const result = await commitState([platform], () =>
      !lifecycleSlice.controllerShutdown && settings.platform[platform].enabled, (latest) => {
      const current = latest.sessions[platform];
      if (
        latest.authHealth[platform].status !== "healthy"
        || current.status !== "watching"
        || current.watchMode !== "tabless"
        || heartbeatContextKey(current) !== recovery.contextKey
      ) {
        return undefined;
      }
      const persisted = validTablessHeartbeatCadence(current);
      if (persisted) {
        if (
          persisted.generation === recovery.generation
          && persisted.nextDueAt === cadence.nextDueAt
        ) {
          recovered = true;
          return undefined;
        }
        if (
          !recovery.expectedPersistedCadence
          || persisted.generation !== recovery.expectedPersistedCadence.generation
          || persisted.nextDueAt !== recovery.expectedPersistedCadence.nextDueAt
        ) {
          return undefined;
        }
      }
      recovered = true;
      return {
        ...latest,
        sessions: {
          ...latest.sessions,
          [platform]: {
            ...current,
            tablessHeartbeat: cadence,
          },
        },
      };
    });
    return result.status !== "stale" && recovered;
  }

  // One segment poll outside the heartbeat lane. A failure here does not change
  // the minute health commit; the next due heartbeat still reports watch health.
  async function sustainTablessWatcher(watcher: TablessWatchController, platform: Platform): Promise<void> {
    if (!watcher.sustain) return;
    try {
      await watcher.sustain();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tabless watch sustain failed";
      await reportBestEffort([{
        category: "diagnostic",
        platform,
        level: "debug",
        message: `Tabless watch sustain failed: ${message}`,
      }]);
      return;
    }
    const pending = watcher.drainEvents();
    if (pending.length > 0) await reportBestEffort(pending);
  }

  async function requestPlatformHeartbeat(
    platform: Platform,
    settings: S,
    kind: HeartbeatAttemptKind,
    session?: WatchSession,
  ): Promise<void> {
    return withEventCollector(async (emit, events) => {
      if (lifecycleSlice.controllerShutdown) return undefined;
      const requestedAt = Date.now();
      let resolveAttempt!: () => void;
      let rejectAttempt!: (error: unknown) => void;
      const attemptPromise = new Promise<void>((resolve, reject) => {
        resolveAttempt = resolve;
        rejectAttempt = reject;
      });
      let reservation: {
        start: boolean;
        standaloneCoalescedCalls: number;
        attempt?: HeartbeatAttempt;
        committed?: CommittedHeartbeatContext;
        sustain?: TablessWatchController;
      };
      while (true) {
        const decision = await withHeartbeatLane(platform, async (lane) => {
          if (lifecycleSlice.controllerShutdown) {
            return { start: false, standaloneCoalescedCalls: 0 };
          }
          // A tick's reservation is unpublished until the tick has committed.
          if (lane.publicationLease) return { waitFor: lane.publicationLease.settled };
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
            if (kind === "scheduled") lane.inFlight.scheduled = true;
            return { attempt: lane.inFlight, start: false, standaloneCoalescedCalls: 0 };
          }

          const attemptAt = Date.now();
          let dueAt = attemptAt;
          if (kind === "scheduled") {
            dueAt = Date.parse(committed.session.tablessHeartbeat?.nextDueAt ?? "");
            if (!Number.isFinite(dueAt) || attemptAt < dueAt) {
              return { start: false, standaloneCoalescedCalls: 0, sustain: committed.watcher };
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
            scheduled: kind === "scheduled",
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
        const watcher = "sustain" in reservation ? reservation.sustain : undefined;
        if (watcher) await sustainTablessWatcher(watcher, platform);
        return;
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
        resolveAttempt();
        await reportBestEffort(events);
        return attempt.promise;
      }
      void (async () => {
        try {
          await performReservedHeartbeatAttempt(
            platform,
            settings,
            committed,
            attempt,
            emit,
            events,
          );
          resolveAttempt();
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
  ): Promise<void> {
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

    let commit = { stale: false };
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
  }

  async function commitHeartbeatResult(
    platform: Platform,
    settings: S,
    attempt: HeartbeatAttempt,
    ok: boolean,
    message: string | undefined,
    emit: EventEmitter,
  ): Promise<{ stale: boolean }> {
    const reservation = await reserveHeartbeatResultCommit(platform, attempt);
    if (!reservation) return { stale: true };

    let committedSession: WatchSession | undefined;
    try {
      let outcome = { stale: true, fallback: false };
      let invalidatesSelection = false;
      let nextCommittedSession: WatchSession | undefined;
      await commitState([platform], undefined, (latest) => {
        const current = latest.sessions[platform];
        if (!heartbeatAuthorityMatches(current, attempt.generation, attempt.contextKey)) {
          return undefined;
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
        const pageContext = currentManagedPageContextTabs(tabRegistry)[platform];
        if (pageContext) managedPageContextTabs[platform] = pageContext;
        else delete managedPageContextTabs[platform];

        if (ok && previousChecks > 0) {
          emit({ category: "diagnostic", platform, level: "info", message: "Tabless watch heartbeat recovered" });
        } else if (!ok && previousChecks === 0) {
          emit({ category: "diagnostic", platform, level: "warn", message: message ?? "Tabless watch heartbeat failed" });
        }
        const fallback = !ok && fallsBackToTab(current, heartbeatChecks, settings);
        if (fallback) {
          emit({ category: "diagnostic", platform, level: "warn", message: "Tabless watch heartbeat keeps failing; falling back to a watch tab" });
        }

        invalidatesSelection = current.lastHeartbeatOk !== ok || previousChecks !== heartbeatChecks;
        nextCommittedSession = nextSession;
        outcome = { stale: false, fallback };
        return {
          ...latest,
          sessions: {
            ...latest.sessions,
            [platform]: nextSession,
          },
          managedPageContextTabs,
        };
      }, {
        afterSave: (state) => {
          if (invalidatesSelection) invalidateSelection(platform);
          committedSession = nextCommittedSession;
          // The alarm's heartbeats ask for the fallback; a post-claim handoff's
          // immediate one leaves it to the next alarm or tick.
          if (outcome.fallback && attempt.scheduled) {
            tabFallbacks.set(state, { platform, generation: attempt.generation, contextKey: attempt.contextKey });
            fallbacksRequested.add(platform);
          }
        },
      });
      return { stale: outcome.stale };
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
    return withHeartbeatLane(platform, async (lane) => {
      // A pending reservation replaces or stops this context, so its result is
      // already stale. Waiting would hold it for the whole tick commit.
      if (lane.publicationLease) return undefined;
      if (
        lane.committed?.generation !== attempt.generation
        || lane.committed.contextKey !== attempt.contextKey
      ) {
        return undefined;
      }
      if (lane.resultCommit) return undefined;
      lane.resultCommit = reservation;
      return reservation;
    });
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

  // Whether heartbeat failures move this session to a watch tab. Never without
  // browser tabs: the watch stays tabless and the scheduler's no-progress check
  // rotates a dead channel. Never for a tabless-only supplemental session
  // (Twitch Extensions, #541/#556), whatever its failure count: it has no tab
  // to fall back to.
  function fallsBackToTab(session: WatchSession, heartbeatChecks: number, settings: S): boolean {
    if (!ports.capabilities.browserTabs) return false;
    if (session.supplementalWatch?.tablessOnly) return false;
    return heartbeatChecks >= settings.tablessFallbackFailureLimit;
  }

  function heartbeatAuthorityMatches(
    session: WatchSession,
    generation: number,
    contextKey: string,
  ): boolean {
    const cadence = validTablessHeartbeatCadence(session);
    return cadence?.generation === generation && cadence.contextKey === contextKey;
  }

  // After a scheduled heartbeat's failing result commits (#586), the tick
  // coordinator learns of the fallback through this hook and ticks the
  // platform, which moves the watch to a tab through the watch-tab port. Not
  // awaited: the tick waits for this platform's hooks, this one included.
  transaction.onCommit(async (change) => {
    if (change.kind !== "state") return;
    const fallback = tabFallbacks.get(change.state);
    if (!fallback) return;
    tabFallbacks.delete(change.state);
    if (await ownsFallbackContext(fallback)) tickInBackground([fallback.platform], "tabless_fallback");
  });

  // Whether the context that asked for a fallback still owns both the lane and
  // the persisted session.
  async function ownsFallbackContext(fallback: HeartbeatFallback): Promise<boolean> {
    if (lifecycleSlice.controllerShutdown) return false;
    const ownsLane = await withHeartbeatLane(fallback.platform, async (lane) =>
      lane.committed?.generation === fallback.generation
      && lane.committed.contextKey === fallback.contextKey);
    if (!ownsLane) return false;

    const latest = await readState();
    const ownsPersistedContext = heartbeatAuthorityMatches(
      latest.sessions[fallback.platform],
      fallback.generation,
      fallback.contextKey,
    );
    if (!ownsPersistedContext) return false;

    const stillOwnsLane = await withHeartbeatLane(fallback.platform, async (lane) =>
      lane.committed?.generation === fallback.generation
      && lane.committed.contextKey === fallback.contextKey);
    return stillOwnsLane;
  }

  return {
    ensureHeartbeatJob,
    cancelHeartbeatPublicationLeases,
    reserveTablessWatchers,
    clearHeartbeatOwnership,
    clearHeartbeatOwnershipInBackground,
    runWatchHeartbeat,
    requestPlatformHeartbeat,
  };
}
