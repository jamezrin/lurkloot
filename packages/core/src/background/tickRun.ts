import type { EngineSettings, Platform, SchedulerState, WatchSession, WatchSourceId } from "@lurkloot/shared/models";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import { isFarmingActive } from "@lurkloot/shared/settings";
import type { SchedulerTickResult, SelectionView, SnapshotSelectionResult } from "../core/scheduler";
import { syncManagedTabBreakers } from "../core/tabs";
import { recordManagedTabOpen } from "../core/criticalHealth";
import type { PlatformAdapter } from "../platforms/adapter";
import { adapterFromDiscoverySnapshot, selectionAdapterFromDiscoverySnapshot } from "../core/discoverySnapshot";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { AuthProbeSetupError } from "./errors";
import { correlateTickDiagnostics, farmingLifecycleEvents } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import { rebaseTickState, tickEffectFacts } from "./tickCommit";
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
  { claimSlice, discoverySlice, tickSlice, kickChallengeSlice, channelPointsSlice }: Pick<ControllerSlices<S>,
    "claimSlice" | "discoverySlice" | "tickSlice" | "kickChallengeSlice" | "channelPointsSlice">,
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
    | "stateRevision"
    | "tickInBackground"
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
    stateRevision,
    tickInBackground,
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
    // A ranking change, or a retry after a superseded tick, re-selects from the
    // discovery already held; only a platform without one refreshes.
    const refreshPlatforms = trigger === "ranking_changed" || trigger === "tick_superseded"
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
    const staleSelection = new Error("Snapshot selection lifecycle changed before publication");
    // Three steps (#599). Under the platform lock, read the state and settings
    // the tick decides from and settle its selections. With no lock held, run
    // the scheduler tick and every effect it names. Under the lock again,
    // rebase the result on whatever else committed meanwhile, then publish.
    await withEventCollector(async (emit, events) => {
      const nextWaitingClaimRewardIds: Record<Platform, Set<string>> = {
        twitch: new Set(claimSlice.waitingClaimRewardIds.twitch),
        kick: new Set(claimSlice.waitingClaimRewardIds.kick),
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
      // Snapshot revision is the publication gate. Heartbeat and playback
      // health bump selectionGeneration without replacing discovery; dropping
      // the tick for those would discard lastCheckedAt from current inventory.
      const selectionsAreCurrent = (): boolean => schedulerPlatforms.every((selectionPlatform) => {
        const prepared = preparedSelections[selectionPlatform];
        const snapshot = discoverySlice.discoveryLanes[selectionPlatform].current().snapshot;
        return !prepared || prepared.snapshotRevision === snapshot?.revision;
      });

      let decided: {
        settings: S;
        state: SchedulerState;
        revision: number;
        adapters: Record<Platform, PlatformAdapter>;
        selections: Partial<Record<Platform, SnapshotSelectionResult>>;
      } | undefined;
      let failure: { error: unknown } | undefined;
      await withStateLock(async () => {
        signal.throwIfAborted();
        const settings = await ports.storage.loadSettings();
        const revision = stateRevision();
        const state = await ports.storage.loadState();
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
          decided = { settings, state, revision, adapters, selections };
        } catch (error) {
          failure = { error };
          decided = { settings, state, revision, adapters: {} as Record<Platform, PlatformAdapter>, selections: {} };
        }
      }, schedulerPlatforms);
      const { settings, state, revision, adapters, selections } = decided!;
      // What storage holds now: the tick's own read, unless something saved since.
      const loadLatest = async (): Promise<SchedulerState> =>
        stateRevision() === revision ? state : await ports.storage.loadState();

      // The effects run here, with no lock held. The context is built outside
      // every lock body: nothing the tick asks for may wait on one.
      const effectContext = {
        adapters,
        stopPageContextTabs: ports.tabs?.stopPageContextTabs,
        selectSupplementalTarget: supplementalSources
          ? (supplementalPlatform: Platform, selectedState: SchedulerState, selectedSignal: AbortSignal | undefined, source: WatchSourceId) =>
            supplementalPlatform === "twitch"
              ? supplementalSources.select(selectedState, settings, selectedSignal, source)
              : Promise.resolve(undefined)
          : undefined,
        claimGuards: {
          rewards: claimSlice.rewardClaimGuards,
          challenges: kickChallengeSlice,
          channelPoints: channelPointsSlice,
        },
      };
      const eventsBeforeTick = events.length;
      let result: SchedulerTickResult | undefined;
      if (!failure) {
        try {
          for (const discoveryPlatform of schedulerPlatforms) {
            for (const event of discoverySlice.discoveryEvents[discoveryPlatform].splice(0)) claimObservingEmit(event);
          }
          result = await runSchedulerTickEffects({
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
          }, tickEffects, effectContext);
        } catch (error) {
          failure = { error };
        }
      }

      // Facts from a tick whose decision did not commit: what it claimed and
      // the managed tab it closed are recorded; a tab it opened is closed below.
      let openedTab: WatchSession | undefined;
      let superseded = false;
      let publicationLeases: Array<readonly [Platform, HeartbeatPublicationLease]> = [];
      await withStateLock(async () => {
        // Drops the tick's decision and its events, keeping only the activity
        // of claims that happened, which rollBack returns.
        const rollBack = (): EngineEvent[] => {
          const factEvents = events.slice(eventsBeforeTick).filter((event) => event.category === "activity"
            && (event.code === "reward_claimed" || event.code === "challenge_claimed"));
          // The tick was rolled back, so any partial claim set is not actionable.
          for (const key of Object.keys(claimedRewards) as Platform[]) delete claimedRewards[key];
          for (const schedulerPlatform of schedulerPlatforms) tickAdapters[schedulerPlatform]?.drain(emit);
          clearOperationalEvents(events);
          return factEvents;
        };
        const commitFacts = async (latest: SchedulerState, reason: string, factEvents: readonly EngineEvent[]): Promise<void> => {
          const facts = result ? tickEffectFacts(result.state, state, latest, platform) : { state: latest };
          openedTab = facts.openedTab;
          for (const event of factEvents) emit(event);
          emit({ category: "diagnostic", level: "debug", platform, message: reason });
          await persistPlatformAndReport(platform, facts.state, correlateTickDiagnostics(events, tickContext));
        };
        let latest: SchedulerState | undefined;
        let nextState: SchedulerState;
        const pageContextRecoverySuccessPlatforms = new Set<Platform>();
        try {
          if (failure) throw failure.error;
          signal.throwIfAborted();
          latest = await loadLatest();
          if (!selectionsAreCurrent()) throw staleSelection;
          const rebased = rebaseTickState(result!.state, state, latest, platform);
          if (rebased.status === "conflict") {
            superseded = true;
            await commitFacts(latest, `Tick superseded before publication: ${rebased.reason}`, rollBack());
            return;
          }
          const tickState = rebased.state;
          for (const schedulerPlatform of schedulerPlatforms) {
            if (
              discoverySlice.discoveryLanes[schedulerPlatform].current().lastAttempt?.complete === true
              && (tickState.sessions[schedulerPlatform].errorChecks ?? 0) === 0
            ) {
              pageContextRecoverySuccessPlatforms.add(schedulerPlatform);
            }
          }
          const assertSelectionsCurrent = (): void => {
            if (!selectionsAreCurrent()) throw staleSelection;
          };
          const lifecycleEvents = farmingLifecycleEvents(latest, tickState);
          for (const event of lifecycleEvents) emit(event);
          await emitNotifications(settings, latest, tickState, result!.events);
          signal.throwIfAborted();
          assertSelectionsCurrent();
          await applyAdFocusForState(tickState, emit, schedulerPlatforms);
          signal.throwIfAborted();
          assertSelectionsCurrent();
          publicationLeases = await reconcileTablessWatchers(
            tickState,
            settings,
            adapters,
            emit,
            schedulerPlatforms,
          );
          signal.throwIfAborted();
          assertSelectionsCurrent();
          await reconcileDiscoverySignalControllers(tickState, settings, adapters, emit, schedulerPlatforms);
          if (schedulerPlatforms.includes("twitch")) {
            await reconcileTwitchChannelPointsPush(settings, tickState, adapters.twitch, emit);
          }
          for (const schedulerPlatform of schedulerPlatforms) tickAdapters[schedulerPlatform]?.drain(claimObservingEmit);
          signal.throwIfAborted();
          assertSelectionsCurrent();
          nextState = tickState;
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
          try {
            if (signal.aborted) {
              rollBack();
              return;
            }
            latest ??= await loadLatest();
            if (error === staleSelection) {
              const factEvents = rollBack();
              await applyAdFocusForState(latest, emit, schedulerPlatforms);
              publicationLeases.push(...await reconcileTablessWatchers(
                latest,
                settings,
                Object.fromEntries(schedulerPlatforms.map((schedulerPlatform) => [
                  schedulerPlatform,
                  tickAdapters[schedulerPlatform]!.adapter(settings, emit, true),
                ])) as Record<Platform, PlatformAdapter>,
                emit,
                schedulerPlatforms,
              ));
              await commitFacts(latest, staleSelection.message, factEvents);
              return;
            }
            rollBack();
            const detail = error instanceof Error ? error.message : "Scheduler tick failed";
            emit({ category: "activity", code: "interruption", level: "error", platform, data: { reason: "platform_error", detail } });
            emit({ category: "diagnostic", level: "error", platform, message: detail });
            const persisted = await persistPlatformAndReport(platform, latest, correlateTickDiagnostics(events, tickContext));
            if (persisted) {
              await reconcilePageContextRecoveryAfterPersist([platform], latest, settings, new Set(), tickContext);
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
            selectionsAreCurrent,
            onPersisted,
          );
          if (!persisted) {
            // The selection went stale while committing. The claims still
            // stand, and so does the post-claim handoff they trigger.
            const claimed = { ...claimedRewards };
            const factEvents = rollBack();
            Object.assign(claimedRewards, claimed);
            await commitFacts(await loadLatest(), staleSelection.message, factEvents);
            return;
          }
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
      }, schedulerPlatforms);

      // Outside the lock again: close a tab only the superseded decision
      // wanted, and let a fresh tick decide from the state that won.
      if (openedTab && !signal.aborted) {
        try {
          await tickEffects.run({ type: "stopWatchTab", platform, session: openedTab }, { ...effectContext, emit, signal });
        } catch (error) {
          emit({ category: "diagnostic", level: "warn", platform, message: error instanceof Error ? error.message : "Could not stop watch tab" });
          await reportBestEffort(correlateTickDiagnostics(events, tickContext));
        }
      }
      if (superseded) tickInBackground([platform], "tick_superseded");
    }, tickContext);
    return claimedRewards;
  }

  return {
    tickPlatform,
  };
}
