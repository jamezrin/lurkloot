import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { isFarmingActive } from "@lurkloot/shared/settings";
import type { SelectionView, SnapshotSelectionResult } from "../core/scheduler";
import { syncManagedTabBreakers } from "../core/tabs";
import { recordManagedTabOpen } from "../core/criticalHealth";
import type { PlatformAdapter } from "../platforms/adapter";
import { adapterFromDiscoverySnapshot, selectionAdapterFromDiscoverySnapshot } from "../core/discoverySnapshot";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { AuthProbeSetupError } from "./errors";
import { correlateTickDiagnostics, farmingLifecycleEvents } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import { createTickEffectExecutor, runSchedulerTickEffects, tickCapabilities } from "./tickEffects";
import type {
  ClaimedRewards,
  CommittedSelection,
  ControllerCalls,
  HeartbeatPublicationLease,
  SelectionInput,
  TickAdapterHandle,
  TickDiagnosticContext,
  TickTrigger,
} from "./types";

// One platform tick: selection, the scheduler tick and what runs around it.
export function createTickRun<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { claimSlice, discoverySlice, tickSlice }: Pick<ControllerSlices<S>, "claimSlice" | "discoverySlice" | "tickSlice">,
  calls: Pick<ControllerCalls<S>,
    | "applyAdFocusForState"
    | "clearOperationalEvents"
    | "createTickAdapterHandle"
    | "diagnosticEvent"
    | "emitNotifications"
    | "flattenedRefreshFailures"
    | "persistPlatformAndReport"
    | "prepareSelection"
    | "prepareTwitchIntegrity"
    | "reconcileDiscoverySignalControllers"
    | "reconcilePageContextRecoveryAfterPersist"
    | "reconcileTablessWatchers"
    | "reconcileTwitchChannelPointsPush"
    | "refreshAuthHealth"
    | "refreshDiscovery"
    | "releaseHeartbeatPublicationLease"
    | "reportAuthSetupFailures"
    | "readState"
    | "reportBestEffort"
    | "reportUnsupportedSettings"
    | "selectionAlreadyCommitted"
    | "selectionBackoffDue"
    | "selectionBypassesBackoff"
    | "selectionIsForced"
    | "selectionKey"
    | "withEventCollector"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>, "tickPlatform"> {
  const {
    applyAdFocusForState,
    clearOperationalEvents,
    createTickAdapterHandle,
    diagnosticEvent,
    emitNotifications,
    flattenedRefreshFailures,
    persistPlatformAndReport,
    prepareSelection,
    prepareTwitchIntegrity,
    reconcileDiscoverySignalControllers,
    reconcilePageContextRecoveryAfterPersist,
    reconcileTablessWatchers,
    reconcileTwitchChannelPointsPush,
    refreshAuthHealth,
    refreshDiscovery,
    releaseHeartbeatPublicationLease,
    reportAuthSetupFailures,
    readState,
    reportBestEffort,
    reportUnsupportedSettings,
    selectionAlreadyCommitted,
    selectionBackoffDue,
    selectionBypassesBackoff,
    selectionIsForced,
    selectionKey,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);
  const supplementalSources = ports.twitch.supplementalSources;
  // One executor per controller: each scheduler effect type has one handler.
  const tickEffects = createTickEffectExecutor();

  async function tickPlatform(
    platform: Platform,
    trigger: TickTrigger,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<readonly [Platform, string[]]> {
    const abort = new AbortController();
    tickSlice.activeTicks.add(abort);
    tickSlice.activePlatformTicks[platform] += 1;
    const tickContext: TickDiagnosticContext = {
      globalTickId: ++tickSlice.globalTickSequence,
      platformTickId: ++tickSlice.platformTickSequence[platform],
    };
    const tickAdapters = { [platform]: createTickAdapterHandle(platform, tickContext) };
    const tickStartedAt = Date.now();
    diagnosticEvent(
      "debug",
      `Tick #${tickContext.platformTickId} started (trigger=${trigger}, platforms=${platform})`,
      platform,
      tickContext,
    );
    try {
      const claimed = await runTick(tickContext, [platform], abort.signal, trigger, tickAdapters, onPersisted);
      return [platform, claimed[platform] ?? []];
    } catch (error) {
      if (abort.signal.aborted) return [platform, []];
      throw error;
    } finally {
      if (platform === "kick") ports.kick.pageContextRecovery?.discardEvidence();
      for (const adapter of Object.values(tickAdapters)) adapter.close();
      tickSlice.activeTicks.delete(abort);
      tickSlice.activePlatformTicks[platform] -= 1;
      diagnosticEvent(
        "debug",
        `Tick #${tickContext.platformTickId} finished after ${Date.now() - tickStartedAt}ms (trigger=${trigger}, platforms=${platform})`,
        platform,
        tickContext,
      );
      await Promise.all(Object.values(tickAdapters).map((adapter) => adapter.settleRouteReports()));
    }
  }

  async function runTick(
    tickContext: TickDiagnosticContext,
    platforms: Platform[] | undefined,
    signal: AbortSignal,
    trigger: TickTrigger,
    tickAdapters: Partial<Record<Platform, TickAdapterHandle<S>>>,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<ClaimedRewards> {
    const claimedRewards: ClaimedRewards = {};
    const settings = await ports.storage.loadSettings();
    await reportUnsupportedSettings(settings, tickContext);
    const requestedPlatforms = platforms ?? PLATFORMS;
    const excludedPlatforms = new Set<Platform>();
    if (isFarmingActive(settings)) {
      if (requestedPlatforms.includes("twitch")) {
        const twitchReady = await prepareTwitchIntegrity(settings, signal, tickContext);
        if (!twitchReady) excludedPlatforms.add("twitch");
      }
      const authPlatforms = requestedPlatforms.filter((platform) => !excludedPlatforms.has(platform));
      if (authPlatforms.length > 0) {
        const authStartedAt = Date.now();
        try {
          await refreshAuthHealth(
            authPlatforms,
            settings,
            false,
            signal,
            tickContext,
            tickAdapters,
          );
          for (const platform of authPlatforms) {
            diagnosticEvent(
              "debug",
              `Tick #${tickContext.platformTickId} refreshed auth health in ${Date.now() - authStartedAt}ms`,
              platform,
              tickContext,
            );
          }
        } catch (error) {
          const failures = flattenedRefreshFailures(error);
          const setupFailures = failures.filter((failure): failure is AuthProbeSetupError =>
            failure instanceof AuthProbeSetupError);
          if (setupFailures.length === 0) throw error;
          for (const failure of setupFailures) excludedPlatforms.add(failure.platform);
          let reportingFailure: unknown;
          try {
            await reportAuthSetupFailures(setupFailures, tickContext);
          } catch (failure) {
            reportingFailure = failure;
          }
          const nonSetupFailures = failures.filter((failure) => !(failure instanceof AuthProbeSetupError));
          if (nonSetupFailures.length > 0) {
            if (reportingFailure !== undefined) {
              throw new AggregateError(
                [...failures, reportingFailure],
                "Authentication refresh and interruption persistence failed",
              );
            }
            throw error;
          }
          if (reportingFailure !== undefined) throw reportingFailure;
        }
      }
    }
    const schedulerPlatforms = requestedPlatforms.filter((platform) =>
      !excludedPlatforms.has(platform));
    if (schedulerPlatforms.length === 0) return claimedRewards;
    const currentState = await readState();
    const discoveryPlatforms = schedulerPlatforms.filter((platform) =>
      currentState.authHealth[platform].status === "healthy");
    // A ranking change re-selects from the discovery already held; only a
    // platform without one refreshes.
    const refreshPlatforms = trigger === "ranking_changed"
      ? discoveryPlatforms.filter((platform) => !discoverySlice.discoveryLanes[platform].current().snapshot)
      : discoveryPlatforms;
    await refreshDiscovery(refreshPlatforms, selectionBypassesBackoff(trigger), tickAdapters);
    signal.throwIfAborted();
    const preparedSelections: Partial<Record<Platform, CommittedSelection>> = {};
    await Promise.all(discoveryPlatforms.map(async (selectionPlatform) => {
      const snapshot = discoverySlice.discoveryLanes[selectionPlatform].current().snapshot;
      if (!snapshot) return;
      const input: SelectionInput<S> = {
        platform: selectionPlatform,
        trigger,
        snapshot,
        settings,
        state: currentState,
        key: selectionKey(selectionPlatform, snapshot, settings, currentState),
        force: selectionIsForced(trigger) || selectionBackoffDue(selectionPlatform, currentState),
        signal,
        generation: discoverySlice.selectionGeneration[selectionPlatform],
      };
      preparedSelections[selectionPlatform] = await prepareSelection(input);
    }));
    signal.throwIfAborted();
    const platform = schedulerPlatforms[0];
    await withStateLock(() => withEventCollector(async (emit, events) => {
      signal.throwIfAborted();
      const settings = await ports.storage.loadSettings();
      const state = await ports.storage.loadState();
      const nextWaitingClaimRewardIds: Record<Platform, Set<string>> = {
        twitch: new Set(claimSlice.waitingClaimRewardIds.twitch),
        kick: new Set(claimSlice.waitingClaimRewardIds.kick),
      };
      let nextState: SchedulerState;
      let publicationLeases: Array<readonly [Platform, HeartbeatPublicationLease]> = [];
      const pageContextRecoverySuccessPlatforms = new Set<Platform>();
      try {
        const adapters = Object.fromEntries(schedulerPlatforms.map((schedulerPlatform) => [
          schedulerPlatform,
          tickAdapters[schedulerPlatform]!.adapter(settings, emit, true),
        ])) as Record<Platform, PlatformAdapter>;
        for (const discoveryPlatform of schedulerPlatforms) {
          adapters[discoveryPlatform] = adapterFromDiscoverySnapshot(
            adapters[discoveryPlatform],
            discoverySlice.discoveryLanes[discoveryPlatform].current().snapshot,
            state.sessions[discoveryPlatform],
          );
        }
        const selections: Partial<Record<Platform, SnapshotSelectionResult>> = {};
        for (const selectionPlatform of schedulerPlatforms) {
          const snapshot = discoverySlice.discoveryLanes[selectionPlatform].current().snapshot;
          if (!snapshot) continue;
          const key = selectionKey(selectionPlatform, snapshot, settings, state);
          let prepared = preparedSelections[selectionPlatform];
          if (!prepared || prepared.key !== key || prepared.snapshotRevision !== snapshot.revision) {
            const committed = prepared
              ? selectionAlreadyCommitted(prepared, snapshot, state, selectionPlatform)
              : undefined;
            if (committed) {
              selections[selectionPlatform] = committed;
              continue;
            }
            if (prepared) {
              discoverySlice.discoveryEvents[selectionPlatform].push({
                category: "diagnostic",
                platform: selectionPlatform,
                level: "debug",
                message: `Snapshot selection discarded before commit (trigger=${trigger}, revision=${prepared.snapshotRevision})`,
              });
            }
            prepared = await prepareSelection({
              platform: selectionPlatform,
              trigger,
              snapshot,
              settings,
              state,
              key,
              force: selectionBackoffDue(selectionPlatform, state),
              signal,
              generation: discoverySlice.selectionGeneration[selectionPlatform],
            });
          }
          preparedSelections[selectionPlatform] = prepared;
          if (prepared.generation !== discoverySlice.selectionGeneration[selectionPlatform]) {
            discoverySlice.discoveryEvents[selectionPlatform].push({
              category: "diagnostic",
              platform: selectionPlatform,
              level: "debug",
              message: `Snapshot selection discarded before commit after lifecycle change (trigger=${trigger}, revision=${prepared.snapshotRevision})`,
            });
            continue;
          }
          selections[selectionPlatform] = prepared.result;
        }
        // Snapshot revision is the publication gate. Heartbeat and playback
        // health bump selectionGeneration without replacing discovery; dropping
        // the tick for those would discard lastCheckedAt from current inventory.
        const selectionsAreCurrent = (): boolean => schedulerPlatforms.every((selectionPlatform) => {
          const prepared = preparedSelections[selectionPlatform];
          const snapshot = discoverySlice.discoveryLanes[selectionPlatform].current().snapshot;
          return !prepared || prepared.snapshotRevision === snapshot?.revision;
        });
        const staleSelection = new Error("Snapshot selection lifecycle changed before publication");
        const assertSelectionsCurrent = (): void => {
          if (!selectionsAreCurrent()) throw staleSelection;
        };
        // Observed here rather than returned by the scheduler: the controller
        // already sees every emitted event, and the post-claim handoff only
        // needs to know which platforms claimed.
        const claimObservingEmit: EventEmitter = (event) => {
          if (event.category === "activity" && event.code === "reward_claimed" && event.platform) {
            (claimedRewards[event.platform] ??= []).push(event.data.rewardId);
          }
          emit(event);
        };
        const eventsBeforeTick = events.length;
        for (const discoveryPlatform of schedulerPlatforms) {
          for (const event of discoverySlice.discoveryEvents[discoveryPlatform].splice(0)) claimObservingEmit(event);
        }
        const result = await runSchedulerTickEffects({
          state,
          settings,
          platforms: schedulerPlatforms,
          supplementalSources: supplementalSources !== undefined,
          waitingClaimRewardIds: nextWaitingClaimRewardIds,
          emit: claimObservingEmit,
          signal,
          campaignEvaluationFingerprints: tickSlice.campaignEvaluationFingerprints,
          selections,
          selectionIsCurrent: Object.fromEntries(schedulerPlatforms.map((selectionPlatform) => {
            const prepared = preparedSelections[selectionPlatform];
            return [selectionPlatform, () => prepared?.snapshotRevision
              === discoverySlice.discoveryLanes[selectionPlatform].current().snapshot?.revision];
          })),
          discovery: Object.fromEntries(schedulerPlatforms.map((discoveryPlatform) => {
            const discoveryState = discoverySlice.discoveryLanes[discoveryPlatform].current();
            return [discoveryPlatform, {
              campaigns: discoveryState.snapshot?.campaigns.map(({ campaign }) => campaign)
                ?? state.campaigns[discoveryPlatform],
              complete: discoveryState.snapshot !== undefined,
              // A settings save threw this tick's refresh away; the save's own
              // follow-up tick refreshes again and decides.
              discarded: discoveryState.snapshot === undefined && discoveryState.lastAttempt?.discarded !== undefined,
            }];
          })),
          selectionViews: Object.fromEntries(schedulerPlatforms.map((selectionPlatform) => [
            selectionPlatform,
            selectionAdapterFromDiscoverySnapshot(
              discoverySlice.discoveryLanes[selectionPlatform].current().snapshot,
              state.sessions[selectionPlatform],
            ),
          ])) as Partial<Record<Platform, SelectionView>>,
          capabilities: Object.fromEntries(schedulerPlatforms.map((schedulerPlatform) => [
            schedulerPlatform,
            tickCapabilities(adapters[schedulerPlatform]),
          ])),
        }, tickEffects, {
          adapters,
          stopPageContextTabs: ports.tabs?.stopPageContextTabs,
          selectSupplementalTarget: supplementalSources
            ? (supplementalPlatform, selectedState, selectedSignal, source) => supplementalPlatform === "twitch"
              ? supplementalSources.select(selectedState, settings, selectedSignal, source)
              : Promise.resolve(undefined)
            : undefined,
        });
        for (const schedulerPlatform of schedulerPlatforms) {
          if (
            discoverySlice.discoveryLanes[schedulerPlatform].current().lastAttempt?.complete === true
            && (result.state.sessions[schedulerPlatform].errorChecks ?? 0) === 0
          ) {
            pageContextRecoverySuccessPlatforms.add(schedulerPlatform);
          }
        }
        signal.throwIfAborted();
        assertSelectionsCurrent();
        const lifecycleEvents = farmingLifecycleEvents(state, result.state);
        for (const event of lifecycleEvents) emit(event);
        await emitNotifications(settings, state, result.state, result.events);
        signal.throwIfAborted();
        assertSelectionsCurrent();
        await applyAdFocusForState(result.state, emit, schedulerPlatforms);
        signal.throwIfAborted();
        assertSelectionsCurrent();
        publicationLeases = await reconcileTablessWatchers(
          result.state,
          settings,
          adapters,
          emit,
          schedulerPlatforms,
        );
        signal.throwIfAborted();
        assertSelectionsCurrent();
        await reconcileDiscoverySignalControllers(result.state, settings, adapters, emit, schedulerPlatforms);
        if (schedulerPlatforms.includes("twitch")) {
          await reconcileTwitchChannelPointsPush(settings, result.state, adapters.twitch, emit);
        }
        for (const schedulerPlatform of schedulerPlatforms) tickAdapters[schedulerPlatform]?.drain(claimObservingEmit);
        signal.throwIfAborted();
        assertSelectionsCurrent();
        nextState = result.state;
        if (settings.criticalFailurePromptEnabled) {
          // Page-context tabs are created deep inside tabs.ts, which has no access
          // to scheduler state, and their events come from the adapters' own
          // emitter rather than the tick's. Reading them back off this tick's
          // collected events catches every emitter, not just the wrapped one.
          for (const event of events.slice(eventsBeforeTick)) {
            if (event.category !== "activity" || event.code !== "page_context_opened") continue;
            const transition = recordManagedTabOpen(nextState, event.platform, Date.now(), {
              source: "page_context",
              reason: event.data.reason,
            });
            nextState = transition.state;
            if (transition.event) emit(transition.event);
          }
          // Keep the registry that gates page-context creation in step with the
          // state we are about to persist, so the very next fetch is suppressed.
          syncManagedTabBreakers(nextState, schedulerPlatforms);
        }
      } catch (error) {
        // The tick was rolled back, so any partial claim set is not actionable.
        for (const key of Object.keys(claimedRewards) as Platform[]) delete claimedRewards[key];
        for (const schedulerPlatform of schedulerPlatforms) tickAdapters[schedulerPlatform]?.drain(emit);
        clearOperationalEvents(events);
        try {
          if (signal.aborted) return;
          if (error instanceof Error && error.message === "Snapshot selection lifecycle changed before publication") {
            await applyAdFocusForState(state, emit, schedulerPlatforms);
            publicationLeases.push(...await reconcileTablessWatchers(
              state,
              settings,
              Object.fromEntries(schedulerPlatforms.map((schedulerPlatform) => [
                schedulerPlatform,
                tickAdapters[schedulerPlatform]!.adapter(settings, emit, true),
              ])) as Record<Platform, PlatformAdapter>,
              emit,
              schedulerPlatforms,
            ));
            emit({ category: "diagnostic", level: "debug", platform, message: error.message });
            await reportBestEffort(correlateTickDiagnostics(events, tickContext));
            return;
          }
          const detail = error instanceof Error ? error.message : "Scheduler tick failed";
          emit({ category: "activity", code: "interruption", level: "error", platform, data: { reason: "platform_error", detail } });
          emit({ category: "diagnostic", level: "error", platform, message: detail });
          const persisted = await persistPlatformAndReport(platform, state, correlateTickDiagnostics(events, tickContext));
          if (persisted) {
            await reconcilePageContextRecoveryAfterPersist([platform], state, settings, new Set(), tickContext);
          }
        } finally {
          await Promise.all(publicationLeases.map(([leasePlatform, lease]) =>
            releaseHeartbeatPublicationLease(leasePlatform, lease)));
        }
        return;
      }
      try {
        const persisted = await persistPlatformAndReport(
          platform,
          nextState,
          correlateTickDiagnostics(events, tickContext),
          () => schedulerPlatforms.every((selectionPlatform) => {
            const prepared = preparedSelections[selectionPlatform];
            const snapshot = discoverySlice.discoveryLanes[selectionPlatform].current().snapshot;
            return !prepared || prepared.snapshotRevision === snapshot?.revision;
          }),
          onPersisted,
        );
        if (!persisted) return;
        await reconcilePageContextRecoveryAfterPersist(
          schedulerPlatforms,
          nextState,
          settings,
          pageContextRecoverySuccessPlatforms,
          tickContext,
        );
        claimSlice.waitingClaimRewardIds[platform].clear();
        for (const rewardId of nextWaitingClaimRewardIds[platform]) {
          claimSlice.waitingClaimRewardIds[platform].add(rewardId);
        }
      } finally {
        await Promise.all(publicationLeases.map(([leasePlatform, lease]) =>
          releaseHeartbeatPublicationLease(leasePlatform, lease)));
      }
    }, tickContext), schedulerPlatforms);
    return claimedRewards;
  }

  return {
    tickPlatform,
  };
}
