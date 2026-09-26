import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import {
  campaignSearchBackoffApplies,
  isPlaybackTelemetryHealthy,
  preserveClaimedRewards,
  selectWatchTargetFromSnapshot,
  type SnapshotSelectionResult,
} from "../core/scheduler";
import {
  collectDiscoverySnapshot,
  DiscoverySnapshotLane,
  type DiscoverySnapshot,
  type DiscoverySnapshotState,
} from "../core/discoverySnapshot";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, type DiscoverySlice, lateBound } from "./context";
import type {
  BackgroundControllerDeps,
  CommittedSelection,
  ControllerCalls,
  SelectionInput,
  TickAdapterHandle,
  TickTrigger,
} from "./types";

// Discovery lanes and snapshot selection.
export function createDiscovery<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { lifecycleSlice }: Pick<ControllerSlices<S>, "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "createAdapter"
    | "withEventCollector"
    | "withSettingsLock"
    | "withStateCommit"
  >,
): Pick<ControllerCalls<S>,
  | "selectionFingerprint"
  | "refreshDiscovery"
  | "discoverySnapshot"
  | "selectionKey"
  | "selectionIsForced"
  | "selectionBypassesBackoff"
  | "selectionBackoffDue"
  | "invalidateSelection"
  | "prepareSelection"
  | "selectionAlreadyCommitted"
> & { discoverySlice: DiscoverySlice<S> } {
  const { createAdapter, withEventCollector, withSettingsLock, withStateCommit } = lateBound(calls);

  // Created here rather than in context.ts: each lane refreshes through this
  // module's createDiscoveryLane.
  const discoverySlice: DiscoverySlice<S> = {
    discoveryEvents: { twitch: [], kick: [] },
    discoveryLanes: {
      twitch: createDiscoveryLane("twitch"),
      kick: createDiscoveryLane("kick"),
    },
    discoveryBackoffBypasses: { twitch: 0, kick: 0 },
    selectionCache: {},
    selectionRuns: {},
    pendingSelections: {},
    selectionGeneration: { twitch: 0, kick: 0 },
  };

  const selectionFingerprint = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  function createDiscoveryLane(platform: Platform): DiscoverySnapshotLane<TickAdapterHandle<S> | undefined> {
    return new DiscoverySnapshotLane<TickAdapterHandle<S> | undefined>(
      platform,
      async ({ signal, request: tickAdapter }) => {
        const [settings, state] = await withSettingsLock(() => withStateCommit(() =>
          Promise.all([deps.loadSettings(), deps.loadState()])));
        if (!settings.platform[platform].enabled) {
          return {
            campaigns: [],
            idleCandidates: [],
            followedChannels: [],
            complete: false,
            failure: "Platform disabled",
            metrics: { campaigns: 0, candidates: 0, cacheHits: 0, cacheMisses: 0, batchRequests: 0, singleFallbacks: 0 },
          };
        }
        return withEventCollector(async (emit, events) => {
          const adapter = tickAdapter?.adapter(settings, emit, true)
            ?? createAdapter(platform, settings, emit, true);
          try {
            return await collectDiscoverySnapshot(
              adapter,
              state.sessions[platform],
              signal,
              Date.now,
              settings.preferKnownChannels,
              settings.platform[platform].idleWatchlistChannels
                .map((username) => username.trim().toLowerCase())
                .filter(Boolean)
                .map((username) => ({
                  platform,
                  username,
                  displayName: username,
                  url: platform === "twitch"
                    ? `https://www.twitch.tv/${username}`
                    : `https://kick.com/${username}`,
                })),
              (campaign, campaigns) => {
                const backoff = state.campaignSearchBackoffs?.[platform];
                if (!campaignSearchBackoffApplies(
                  campaign,
                  settings,
                  state.sessions[platform],
                  backoff,
                  discoverySlice.discoveryBackoffBypasses[platform] > 0,
                  campaigns.find((candidate) => candidate.id === state.sessions[platform].campaignId),
                )) return undefined;
                return discoverySlice.discoveryLanes[platform].current().snapshot?.campaigns
                  .find(({ campaign: previous }) => previous.id === campaign.id)
                  ?.candidates ?? [];
              },
              settings,
              (campaigns) => preserveClaimedRewards(campaigns, state.campaigns[platform]),
            );
          } finally {
            tickAdapter?.drain(emit);
            if (!tickAdapter) adapter.flushRouteDiagnostics?.(emit);
            discoverySlice.discoveryEvents[platform].push(...events);
          }
        });
      },
      async (discoveryState) => queueDiscoveryAttempt(platform, discoveryState),
    );
  }

  function queueDiscoveryAttempt(
    platform: Platform,
    discoveryState: Readonly<DiscoverySnapshotState>,
  ): void {
    const attempt = discoveryState.lastAttempt;
    if (!attempt) return;
    const snapshot = discoveryState.snapshot;
    const metrics = attempt.metrics;
    const duration = attempt.finishedAt - attempt.startedAt;
    const age = snapshot ? Math.max(0, Date.now() - snapshot.observedAt) : 0;
    const outcome = attempt.discarded
      ? `discarded=${attempt.discarded}`
      : attempt.complete
        ? "complete"
        : `incomplete (${attempt.failure ?? "unknown failure"})`;
    const workMetrics = metrics
      ? `campaigns=${metrics.campaigns}, skipped before channel work=${metrics.skippedBeforeChannelWork ?? 0}, candidates=${metrics.candidates}, unique channel checks=${metrics.uniqueChannelChecks ?? 0}, cache hits=${metrics.cacheHits}, cache misses=${metrics.cacheMisses}, batch requests=${metrics.batchRequests}, single fallbacks=${metrics.singleFallbacks}`
      : "work metrics=unavailable";
    discoverySlice.discoveryEvents[platform].push({
      category: "diagnostic",
      platform,
      level: attempt.complete ? "debug" : "warn",
      message: `Discovery refresh finished in ${duration}ms (${outcome}, revision=${snapshot?.revision ?? 0}, age=${age}ms, coalesced=${attempt.coalesced}, ${workMetrics})`,
    });
    if (attempt.complete && snapshot) {
      discoverySlice.discoveryEvents[platform].push({
        category: "diagnostic",
        platform,
        level: "debug",
        message: `Campaign refresh finished in ${duration}ms (${snapshot.metrics.campaigns} ${snapshot.metrics.campaigns === 1 ? "campaign" : "campaigns"})`,
      });
    }
  }

  async function refreshDiscovery(
    platforms: Platform[] = PLATFORMS,
    bypassBackoff = false,
    tickAdapters?: Partial<Record<Platform, TickAdapterHandle<S>>>,
  ): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    const settings = await deps.loadSettings();
    await Promise.all(platforms.map(async (platform) => {
      if (bypassBackoff) discoverySlice.discoveryBackoffBypasses[platform] += 1;
      try {
        if (!settings.platform[platform].enabled) {
          discoverySlice.discoveryLanes[platform].invalidate();
          invalidateSelection(platform);
          return;
        }
        await discoverySlice.discoveryLanes[platform].requestAndWait(tickAdapters?.[platform]);
      } finally {
        if (bypassBackoff) discoverySlice.discoveryBackoffBypasses[platform] -= 1;
      }
    }));
  }

  function discoverySnapshot(platform: Platform): Readonly<DiscoverySnapshotState> {
    return discoverySlice.discoveryLanes[platform].current();
  }

  function selectionKey(platform: Platform, snapshot: DiscoverySnapshot, settings: S, state: SchedulerState): string {
    const session = state.sessions[platform];
    return JSON.stringify({
      discovery: {
        campaigns: snapshot.campaigns.map(({ campaign, candidates }) => ({
          campaign,
          candidates: candidates.map(({ observedAt: _observedAt, ...candidate }) => candidate),
        })),
        idleCandidates: snapshot.idleCandidates.map(({ observedAt: _observedAt, ...candidate }) => candidate),
        followedChannels: snapshot.followedChannels,
      },
      persistedCampaigns: state.campaigns[platform],
      campaignSearchBackoff: state.campaignSearchBackoffs?.[platform],
      settings,
      target: {
        status: session.status,
        channel: session.channel,
        campaignId: session.campaignId,
        rewardId: session.rewardId,
        watchMode: session.watchMode,
        offlineChecks: session.offlineChecks,
        playbackHealthy: session.playback ? isPlaybackTelemetryHealthy(session.playback) : undefined,
        playbackChecks: session.playbackChecks,
        heartbeatChecks: session.heartbeatChecks,
        lastHeartbeatOk: session.lastHeartbeatOk,
        noProgressChecks: session.noProgressChecks,
        lastWatchedMinutes: session.lastWatchedMinutes,
      },
    });
  }

  function selectionIsForced(trigger: TickTrigger): boolean {
    return trigger === "manual_tick" || trigger === "manual_resume" || trigger === "claim_handoff" || trigger === "startup";
  }

  function selectionBypassesBackoff(trigger: TickTrigger): boolean {
    return trigger === "manual_tick" || trigger === "manual_resume" || trigger === "claim_handoff";
  }

  function selectionBackoffDue(platform: Platform, state: SchedulerState): boolean {
    const retryAt = state.campaignSearchBackoffs?.[platform]?.retryAt;
    return retryAt !== undefined && Date.parse(retryAt) <= Date.now();
  }

  function invalidateSelection(platform: Platform): void {
    discoverySlice.selectionGeneration[platform] += 1;
    delete discoverySlice.selectionCache[platform];
    delete discoverySlice.pendingSelections[platform];
  }

  async function evaluateSelection(input: SelectionInput<S>): Promise<CommittedSelection> {
    const startedAt = Date.now();
    const result = await (deps.selectWatchTarget ?? selectWatchTargetFromSnapshot)({
      snapshot: input.snapshot,
      previous: input.state.sessions[input.platform],
      previousCampaigns: input.state.campaigns[input.platform],
      settings: input.settings,
      signal: input.signal,
      previousBackoff: input.state.campaignSearchBackoffs?.[input.platform],
      bypassBackoff: selectionBypassesBackoff(input.trigger),
    });
    discoverySlice.discoveryEvents[input.platform].push({
      category: "diagnostic",
      platform: input.platform,
      level: "debug",
      message: `Snapshot selection finished in ${Date.now() - startedAt}ms (trigger=${input.trigger}, revision=${input.snapshot.revision}, age=${Math.max(0, Date.now() - input.snapshot.observedAt)}ms, material=${discoverySlice.selectionCache[input.platform]?.key !== input.key}, campaigns=${result.campaignsChecked}, candidates=${result.candidatesChecked}, outcome=${result.decision.action}, retention=${result.retention.reasonCode})`,
    });
    if (result.backoffSkippedMs !== undefined && result.backoff) {
      discoverySlice.discoveryEvents[input.platform].push({
        category: "diagnostic",
        platform: input.platform,
        level: "debug",
        message: `Skipped authoritative negative campaign search for ${result.backoff.campaignId} (${result.backoffSkippedMs}ms remaining)`,
      });
    } else if (result.backoff && input.state.campaignSearchBackoffs?.[input.platform]?.fingerprint !== result.backoff.fingerprint) {
      discoverySlice.discoveryEvents[input.platform].push({
        category: "diagnostic",
        platform: input.platform,
        level: "debug",
        message: `Authoritative negative campaign search for ${result.backoff.campaignId}; retry at ${result.backoff.retryAt}`,
      });
    }
    return { key: input.key, snapshotRevision: input.snapshot.revision, generation: input.generation, result };
  }

  async function prepareSelection(input: SelectionInput<S>): Promise<CommittedSelection> {
    const cached = discoverySlice.selectionCache[input.platform];
    if (!input.force && cached?.key === input.key && cached.generation === input.generation) {
      discoverySlice.discoveryEvents[input.platform].push({
        category: "diagnostic",
        platform: input.platform,
        level: "debug",
        message: `Snapshot selection skipped (trigger=${input.trigger}, revision=${input.snapshot.revision}, age=${Math.max(0, Date.now() - input.snapshot.observedAt)}ms, material=false)`,
      });
      const retryAt = cached.result.backoff ? Date.parse(cached.result.backoff.retryAt) : Number.NaN;
      if (cached.result.backoff && Number.isFinite(retryAt) && retryAt > Date.now()) {
        discoverySlice.discoveryEvents[input.platform].push({
          category: "diagnostic",
          platform: input.platform,
          level: "debug",
          message: `Skipped authoritative negative campaign search for ${cached.result.backoff.campaignId} (${retryAt - Date.now()}ms remaining)`,
        });
      }
      const reused = {
        ...cached,
        snapshotRevision: input.snapshot.revision,
        generation: input.generation,
      };
      discoverySlice.selectionCache[input.platform] = reused;
      return reused;
    }
    const running = discoverySlice.selectionRuns[input.platform];
    if (running) {
      discoverySlice.pendingSelections[input.platform] = input;
      return running;
    }
    const run = (async () => {
      let current = input;
      while (true) {
        const evaluated = await evaluateSelection(current);
        const pending = discoverySlice.pendingSelections[current.platform];
        delete discoverySlice.pendingSelections[current.platform];
        if (!pending) {
          if (current.generation === discoverySlice.selectionGeneration[current.platform]) {
            discoverySlice.selectionCache[current.platform] = evaluated;
          } else {
            discoverySlice.discoveryEvents[current.platform].push({
              category: "diagnostic",
              platform: current.platform,
              level: "debug",
              message: `Snapshot selection discarded stale lifecycle work (trigger=${current.trigger}, revision=${current.snapshot.revision})`,
            });
          }
          return evaluated;
        }
        discoverySlice.discoveryEvents[current.platform].push({
          category: "diagnostic",
          platform: current.platform,
          level: "debug",
          message: `Snapshot selection discarded stale work (trigger=${current.trigger}, revision=${current.snapshot.revision})`,
        });
        current = pending;
      }
    })();
    discoverySlice.selectionRuns[input.platform] = run;
    try {
      return await run;
    } finally {
      if (discoverySlice.selectionRuns[input.platform] === run) delete discoverySlice.selectionRuns[input.platform];
    }
  }

  function selectionAlreadyCommitted(
    prepared: CommittedSelection,
    snapshot: DiscoverySnapshot,
    state: SchedulerState,
    platform: Platform,
  ): SnapshotSelectionResult | undefined {
    if (prepared.snapshotRevision !== snapshot.revision) return undefined;
    if (prepared.generation !== discoverySlice.selectionGeneration[platform]) return undefined;
    const session = state.sessions[platform];
    const decision = prepared.result.decision;
    const action = session.status === "watching"
      ? session.campaignId ? "watch" : "fallback"
      : "idle";
    if (action !== decision.action
      || session.campaignId !== decision.campaign?.id
      || session.rewardId !== decision.reward?.id
      || session.channel?.url !== decision.channel?.url) return undefined;
    return {
      ...prepared.result,
      decision: {
        ...decision,
        reason: "Keeping already committed snapshot selection",
        reasonCode: "keeping_current_watch",
      },
      retention: {
        keep: true,
        offlineChecks: session.offlineChecks,
        playbackChecks: session.playbackChecks ?? 0,
        noProgressChecks: session.noProgressChecks,
        lastWatchedMinutes: session.lastWatchedMinutes,
        channel: session.channel,
        reason: "Keeping already committed snapshot selection",
        reasonCode: "keeping_current_watch",
      },
      campaignsChecked: 0,
      candidatesChecked: 0,
      fastPath: true,
    };
  }

  return {
    discoverySlice,
    selectionFingerprint,
    refreshDiscovery,
    discoverySnapshot,
    selectionKey,
    selectionIsForced,
    selectionBypassesBackoff,
    selectionBackoffDue,
    invalidateSelection,
    prepareSelection,
    selectionAlreadyCommitted,
  };
}
