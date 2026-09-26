import type { ChannelCandidate, EngineSettings, SchedulerState } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { autoClaimChannelPointsFor } from "@lurkloot/shared/settings";
import { MANUAL_WATCH_TTL_MS } from "../core/scheduler";
import { isTimestampStale } from "../core/timestamps";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TwitchChannelPointsClaimNotice, TwitchChannelPointsPushController } from "../platforms/twitch/channelPointsPush";
import { TWITCH_CHANNEL_POINTS_ALARM_NAME } from "./constants";
import { claimExclusively, type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import type { ControllerCalls } from "./types";

function eligibleTwitchChannelPointsChannel(
  settings: EngineSettings,
  state: SchedulerState,
  now = Date.now(),
): ChannelCandidate | undefined {
  const manualWatch = state.manualWatch?.twitch;
  const recentManualWatch = settings.pauseOnManualWatch
    && manualWatch?.active
    && !isTimestampStale(manualWatch.checkedAt, MANUAL_WATCH_TTL_MS, now);
  if (recentManualWatch) {
    return manualWatch.channel;
  }
  const session = state.sessions.twitch;
  return session.status === "watching" ? session.channel : undefined;
}

// Twitch channel points: the push observer, its claims and the one-minute job.
export function createChannelPoints<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { channelPointsSlice, signalSlice, tickSlice, lifecycleSlice }: Pick<ControllerSlices<S>,
    | "channelPointsSlice"
    | "signalSlice"
    | "tickSlice"
    | "lifecycleSlice"
  >,
  calls: Pick<ControllerCalls<S>,
    | "createAdapter"
    | "diagnosticEvent"
    | "reportBestEffort"
    | "withEventCollector"
    | "withPlatformLock"
  >,
): Pick<ControllerCalls<S>,
  | "clearTwitchChannelPointsAlarmBestEffort"
  | "reconcileTwitchChannelPointsAlarm"
  | "stopTwitchChannelPointsPush"
  | "stopTwitchChannelPointsPushAndReport"
  | "stopTwitchChannelPointsPushInBackground"
  | "reconcileTwitchChannelPointsPush"
  | "runTwitchChannelPointsClaim"
> {
  const { createAdapter, diagnosticEvent, reportBestEffort, withEventCollector, withPlatformLock } = lateBound(calls);

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

  function drainTwitchChannelPointsPushEvents(
    controller: TwitchChannelPointsPushController,
    emit: EventEmitter,
  ): void {
    for (const event of controller.drainEvents()) emit(event);
  }

  async function stopTwitchChannelPointsPush(emit: EventEmitter): Promise<void> {
    const controller = channelPointsSlice.twitchChannelPointsPush;
    if (!controller) return;
    channelPointsSlice.twitchChannelPointsPush = undefined;
    drainTwitchChannelPointsPushEvents(controller, emit);
    try {
      await controller.stop();
    } catch (error) {
      emitHostCallbackError(emit, "twitch", error, "Could not stop the Twitch channel-points observer");
    } finally {
      drainTwitchChannelPointsPushEvents(controller, emit);
    }
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

  function twitchChannelPointsPushWanted(
    settings: EngineSettings,
    state: SchedulerState,
    factory: PlatformAdapter["createChannelPointsPushController"],
  ): boolean {
    return signalSlice.discoverySignalLifecycleOpen
      && !lifecycleSlice.controllerShutdown
      && settings.platform.twitch.enabled
      && autoClaimChannelPointsFor(settings, "twitch")
      && settings.platform.twitch.channelPointsPushClaim
      && state.authHealth.twitch.status === "healthy"
      && Boolean(eligibleTwitchChannelPointsChannel(settings, state))
      && Boolean(factory);
  }

  async function reconcileTwitchChannelPointsPush(
    settings: EngineSettings,
    state: SchedulerState,
    adapter: PlatformAdapter,
    emit: EventEmitter,
  ): Promise<void> {
    const factory = adapter.createChannelPointsPushController;
    if (!twitchChannelPointsPushWanted(settings, state, factory) || !factory) {
      await stopTwitchChannelPointsPush(emit);
      return;
    }

    let controller = channelPointsSlice.twitchChannelPointsPush;
    if (!controller) {
      try {
        controller = factory();
        channelPointsSlice.twitchChannelPointsPush = controller;
      } catch (error) {
        emitHostCallbackError(emit, "twitch", error, "Could not create the Twitch channel-points observer");
        return;
      }
    }

    drainTwitchChannelPointsPushEvents(controller, emit);
    try {
      await controller.start((notice) => {
        if (channelPointsSlice.twitchChannelPointsPush !== controller) return;
        queueTwitchChannelPointsPushClaim(notice);
      });
    } catch (error) {
      emitHostCallbackError(emit, "twitch", error, "Could not start the Twitch channel-points observer");
      if (channelPointsSlice.twitchChannelPointsPush === controller) channelPointsSlice.twitchChannelPointsPush = undefined;
    } finally {
      drainTwitchChannelPointsPushEvents(controller, emit);
    }

    if (
      channelPointsSlice.twitchChannelPointsPush !== controller
      || !signalSlice.discoverySignalLifecycleOpen
      || lifecycleSlice.controllerShutdown
    ) {
      if (channelPointsSlice.twitchChannelPointsPush === controller) channelPointsSlice.twitchChannelPointsPush = undefined;
      try {
        await controller.stop();
      } catch (error) {
        emitHostCallbackError(emit, "twitch", error, "Could not stop the Twitch channel-points observer");
      } finally {
        drainTwitchChannelPointsPushEvents(controller, emit);
      }
    }
  }

  async function reconcileTwitchChannelPointsPushFromSettings(settings: S): Promise<void> {
    await withEventCollector(async (emit, events) => {
      let adapter: PlatformAdapter | undefined;
      try {
        if (
          lifecycleSlice.controllerShutdown
          || !signalSlice.discoverySignalLifecycleOpen
          || !settings.platform.twitch.enabled
          || !autoClaimChannelPointsFor(settings, "twitch")
          || !settings.platform.twitch.channelPointsPushClaim
        ) {
          await stopTwitchChannelPointsPush(emit);
          return;
        }
        const state = await ports.storage.loadState();
        if (
          state.authHealth.twitch.status !== "healthy"
          || !eligibleTwitchChannelPointsChannel(settings, state)
        ) {
          await stopTwitchChannelPointsPush(emit);
          return;
        }
        adapter = createAdapter("twitch", settings, emit);
        await reconcileTwitchChannelPointsPush(settings, state, adapter, emit);
      } catch (error) {
        emitHostCallbackError(emit, "twitch", error, "Could not reconcile the Twitch channel-points observer");
        await stopTwitchChannelPointsPush(emit);
      } finally {
        adapter?.flushRouteDiagnostics?.(emit);
        await reportBestEffort(events);
      }
    });
  }

  function queueTwitchChannelPointsPushClaim(notice: TwitchChannelPointsClaimNotice): void {
    if (lifecycleSlice.controllerShutdown) return;
    if (channelPointsSlice.twitchChannelPointsClaimInFlight.has(notice.claimId)) return;
    channelPointsSlice.twitchChannelPointsClaimInFlight.add(notice.claimId);
    const run = withPlatformLock("twitch", () => withEventCollector(async (emit, events) => {
      try {
        if (channelPointsSlice.twitchChannelPointsPush) drainTwitchChannelPointsPushEvents(channelPointsSlice.twitchChannelPointsPush, emit);
        await claimTwitchChannelPointsFromPush(notice, emit);
      } finally {
        channelPointsSlice.twitchChannelPointsClaimInFlight.delete(notice.claimId);
        if (channelPointsSlice.twitchChannelPointsPush) drainTwitchChannelPointsPushEvents(channelPointsSlice.twitchChannelPointsPush, emit);
        await reportBestEffort(events);
      }
    }));
    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  async function claimTwitchChannelPointsFromPush(
    notice: TwitchChannelPointsClaimNotice,
    emit: EventEmitter,
  ): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
    if (!settings.platform.twitch.enabled
      || !autoClaimChannelPointsFor(settings, "twitch")
      || !settings.platform.twitch.channelPointsPushClaim
      || state.authHealth.twitch.status !== "healthy") return;
    const channel = eligibleTwitchChannelPointsChannel(settings, state);
    if (!channel) return;
    if (channel.channelId !== undefined && channel.channelId !== notice.channelId) return;
    if (!channelPointsSlice.twitchChannelPointsClaimInFlight.has(notice.claimId)) return;
    try {
      const adapter = createAdapter("twitch", settings, emit, true);
      const claimed = await claimExclusively(channelPointsSlice, "twitchChannelPointsClaimRunning", false, async () =>
        await adapter.claimChannelPoints?.(channel, {
          claimId: notice.claimId,
          channelId: notice.channelId,
        }) ?? false);
      if (claimed) {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "info",
          message: `Claimed channel points for ${channel.displayName ?? channel.username}`,
        });
      }
    } catch (error) {
      emit({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: error instanceof Error ? error.message : "Channel points claim failed",
      });
    }
  }

  async function runTwitchChannelPointsClaim(): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    await withPlatformLock("twitch", () => withEventCollector(async (emit, events) => {
      if (lifecycleSlice.controllerShutdown) return;
      if (channelPointsSlice.twitchChannelPointsPush?.subscribed) {
        drainTwitchChannelPointsPushEvents(channelPointsSlice.twitchChannelPointsPush, emit);
        await reportBestEffort(events);
        return;
      }
      const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
      if (!settings.platform.twitch.enabled
        || !autoClaimChannelPointsFor(settings, "twitch")
        || state.authHealth.twitch.status !== "healthy") return;
      const channel = eligibleTwitchChannelPointsChannel(settings, state);
      if (!channel) return;
      try {
        const adapter = createAdapter("twitch", settings, emit, true);
        const claimed = await claimExclusively(channelPointsSlice, "twitchChannelPointsClaimRunning", false, async () =>
          await adapter.claimChannelPoints?.(channel) ?? false);
        if (claimed) {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "info",
            message: `Claimed channel points for ${channel.displayName ?? channel.username}`,
          });
        }
      } catch (error) {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: error instanceof Error ? error.message : "Channel points claim failed",
        });
      } finally {
        await reportBestEffort(events);
      }
    }));
  }

  return {
    clearTwitchChannelPointsAlarmBestEffort,
    reconcileTwitchChannelPointsAlarm,
    stopTwitchChannelPointsPush,
    stopTwitchChannelPointsPushAndReport,
    stopTwitchChannelPointsPushInBackground,
    reconcileTwitchChannelPointsPush,
    runTwitchChannelPointsClaim,
  };
}
