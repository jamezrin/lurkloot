import type { EventEmitter } from "@lurkloot/shared/events";
import type { ChatPresenceStatus, EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { chatPresenceDecision, type ChatPresenceClient, type ChatPresenceDecision } from "../core/chatPresence";
import { hasRecentManualWatch } from "../core/manualWatch";
import type { PlatformAdapter } from "../platforms/adapter";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError, platformLabel } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import { ObserverSlot } from "./observerSlot";
import type { StateTransaction } from "./stateTransaction";
import type { ControllerCalls } from "./types";

// Chat presence (docs/superpowers/specs/2026-10-05-chat-presence-design.md):
// one client per platform following the committed watch, reconciled like the
// discovery-signal observers. Presence never affects heartbeats.
export function createChatPresence<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  transaction: Pick<StateTransaction<S>, "onCommit" | "onTickConcluded">,
  { lifecycleSlice }: Pick<ControllerSlices<S>, "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "createAdapter"
    | "diagnosticEvent"
    | "reportBestEffort"
    | "withEventCollector"
    | "trackBackgroundWork"
  >,
): Pick<ControllerCalls<S>,
  | "chatPresenceEpochs"
  | "chatPresenceStatuses"
  | "stopChatPresenceAndReport"
  | "stopChatPresenceInBackground"
> {
  const { createAdapter, diagnosticEvent, reportBestEffort, withEventCollector, trackBackgroundWork } = lateBound(calls);
  const slots: Record<Platform, ObserverSlot<ChatPresenceClient>> = {
    twitch: new ObserverSlot<ChatPresenceClient>("twitch", "chat presence", "discard"),
    kick: new ObserverSlot<ChatPresenceClient>("kick", "chat presence", "discard"),
  };
  // "<provider>:<channel>" last announced per platform, so the provider
  // announcement is made once per presence session.
  const announced: Partial<Record<Platform, string>> = {};
  // Platforms already told that alwaysEnterChat has no effect on them.
  const reportedUnavailable = new Set<Platform>();
  // Platforms this controller has reconciled at least once. Until then a
  // running watch may predate it (an MV3 worker restart), so a commit may
  // start presence; afterwards ticks and settings saves keep it current, and
  // heartbeat commits cost nothing.
  const reconciled: Record<Platform, boolean> = { twitch: false, kick: false };
  // The last pauseOnManualWatch this service saw (ticks, settings saves), so
  // the commit hook can tell a manual watch that pauses farming without a
  // storage read. Unknown counts as the default, on.
  let pauseOnManualWatch: boolean | undefined;

  function observersOpen(): boolean {
    return lifecycleSlice.observersOpen && !lifecycleSlice.controllerShutdown;
  }

  async function reconcile(
    platform: Platform,
    settings: EngineSettings,
    state: SchedulerState,
    adapter: PlatformAdapter,
    emit: EventEmitter,
    since: number,
  ): Promise<void> {
    reconciled[platform] = true;
    pauseOnManualWatch = settings.pauseOnManualWatch;
    const decision = chatPresenceDecision(platform, settings, state, { capability: ports.capabilities.chatPresence });
    const factory = adapter.createChatPresenceClient;
    // Only the setting promises chat. A provider that needs presence the
    // platform cannot give says so on its own card.
    if (decision?.trigger.kind === "setting" && !factory && !reportedUnavailable.has(platform)) {
      reportedUnavailable.add(platform);
      emit({
        category: "diagnostic",
        platform,
        level: "warn",
        message: `Chat presence is not available for ${platformLabel(platform)}, so platform.${platform}.alwaysEnterChat has no effect`,
      });
    }
    await slots[platform].reconcile({
      wanted: decision !== undefined,
      factory,
      open: observersOpen,
      since,
      emit,
      start: (client) => client.follow(decision?.target),
    });
    announce(platform, decision, emit);
  }

  // Once per presence session, and only for a client the slot kept: a start
  // that backed off or failed announces nothing.
  function announce(platform: Platform, decision: ChatPresenceDecision | undefined, emit: EventEmitter): void {
    if (decision?.trigger.kind !== "provider" || !slots[platform].current) {
      announced[platform] = undefined;
      return;
    }
    const key = `${decision.trigger.providerId}:${decision.target.username}`;
    if (announced[platform] === key) return;
    announced[platform] = key;
    emit({
      category: "diagnostic",
      platform,
      level: "info",
      message: `Joining ${decision.target.username}'s chat because ${decision.trigger.providerId} needs chat presence to earn watch time`,
    });
  }

  // Every stop ends the presence session, so the next one is announced. Not
  // async: the slot's epoch has moved by the time this returns.
  function stopSlot(platform: Platform, emit: EventEmitter): Promise<void> {
    announced[platform] = undefined;
    return slots[platform].stop(emit);
  }

  async function stopChatPresence(platforms: readonly Platform[], emit: EventEmitter): Promise<void> {
    await Promise.all(platforms.map((platform) => stopSlot(platform, emit)));
  }

  async function stopChatPresenceAndReport(platforms: readonly Platform[]): Promise<void> {
    await withEventCollector(async (emit, events) => {
      await stopChatPresence(platforms, emit);
      await reportBestEffort(events);
    });
  }

  function stopChatPresenceInBackground(platforms: readonly Platform[]): void {
    const run = stopChatPresenceAndReport(platforms).catch((error) => {
      diagnosticEvent("warn", `Chat presence cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        platforms.length === 1 ? platforms[0] : undefined);
    });
    trackBackgroundWork(run);
  }

  function chatPresenceEpochs(platforms: readonly Platform[]): Partial<Record<Platform, number>> {
    return Object.fromEntries(platforms.map((platform) => [platform, slots[platform].epoch]));
  }

  function chatPresenceStatuses(): Partial<Record<Platform, ChatPresenceStatus>> {
    const statuses: Partial<Record<Platform, ChatPresenceStatus>> = {};
    for (const platform of PLATFORMS) {
      const client = slots[platform].current;
      if (client) statuses[platform] = client.status();
    }
    return statuses;
  }

  // A commit that leaves auth unhealthy (logout, rejected probe, an account
  // change being checked, #595) or ends the watch stops presence before any
  // await, so the old identity never stays in chat.
  //
  // After an MV3 worker restart, heartbeat recovery resumes a tabless watch
  // without a tick, and presence must not wait for the next one: the first
  // commit this controller sees for an already-running healthy tabless watch
  // reconciles it in the background. A watch that starts in a tick is
  // reconciled by the tick's conclusion instead.
  transaction.onCommit(async (change) => {
    // A host that cannot join chat never has a client to stop or start.
    if (change.kind !== "state" || !ports.capabilities.chatPresence) return;
    const { previous, state, committedAt } = change;
    const manuallyPaused = (value: SchedulerState, platform: Platform): boolean =>
      Boolean(value.manualClosePause?.[platform])
      || (pauseOnManualWatch !== false && hasRecentManualWatch(value, platform, committedAt));
    // Stopped whether or not a client exists yet: the stop bumps the slot's
    // epoch, so a reconcile that read the older state backs off (#595), as
    // the discovery-signal observers do.
    const stopping = change.platforms.filter((platform) =>
      state.authHealth[platform].status !== "healthy"
      || (previous.sessions[platform].status === "watching" && state.sessions[platform].status !== "watching")
      || (manuallyPaused(state, platform) && !manuallyPaused(previous, platform)));
    // Auth recovering on a running watch (an account check, a cookie change)
    // rejoins at once instead of waiting for the next tick.
    const missing = change.platforms.filter((platform) =>
      !stopping.includes(platform)
      && (!reconciled[platform] || previous.authHealth[platform].status !== "healthy")
      && slots[platform].current === undefined
      && state.authHealth[platform].status === "healthy"
      && previous.sessions[platform].status === "watching"
      && previous.sessions[platform].watchMode === "tabless"
      && state.sessions[platform].status === "watching"
      && state.sessions[platform].watchMode === "tabless");
    if (missing.length > 0) {
      // Read under the commit: a stop after this point makes `state` stale.
      const since = chatPresenceEpochs(missing);
      const run = reconcileFromCommit(missing, state, since).catch((error) => {
        diagnosticEvent("warn", `Chat presence reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      trackBackgroundWork(run);
    }
    if (stopping.length > 0) await stopChatPresenceAndReport(stopping);
  });

  async function reconcileFromCommit(
    platforms: readonly Platform[],
    state: SchedulerState,
    since: Partial<Record<Platform, number>>,
  ): Promise<void> {
    await withEventCollector(async (emit, events) => {
      try {
        const settings = await ports.storage.loadSettings();
        for (const platform of platforms) {
          if (!observersOpen()) return;
          reconciled[platform] = true;
          if (!chatPresenceDecision(platform, settings, state, { capability: ports.capabilities.chatPresence })) continue;
          const adapter = createAdapter(platform, settings, emit);
          try {
            await reconcile(platform, settings, state, adapter, emit, since[platform] ?? slots[platform].epoch);
          } finally {
            adapter.flushRouteDiagnostics?.(emit);
          }
        }
      } finally {
        await reportBestEffort(events);
      }
    });
  }

  // A settings save can switch a trigger on or off; follow it at once.
  transaction.onCommit((change) => {
    if (change.kind !== "settings" || change.startup || !ports.capabilities.chatPresence) return;
    pauseOnManualWatch = change.settings.pauseOnManualWatch;
    const run = reconcileFromSettings(change.settings).catch((error) => {
      diagnosticEvent("warn", `Chat presence reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    trackBackgroundWork(run);
  });

  async function reconcileFromSettings(settings: S): Promise<void> {
    await withEventCollector(async (emit, events) => {
      try {
        if (!observersOpen()) {
          await stopChatPresence(PLATFORMS, emit);
          return;
        }
        // Read before the state: a stop after this point makes it stale.
        const epochs = chatPresenceEpochs(PLATFORMS);
        const state = await ports.storage.loadState();
        for (const platform of PLATFORMS) {
          let adapter: PlatformAdapter | undefined;
          try {
            if (!observersOpen()) {
              await stopSlot(platform, emit);
              continue;
            }
            let since = epochs[platform] ?? slots[platform].epoch;
            if (!chatPresenceDecision(platform, settings, state, { capability: ports.capabilities.chatPresence })) {
              if (slots[platform].current) await stopSlot(platform, emit);
              continue;
            }
            // A blocked client never retries a rejected login by itself; a
            // save is the user acting, so it gets a fresh client. Ticks keep
            // it (a credential change or a restart also replaces it).
            if (slots[platform].current?.status().state === "blocked" && slots[platform].epoch === since) {
              const stopped = stopSlot(platform, emit);
              // The epoch has moved for our own stop; any later one still
              // makes the reconcile back off.
              since = slots[platform].epoch;
              await stopped;
            }
            adapter = createAdapter(platform, settings, emit);
            await reconcile(platform, settings, state, adapter, emit, since);
          } catch (error) {
            emitHostCallbackError(emit, platform, error, "Could not reconcile chat presence");
          } finally {
            adapter?.flushRouteDiagnostics?.(emit);
          }
        }
      } finally {
        await reportBestEffort(events);
      }
    });
  }

  // After a tick commits, with no lock held: presence follows the committed
  // watch. A stop since the commit bumps the epoch, so it backs off.
  transaction.onTickConcluded((tick) => {
    if (tick.signal.aborted || !ports.capabilities.chatPresence) return;
    tick.follow(withEventCollector(async (emit, events) => {
      for (const platform of tick.platforms) {
        try {
          await reconcile(platform, tick.settings, tick.state, tick.adapters[platform], emit,
            tick.observerEpochs.chatPresence[platform] ?? slots[platform].epoch);
        } catch (error) {
          diagnosticEvent("warn", `Chat presence reconcile failed: ${error instanceof Error ? error.message : String(error)}`, platform);
        }
      }
      await reportBestEffort(tick.correlate(events));
    }));
  });

  return { chatPresenceEpochs, chatPresenceStatuses, stopChatPresenceAndReport, stopChatPresenceInBackground };
}
