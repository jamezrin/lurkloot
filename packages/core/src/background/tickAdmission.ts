import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import type { BackgroundHostPorts } from "./hostPorts";
import type {
  ClaimedRewards,
  ControllerCalls,
  DiscoverySignalRefreshRequest,
  PlatformTickResult,
  TickBatch,
  TickRequest,
  TickTrigger,
} from "./types";

// Tick admission: one active tick and one shared follow-up per platform, batches and hand-offs.
export function createTickAdmission<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { reportingSlice, integritySlice, signalSlice, tickSlice, lifecycleSlice }: Pick<ControllerSlices<S>,
    | "reportingSlice"
    | "integritySlice"
    | "signalSlice"
    | "tickSlice"
    | "lifecycleSlice"
  >,
  calls: Pick<ControllerCalls<S>,
    | "diagnosticEvent"
    | "discoverySignalRefreshAllowed"
    | "runClaimHandoff"
    | "saveOperationalState"
    | "selectionBypassesBackoff"
    | "selectionIsForced"
    | "startPendingDiscoverySignalRefresh"
    | "tickPlatform"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>,
  | "tickTriggerSummary"
  | "cancelPendingTick"
  | "retainCurrentTickReasons"
  | "requestTickBatch"
  | "tick"
  | "abortActiveTicks"
  | "tickInBackground"
  | "settleBackgroundWork"
  | "markPlatformsStarting"
  | "tickAndHandOff"
  | "completeTickAndHandOff"
> {
  const {
    diagnosticEvent,
    discoverySignalRefreshAllowed,
    runClaimHandoff,
    saveOperationalState,
    selectionBypassesBackoff,
    selectionIsForced,
    startPendingDiscoverySignalRefresh,
    tickPlatform,
    withStateLock,
  } = lateBound(calls);

  function tickTriggerSummary(reasons: TickRequest["reasons"]): string {
    const entries = Object.entries(reasons);
    const count = entries.reduce((total, [, count]) => total + count, 0);
    return `count=${count}, reasons=${entries.map(([reason, count]) => `${reason}:${count}`).join(",")}`;
  }

  function cancelPendingTick(platform: Platform): void {
    const pending = tickSlice.tickAdmission[platform].pending;
    tickSlice.tickAdmission[platform].pending = undefined;
    if (pending) {
      diagnosticEvent("debug", `Discarded pending scheduler triggers after lifecycle change (${tickTriggerSummary(pending.reasons)})`, platform);
      pending.resolve([platform, []]);
    }
  }

  function retainCurrentTickReasons(platform: Platform, request: TickRequest): boolean {
    const signal = request.discoverySignal;
    if (signal && !discoverySignalRefreshAllowed(platform, signal)) {
      const remaining = (request.reasons.discovery_signal ?? 0) - signal.count;
      if (remaining > 0) request.reasons.discovery_signal = remaining;
      else delete request.reasons.discovery_signal;
      request.discoverySignal = undefined;
      diagnosticEvent("debug", `Discarded stale scheduler discovery signals (${tickTriggerSummary({ discovery_signal: signal.count })})`, platform);
    }
    const reasons = Object.keys(request.reasons) as TickTrigger[];
    if (reasons.length === 0) return false;
    request.trigger = reasons.reduce((selected, trigger) =>
      tickTriggerPriority(trigger) > tickTriggerPriority(selected) ? trigger : selected);
    return true;
  }

  function mergeDiscoverySignal(request: TickRequest, signal: DiscoverySignalRefreshRequest): void {
    request.reasons.discovery_signal = (request.reasons.discovery_signal ?? 0) + signal.count;
    request.discoverySignal = { ...signal, count: (request.discoverySignal?.count ?? 0) + signal.count };
  }

  function admitPlatformTick(platform: Platform, trigger: TickTrigger, discoverySignal?: DiscoverySignalRefreshRequest): Promise<PlatformTickResult> {
    if (lifecycleSlice.controllerShutdown || tickSlice.tickAdmissionSuspended) return Promise.resolve([platform, []]);
    const lane = tickSlice.tickAdmission[platform];
    if (lane.pending) {
      if (discoverySignal) mergeDiscoverySignal(lane.pending, discoverySignal);
      else lane.pending.reasons[trigger] = (lane.pending.reasons[trigger] ?? 0) + 1;
      if (tickTriggerPriority(trigger) > tickTriggerPriority(lane.pending.trigger)) {
        lane.pending.trigger = trigger;
      }
      return lane.pending.promise;
    }
    let resolve!: TickRequest["resolve"];
    let reject!: TickRequest["reject"];
    const promise = new Promise<PlatformTickResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const request: TickRequest = { trigger, reasons: {}, promise, resolve, reject };
    if (discoverySignal) mergeDiscoverySignal(request, discoverySignal);
    else request.reasons[trigger] = 1;
    if (lane.active) lane.pending = request;
    else executePlatformTick(platform, request);
    return promise;
  }

  function tickTriggerPriority(trigger: TickTrigger): number {
    // Existing trigger semantics are nested: bypass-backoff also forces
    // selection; startup only forces selection. Other user actions persist
    // their mutations before admission, so fresh settings/state retain them.
    // Equal-priority reasons keep their first trigger and all diagnostic counts.
    if (selectionBypassesBackoff(trigger)) return 3;
    if (selectionIsForced(trigger)) return 2;
    // A ranking change (or a superseded tick's retry) is lowest too: merged
    // with anything that needs fresh discovery, that trigger wins and the tick
    // refreshes.
    return trigger === "alarm" || trigger === "discovery_signal" || trigger === "unknown" || trigger === "ranking_changed" || trigger === "tick_superseded" ? 0 : 1;
  }

  function executePlatformTick(platform: Platform, request: TickRequest): void {
    // Signal setup can yield before admission. Its controller/generation must
    // still be current when the admitted request finally owns the platform.
    if (!retainCurrentTickReasons(platform, request)) {
      request.resolve([platform, []]);
      startPendingDiscoverySignalRefresh(platform);
      return;
    }
    const lane = tickSlice.tickAdmission[platform];
    lane.active = request;
    let committed: PlatformTickResult[2];
    void tickPlatform(platform, request.trigger, (state) => { committed = { state, sequence: ++tickSlice.tickCommitSequence }; })
      .then(([platform, rewards]) => request.resolve([platform, rewards, committed]), request.reject)
      .finally(() => {
        lane.active = undefined;
        const pending = lane.pending;
        lane.pending = undefined;
        if (pending) {
          const signalRequest = signalSlice.discoverySignalRefreshPending[platform];
          if (signalRequest && discoverySignalRefreshAllowed(platform, signalRequest)) {
            mergeDiscoverySignal(pending, signalRequest);
            signalSlice.discoverySignalRefreshPending[platform] = undefined;
          }
          diagnosticEvent("debug", `Coalesced scheduler triggers (${tickTriggerSummary(pending.reasons)})`, platform);
          executePlatformTick(platform, pending);
        } else startPendingDiscoverySignalRefresh(platform);
      });
  }

  function requestTickBatch(platforms: Platform[] | undefined, trigger: TickTrigger, discoverySignal?: DiscoverySignalRefreshRequest): TickBatch {
    const requests = [...new Set(platforms ?? PLATFORMS)].sort().map((platform) => admitPlatformTick(platform, trigger, discoverySignal));
    for (const batch of tickSlice.tickBatches) {
      if (batch.requests.length === requests.length && batch.requests.every((request, index) => request === requests[index])) return batch;
    }
    const batch: TickBatch = { requests, settled: Promise.allSettled(requests) };
    tickSlice.tickBatches.add(batch);
    void batch.settled.then(() => tickSlice.tickBatches.delete(batch));
    return batch;
  }

  function tick(
    platforms?: Platform[],
    trigger: TickTrigger = "unknown",
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<ClaimedRewards> {
    const batch = requestTickBatch(platforms, trigger);
    if (onPersisted) return completeTickBatch(batch, onPersisted);
    return batch.claimed ??= completeTickBatch(batch);
  }

  async function completeTickBatch(batch: TickBatch, onPersisted?: (state: SchedulerState) => void): Promise<ClaimedRewards> {
    const settled = await batch.settled;
    const commits = settled.flatMap((result) => result.status === "fulfilled" && result.value[2] ? [result.value[2]] : []);
    for (const commit of commits.sort((left, right) => left.sequence - right.sequence)) onPersisted?.(commit.state);
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Platform scheduler ticks failed");
    }
    return settled.reduce<ClaimedRewards>((claimed, result) => {
      if (result.status !== "fulfilled") return claimed;
      const [platform, rewards] = result.value;
      if (rewards.length > 0) claimed[platform] = rewards;
      return claimed;
    }, {});
  }

  function abortActiveTicks(reason: string): void {
    for (const platform of PLATFORMS) cancelPendingTick(platform);
    for (const controller of tickSlice.activeTicks) {
      controller.abort(new Error(reason));
    }
  }

  // Runs a tick without holding the caller open for it. A user action gets its
  // snapshot back immediately; the popup re-polls getSnapshot on its own cadence
  // and picks the result up when the tick lands.
  function tickInBackground(
    platforms: Platform[] | undefined,
    trigger: TickTrigger,
    onCompleted?: () => void,
  ): void {
    if (lifecycleSlice.controllerShutdown) return;
    const run = tickAndHandOff(platforms, trigger)
      .then(() => onCompleted?.())
      .catch((error) => {
        const platform = platforms?.length === 1 ? platforms[0] : undefined;
        diagnosticEvent("warn", `Background tick (trigger=${trigger}) failed: ${error instanceof Error ? error.message : String(error)}`, platform);
      });
    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  // Detached ticks have no caller to await them, which leaves observers (tests,
  // and the CLI's one-shot mode) with no way to know when the work they just
  // triggered has actually landed. Settling drains the chain until it stops
  // growing, so a tick that queues a post-claim handoff is covered too.
  async function settleBackgroundWork(): Promise<void> {
    await integritySlice.initialTwitchIntegrityLoad;
    let pending = tickSlice.backgroundWork;
    for (;;) {
      await pending;
      await Promise.allSettled([...reportingSlice.pendingRouteReports]);
      if (tickSlice.backgroundWork === pending && reportingSlice.pendingRouteReports.size === 0) return;
      pending = tickSlice.backgroundWork;
    }
  }

  // The persisted session still describes the platform as it was *before* the
  // toggle, and nothing rewrites it until the tick finishes. Detaching the tick
  // alone would not fix that: the popup polls stored state, so a slow tick can
  // leave it rendering a lifecycle that contradicts the switch the user just
  // flipped. Persist the typed transition up front instead.
  async function markPlatformsStarting(
    platforms: readonly Platform[],
    transitionIsCurrent: () => boolean = () => true,
  ): Promise<void> {
    await withStateLock(async () => {
      const state = await ports.storage.loadState();
      if (!transitionIsCurrent()) return;
      let changed = false;
      const sessions = { ...state.sessions };
      for (const platform of platforms) {
        const session = state.sessions[platform];
        // An already-watching platform is not "starting" — leave its live status
        // (and its channel) alone so a toggle elsewhere never blanks it.
        if (session.status === "watching") continue;
        sessions[platform] = {
          ...session,
          status: "starting",
          message: "Starting automation",
          reasonCode: "no_existing_session",
        };
        changed = true;
      }
      if (!changed) return;
      if (!transitionIsCurrent()) return;
      await saveOperationalState({ ...state, sessions });
      if (!transitionIsCurrent()) {
        await saveOperationalState(state);
      }
    });
  }

  // The normal entry point for alarm- and message-driven ticks: run the tick,
  // then hand off for every platform that claimed. Kept separate from tick() so
  // the handoff's own inner ticks cannot recurse into another handoff.
  function tickAndHandOff(
    platforms?: Platform[],
    trigger: TickTrigger = "unknown",
  ): Promise<SchedulerState | undefined> {
    const batch = requestTickBatch(platforms, trigger);
    return batch.handoff ??= completeTickAndHandOff(batch);
  }

  async function completeTickAndHandOff(batch: TickBatch): Promise<SchedulerState | undefined> {
    let committedState: SchedulerState | undefined;
    const captureCommittedState = (state: SchedulerState): void => {
      committedState = state;
    };
    const claimed = await completeTickBatch(batch, captureCommittedState);
    const results = await Promise.all((Object.keys(claimed) as Platform[]).map((platform) => {
      return completePlatformHandoff(batch, platform, claimed[platform] ?? []);
    }));
    for (const state of results) {
      if (state) committedState = state;
    }
    return committedState;
  }

  async function completePlatformHandoff(
    batch: TickBatch,
    platform: Platform,
    claimedRewardIds: readonly string[],
  ): Promise<SchedulerState | undefined> {
    const settled = await batch.settled;
    const index = settled.findIndex((result) => result.status === "fulfilled" && result.value[0] === platform);
    if (index < 0) return undefined;
    const request = batch.requests[index];
    const existing = tickSlice.tickRequestHandoffs.get(request);
    if (existing) return existing;
    let committedState = settled[index].status === "fulfilled" ? settled[index].value[2]?.state : undefined;
    const handoff = runClaimHandoff(platform, claimedRewardIds, (state) => {
      committedState = state;
    }).catch((error) => {
      diagnosticEvent(
        "warn",
        `Post-claim handoff failed: ${error instanceof Error ? error.message : String(error)}`,
        platform,
      );
    }).then(() => committedState);
    tickSlice.tickRequestHandoffs.set(request, handoff);
    return handoff;
  }

  return {
    tickTriggerSummary,
    cancelPendingTick,
    retainCurrentTickReasons,
    requestTickBatch,
    tick,
    abortActiveTicks,
    tickInBackground,
    settleBackgroundWork,
    markPlatformsStarting,
    tickAndHandOff,
    completeTickAndHandOff,
  };
}
