import type { ChannelCandidate, EngineSettings, SchedulerState } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { autoClaimChannelPointsFor } from "@lurkloot/shared/settings";
import { pausedForManualWatch, recentManualWatch } from "../core/manualWatch";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TwitchChannelPointsClaimNotice, TwitchChannelPointsPushController } from "../platforms/twitch/channelPointsPush";
import { TWITCH_CHANNEL_POINTS_ALARM_NAME } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import type { StateTransaction } from "./stateTransaction";
import type { BackgroundJob } from "./jobs";
import { ObserverSlot } from "./observerSlot";
import type { TickEffectExecutor } from "./tickEffects";
import type { ControllerCalls } from "./types";

function eligibleTwitchChannelPointsChannel(
  settings: EngineSettings,
  state: SchedulerState,
  now = Date.now(),
): ChannelCandidate | undefined {
  if (pausedForManualWatch(settings, state, "twitch", now)) {
    return recentManualWatch(state, "twitch", now)?.channel;
  }
  const session = state.sessions.twitch;
  return session.status === "watching" ? session.channel : undefined;
}

// One channel-points claim request at a time, whether the tick, the one-minute
// job or a push asks for it. None of them holds a lock while claiming (#590).
export class ChannelPointsClaimGate {
  private running: Promise<boolean> | undefined;

  // The tick and the job claim whatever bonus is available, so while a request
  // is already running they skip instead of sending a second one.
  async unlessRunning(claim: () => Promise<boolean>): Promise<boolean> {
    if (this.running) return false;
    return await this.run(claim);
  }

  // A push names one claim, which a request already running may predate, so
  // the push waits its turn instead. Push claims reach this one at a time
  // (their queue in createChannelPoints), so only one ever waits here.
  async afterRunning(claim: () => Promise<boolean>): Promise<boolean> {
    while (this.running) await this.running.catch(() => undefined);
    return await this.run(claim);
  }

  private async run(claim: () => Promise<boolean>): Promise<boolean> {
    // Set before the first await, so a caller that checks next sees it.
    const running = claim();
    this.running = running;
    try {
      return await running;
    } finally {
      if (this.running === running) this.running = undefined;
    }
  }
}

// The channel-points claim effect a scheduler tick plans (#599). This is its
// only handler, and it shares `gate` with the job and the push.
export function registerChannelPointsClaimEffect(
  executor: TickEffectExecutor,
  gate: ChannelPointsClaimGate,
): TickEffectExecutor {
  return executor.register("claimChannelPoints", async ({ platform, channel }, context) => {
    const adapter = context.adapters[platform];
    if (!adapter) throw new Error(`No ${platform} adapter for the scheduler effect`);
    return await gate.unlessRunning(async () =>
      await adapter.claimChannelPoints?.(channel, { signal: context.signal }) ?? false);
  });
}

// The one-minute job, on every host: the CLI runs it too since #590, so it no
// longer claims only at poll cadence.
export const TWITCH_CHANNEL_POINTS_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [TWITCH_CHANNEL_POINTS_ALARM_NAME]: { run: (runner) => runner.runTwitchChannelPointsClaim() },
};

// Twitch channel points (#590): the push observer, its claim queue, the claim
// effect and the one-minute job. Their state is this service's own.
export function createChannelPoints<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  transaction: Pick<StateTransaction<S>, "onCommit">,
  { tickSlice, lifecycleSlice }: Pick<ControllerSlices<S>, "tickSlice" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "createAdapter"
    | "diagnosticEvent"
    | "reportBestEffort"
    | "withEventCollector"
  >,
): Pick<ControllerCalls<S>,
  | "abortTwitchChannelPointsClaims"
  | "abortIneligibleTwitchChannelPointsClaims"
  | "clearTwitchChannelPointsAlarmBestEffort"
  | "reconcileTwitchChannelPointsAlarm"
  | "rescheduleTwitchChannelPointsJob"
  | "stopTwitchChannelPointsPush"
  | "stopTwitchChannelPointsPushAndReport"
  | "stopTwitchChannelPointsPushInBackground"
  | "twitchChannelPointsPushEpoch"
  | "reconcileTwitchChannelPointsPushAfterCommit"
  | "registerTwitchChannelPointsEffects"
  | "runTwitchChannelPointsClaim"
> {
  const { createAdapter, diagnosticEvent, reportBestEffort, withEventCollector } = lateBound(calls);
  // The push observer. A failed start stops and clears it, so the next
  // reconcile creates a fresh one.
  const push = new ObserverSlot<TwitchChannelPointsPushController>("twitch", "Twitch channel-points observer", "discard");
  const claims = new ChannelPointsClaimGate();
  // Push notices whose claim is queued or running, so a repeated notice
  // coalesces into the claim already on its way.
  const pushClaimsInFlight = new Set<string>();
  // Push claims run one after another, in the order their notices arrived.
  let pushClaimQueue: Promise<void> = Promise.resolve();
  // The job's and the push's claim requests in flight. Disable, auth loss,
  // reset and shutdown abort them (#590); the tick's claim follows the tick's
  // own signal.
  const claimOperations = new Set<AbortController>();
  let jobReschedule: Promise<void> = Promise.resolve();

  function abortTwitchChannelPointsClaims(reason: string): void {
    for (const operation of claimOperations) operation.abort(new Error(reason));
  }

  // After a commit that leaves Twitch auth unhealthy (#595): logout, a
  // rejected or unavailable probe, an account change being checked. The hook
  // acts on the commit it observes even when auth was restored since, so an
  // account change always ends the old viewer's work; a push restarted in
  // between is started again by the next reconcile. Claims are aborted before
  // any await.
  transaction.onCommit(async (change) => {
    if (change.kind !== "state" || !change.platforms.includes("twitch")) return;
    if (change.state.authHealth.twitch.status === "healthy") return;
    abortTwitchChannelPointsClaims("Twitch authentication lost");
    await stopTwitchChannelPointsPushAndReport();
  });

  function abortIneligibleTwitchChannelPointsClaims(settings: EngineSettings, reason: string): void {
    if (settings.platform.twitch.enabled && autoClaimChannelPointsFor(settings, "twitch")) return;
    abortTwitchChannelPointsClaims(reason);
  }

  // Runs one job or push claim under its own abort controller. An aborted
  // claim ends quietly, like the other claim jobs.
  async function runClaimOperation(
    emit: EventEmitter,
    channel: ChannelCandidate,
    claim: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<void> {
    const operation = new AbortController();
    claimOperations.add(operation);
    try {
      emitClaimResult(emit, channel, await claim(operation.signal));
    } catch (error) {
      if (operation.signal.aborted) return;
      emitClaimFailure(emit, error);
    } finally {
      claimOperations.delete(operation);
    }
  }

  function observersOpen(): boolean {
    return lifecycleSlice.observersOpen && !lifecycleSlice.controllerShutdown;
  }

  async function clearTwitchChannelPointsAlarmBestEffort(): Promise<void> {
    try {
      await ports.jobs.cancel(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    } catch {
      await reportBestEffort([{
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch channel-points alarm",
      }]);
    }
  }

  async function reconcileTwitchChannelPointsAlarm(settings: S): Promise<void> {
    if (settings.platform.twitch.enabled && autoClaimChannelPointsFor(settings, "twitch")) {
      await ports.jobs.ensure(TWITCH_CHANNEL_POINTS_ALARM_NAME, { periodInMinutes: 1 });
    } else {
      await ports.jobs.cancel(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    }
    reconcileTwitchChannelPointsPushFromSettingsInBackground(settings);
  }

  // After a settings commit, with the settings lock released: the job and the
  // push follow the latest stored settings. Runs are serialized, so commits
  // that finish out of order still leave the job matching the last one.
  function rescheduleTwitchChannelPointsJob(): Promise<void> {
    const run = jobReschedule.then(async () => {
      if (lifecycleSlice.controllerShutdown) return;
      await reconcileTwitchChannelPointsAlarm(await ports.storage.loadSettings());
    });
    jobReschedule = run.catch(() => undefined);
    return run;
  }

  // Kept under this name: auth transitions still call it under their lock
  // until #595 gives them after-commit hooks.
  async function stopTwitchChannelPointsPush(emit: EventEmitter): Promise<void> {
    await push.stop(emit);
  }

  async function stopTwitchChannelPointsPushAndReport(): Promise<void> {
    await withEventCollector(async (emit, events) => {
      await stopTwitchChannelPointsPush(emit);
      await reportBestEffort(events);
    });
  }

  function stopTwitchChannelPointsPushInBackground(): void {
    const run = stopTwitchChannelPointsPushAndReport().catch((error) => {
      diagnosticEvent(
        "warn",
        `Twitch channel-points observer cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        "twitch",
      );
    });
    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  function reconcileTwitchChannelPointsPushFromSettingsInBackground(settings: S): void {
    const run = reconcileTwitchChannelPointsPushFromSettings(settings).catch((error) => {
      diagnosticEvent(
        "warn",
        `Twitch channel-points observer reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        "twitch",
      );
    });
    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  function pushSettingsAllow(settings: EngineSettings): boolean {
    return settings.platform.twitch.enabled
      && autoClaimChannelPointsFor(settings, "twitch")
      && settings.platform.twitch.channelPointsPushClaim;
  }

  function pushWanted(settings: EngineSettings, state: SchedulerState): boolean {
    return pushSettingsAllow(settings)
      && state.authHealth.twitch.status === "healthy"
      && Boolean(eligibleTwitchChannelPointsChannel(settings, state));
  }

  // Starts or stops the push for `state`. `since` is the slot's epoch read
  // before `state` was: a stop in between means `state` is out of date.
  async function reconcileTwitchChannelPointsPush(
    settings: EngineSettings,
    state: SchedulerState,
    adapter: PlatformAdapter,
    emit: EventEmitter,
    since: number,
  ): Promise<void> {
    await push.reconcile({
      wanted: pushWanted(settings, state),
      factory: adapter.createChannelPointsPushController,
      open: observersOpen,
      since,
      emit,
      start: (controller) => controller.start((notice) => {
        if (push.current !== controller) return;
        queueTwitchChannelPointsPushClaim(notice);
      }),
    });
  }

  // Read where the state the push follows is committed, under its lock.
  function twitchChannelPointsPushEpoch(): number {
    return push.epoch;
  }

  // After a tick commits, with no lock held: reconciles against the state the
  // tick committed. A stop since the commit bumps the epoch, so the push backs
  // off.
  async function reconcileTwitchChannelPointsPushAfterCommit(
    committed: SchedulerState,
    since: number,
    settings: EngineSettings,
    adapter: PlatformAdapter,
    emit: EventEmitter,
  ): Promise<void> {
    try {
      await reconcileTwitchChannelPointsPush(settings, committed, adapter, emit, since);
    } catch (error) {
      diagnosticEvent(
        "warn",
        `Twitch channel-points observer reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        "twitch",
      );
    }
  }

  async function reconcileTwitchChannelPointsPushFromSettings(settings: S): Promise<void> {
    await withEventCollector(async (emit, events) => {
      let adapter: PlatformAdapter | undefined;
      try {
        if (!observersOpen() || !pushSettingsAllow(settings)) {
          await stopTwitchChannelPointsPush(emit);
          return;
        }
        // Before the state is read: a stop after this point makes it stale.
        const since = push.epoch;
        const state = await ports.storage.loadState();
        if (!pushWanted(settings, state)) {
          // Only an observer this state no longer wants is stopped: the read
          // may predate a tick's commit, whose own reconcile then decides.
          if (push.current) await stopTwitchChannelPointsPush(emit);
          return;
        }
        adapter = createAdapter("twitch", settings, emit);
        await reconcileTwitchChannelPointsPush(settings, state, adapter, emit, since);
      } catch (error) {
        emitHostCallbackError(emit, "twitch", error, "Could not reconcile the Twitch channel-points observer");
        await stopTwitchChannelPointsPush(emit);
      } finally {
        adapter?.flushRouteDiagnostics?.(emit);
        await reportBestEffort(events);
      }
    });
  }

  function drainPushEvents(emit: EventEmitter): void {
    const controller = push.current;
    if (controller) for (const event of controller.drainEvents()) emit(event);
  }

  function queueTwitchChannelPointsPushClaim(notice: TwitchChannelPointsClaimNotice): void {
    if (lifecycleSlice.controllerShutdown) return;
    if (pushClaimsInFlight.has(notice.claimId)) return;
    pushClaimsInFlight.add(notice.claimId);
    const run = pushClaimQueue.then(() => withEventCollector(async (emit, events) => {
      try {
        drainPushEvents(emit);
        await claimTwitchChannelPointsFromPush(notice, emit);
      } finally {
        pushClaimsInFlight.delete(notice.claimId);
        drainPushEvents(emit);
        await reportBestEffort(events);
      }
    }));
    pushClaimQueue = run.catch(() => undefined);
    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  function emitClaimResult(emit: EventEmitter, channel: ChannelCandidate, claimed: boolean): void {
    if (!claimed) return;
    emit({
      category: "diagnostic",
      platform: "twitch",
      level: "info",
      message: `Claimed channel points for ${channel.displayName ?? channel.username}`,
    });
  }

  function emitClaimFailure(emit: EventEmitter, error: unknown): void {
    emit({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: error instanceof Error ? error.message : "Channel points claim failed",
    });
  }

  async function claimTwitchChannelPointsFromPush(
    notice: TwitchChannelPointsClaimNotice,
    emit: EventEmitter,
  ): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
    if (!pushSettingsAllow(settings) || state.authHealth.twitch.status !== "healthy") return;
    const channel = eligibleTwitchChannelPointsChannel(settings, state);
    if (!channel) return;
    if (channel.channelId !== undefined && channel.channelId !== notice.channelId) return;
    if (!pushClaimsInFlight.has(notice.claimId)) return;
    await runClaimOperation(emit, channel, async (signal) => await claims.afterRunning(async () => {
      signal.throwIfAborted();
      const adapter = createAdapter("twitch", settings, emit, true);
      return await adapter.claimChannelPoints?.(channel, {
        claimId: notice.claimId,
        channelId: notice.channelId,
        signal,
      }) ?? false;
    }));
  }

  // The one-minute job. It takes no lock: a tick or push claim already running
  // makes it skip (ChannelPointsClaimGate), and Twitch farming never waits on it.
  async function runTwitchChannelPointsClaim(): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    await withEventCollector(async (emit, events) => {
      if (push.current?.subscribed) {
        drainPushEvents(emit);
        await reportBestEffort(events);
        return;
      }
      const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
      if (lifecycleSlice.controllerShutdown
        || !settings.platform.twitch.enabled
        || !autoClaimChannelPointsFor(settings, "twitch")
        || state.authHealth.twitch.status !== "healthy") return;
      const channel = eligibleTwitchChannelPointsChannel(settings, state);
      if (!channel) return;
      try {
        await runClaimOperation(emit, channel, async (signal) => {
          const adapter = createAdapter("twitch", settings, emit, true);
          return await claims.unlessRunning(async () =>
            await adapter.claimChannelPoints?.(channel, { signal }) ?? false);
        });
      } finally {
        await reportBestEffort(events);
      }
    });
  }

  function registerTwitchChannelPointsEffects(executor: TickEffectExecutor): TickEffectExecutor {
    return registerChannelPointsClaimEffect(executor, claims);
  }

  return {
    abortTwitchChannelPointsClaims,
    abortIneligibleTwitchChannelPointsClaims,
    clearTwitchChannelPointsAlarmBestEffort,
    reconcileTwitchChannelPointsAlarm,
    rescheduleTwitchChannelPointsJob,
    stopTwitchChannelPointsPush,
    stopTwitchChannelPointsPushAndReport,
    stopTwitchChannelPointsPushInBackground,
    twitchChannelPointsPushEpoch,
    reconcileTwitchChannelPointsPushAfterCommit,
    registerTwitchChannelPointsEffects,
    runTwitchChannelPointsClaim,
  };
}
