import type {
  ChannelCandidate,
  ChannelCheck,
  DropCampaign,
  EngineSettings,
  Platform,
  WatchSession,
} from "@lurkloot/shared/models";
import { evaluateCampaignFarming } from "@lurkloot/shared/campaignFarming";
import { campaignForWatching } from "@lurkloot/shared/categories";
import {
  channelCandidateForLogin,
  type CandidateChannelSelection,
  type ChannelCheckRequest,
  type KnownChannelChecks,
  type PlatformAdapter,
} from "../platforms/adapter";
import { errorMessage } from "@lurkloot/shared/errors";

export type ChannelEligibility = true | false | "unknown";

export interface DiscoveryCandidateObservation {
  candidate: ChannelCandidate;
  live: boolean;
  categoryMatches: boolean;
  // ChannelCheck.offlineConfirmed, kept so retention reads it from the snapshot.
  offlineConfirmed?: true;
  eligible: ChannelEligibility;
  observedAt: number;
}

export interface DiscoveryCampaignObservation {
  campaign: DropCampaign;
  candidates: DiscoveryCandidateObservation[];
}

export interface DiscoveryRefreshMetrics {
  campaigns: number;
  skippedBeforeChannelWork?: number;
  uniqueChannelChecks?: number;
  candidates: number;
  cacheHits: number;
  cacheMisses: number;
  batchRequests: number;
  singleFallbacks: number;
}

export interface DiscoverySnapshot {
  platform: Platform;
  revision: number;
  observedAt: number;
  campaigns: DiscoveryCampaignObservation[];
  idleCandidates: DiscoveryCandidateObservation[];
  followedChannels: string[];
  complete: true;
  metrics: DiscoveryRefreshMetrics;
}

export interface DiscoveryAttempt {
  startedAt: number;
  finishedAt: number;
  complete: boolean;
  failure?: string;
  // What the refresh threw, kept so the tick can feed it to the critical-failure
  // detector with its SafeFetchError breadcrumb. Absent for a discarded refresh
  // and for an incomplete result that did not throw (platform disabled).
  error?: unknown;
  discarded?: "stale_generation" | "stopped";
  coalesced: number;
  metrics?: DiscoveryRefreshMetrics;
}

export interface DiscoverySnapshotState {
  snapshot?: DiscoverySnapshot;
  lastAttempt?: DiscoveryAttempt;
}

export interface DiscoveryRefreshResult {
  campaigns: DiscoveryCampaignObservation[];
  idleCandidates: DiscoveryCandidateObservation[];
  followedChannels: string[];
  complete: boolean;
  failure?: string;
  metrics: DiscoveryRefreshMetrics;
}

export interface DiscoveryRefreshContext<TRequest = undefined> {
  generation: number;
  signal: AbortSignal;
  request: TRequest;
}

export type DiscoverySnapshotListener = (
  state: Readonly<DiscoverySnapshotState>,
) => void | Promise<void>;

export async function collectDiscoverySnapshot(
  adapter: Pick<
    PlatformAdapter,
    | "platform"
    | "refreshCampaigns"
    | "listCandidateChannels"
    | "checkChannel"
    | "checkChannels"
    | "selectCandidateChannel"
    | "listFollowedChannels"
    | "knownChannelLimit"
    | "prepareKnownChannelChecks"
  >,
  session: Parameters<PlatformAdapter["refreshCampaigns"]>[0],
  signal: AbortSignal,
  now: () => number = Date.now,
  preferKnownChannels = true,
  idleCandidates: ChannelCandidate[] = [],
  retainedCampaignCandidates?: (
    campaign: DropCampaign,
    campaigns: DropCampaign[],
  ) => DiscoveryCandidateObservation[] | undefined,
  settings?: EngineSettings,
  reconcileCampaigns: (campaigns: DropCampaign[]) => DropCampaign[] = (campaigns) => campaigns,
): Promise<DiscoveryRefreshResult> {
  // Both operations belong to this refresh's fetch-observation lifecycle. Drain
  // the pair even when inventory fails before a followed-channel fallback ends.
  const [campaignResult, followedResult] = await Promise.allSettled([
    adapter.refreshCampaigns(session, { signal, requireComplete: true }),
    preferKnownChannels
      ? (adapter.listFollowedChannels?.({ signal, requireComplete: true }) ?? Promise.resolve([]))
      : Promise.resolve([]),
  ]);
  signal.throwIfAborted();
  if (campaignResult.status === "rejected") throw campaignResult.reason;
  if (followedResult.status === "rejected") throw followedResult.reason;
  const campaigns = reconcileCampaigns(campaignResult.value);
  const followedChannels = followedResult.value;
  const excluded = new Set(settings?.platform[adapter.platform].excludedChannels);
  const knownChannels = new Map<string, ChannelCandidate>();
  if (preferKnownChannels) {
    const limit = adapter.knownChannelLimit ?? 100;
    for (const candidate of idleCandidates) {
      if (knownChannels.size >= limit) break;
      const login = candidate.username.toLowerCase();
      if (!excluded.has(login)) knownChannels.set(login, candidate);
    }
    for (const username of followedChannels) {
      if (knownChannels.size >= limit) break;
      const login = username.trim().toLowerCase();
      if (login && !excluded.has(login) && !knownChannels.has(login)) {
        knownChannels.set(login, channelCandidateForLogin(adapter.platform, login));
      }
    }
  }
  const observations: DiscoveryCampaignObservation[] = [];
  const batchRequestsToCheck: ChannelCheckRequest[] = [];
  const batchRecorders: Array<(check: ChannelCheck) => void> = [];
  let candidatesChecked = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let batchRequests = 0;
  let singleFallbacks = 0;
  let skippedBeforeChannelWork = 0;
  let uniqueBatchChannelChecks = 0;
  const checkedLogins = new Set<string>();
  const bestEffortLogins = new Set<string>();
  let knownChecks: KnownChannelChecks | undefined;
  const precheckedStreams = new Map<string, ChannelCheck>();
  const recordSelection = (selection: CandidateChannelSelection): ChannelCheck[] => {
    cacheHits += selection.metrics?.cacheHits ?? 0;
    cacheMisses += selection.metrics?.cacheMisses ?? 0;
    batchRequests += selection.metrics?.batchRequests ?? 0;
    singleFallbacks += selection.metrics?.singleFallbacks ?? 0;
    return (
      selection.observations
      ?? (selection.channel
        ? [{ live: true, categoryMatches: true, candidate: selection.channel }]
        : [])
    );
  };
  const recordChecks = (selection: CandidateChannelSelection): ChannelCheck[] => {
    candidatesChecked += selection.checked;
    const checks = recordSelection(selection);
    for (const check of checks) checkedLogins.add(check.candidate.username.toLowerCase());
    return checks;
  };
  const observe = (
    check: ChannelCheck,
    campaign?: DropCampaign,
  ): DiscoveryCandidateObservation => ({
    candidate: check.candidate,
    live: check.live,
    categoryMatches: check.categoryMatches,
    ...(check.offlineConfirmed ? { offlineConfirmed: true as const } : {}),
    eligible: campaign ? (check.campaignMatches ?? "unknown") : "unknown",
    observedAt: now(),
  });
  const passes = (check: ChannelCheck) =>
    check.live && check.categoryMatches && check.campaignMatches !== false;
  const eligibilityTime = now();
  for (const campaign of campaigns) {
    signal.throwIfAborted();
    if (
      settings
      && !evaluateCampaignFarming(campaign, settings, { now: eligibilityTime }).farmable
    ) {
      observations.push({ campaign, candidates: [] });
      skippedBeforeChannelWork += 1;
      continue;
    }
    const retainedCandidates = retainedCampaignCandidates?.(campaign, campaigns);
    if (retainedCandidates) {
      observations.push({ campaign, candidates: retainedCandidates });
      continue;
    }
    // A campaign that spans several categories is looked up and checked in the
    // allowed ones only (#904).
    const watchCampaign = settings
      ? campaignForWatching(campaign, settings.platform[campaign.platform])
      : campaign;
    const listedCandidates = await adapter.listCandidateChannels(watchCampaign, {
      signal,
      requireComplete: true,
    });
    const includeKnown = !campaign.allowedChannels?.length && knownChannels.size > 0;
    const listed = new Map<string, ChannelCandidate>();
    const current = session?.campaignId === campaign.id ? session.channel : undefined;
    for (const candidate of current ? [current, ...listedCandidates] : listedCandidates) {
      const login = candidate.username.toLowerCase();
      if (!excluded.has(login)) listed.set(login, candidate);
    }
    const knownOnly = includeKnown
      ? [...knownChannels].filter(([login]) => !listed.has(login))
      : [];
    const observed: DiscoveryCandidateObservation[] = [];
    if (adapter.checkChannels) {
      for (const [login, candidate] of listed) {
        batchRequestsToCheck.push({
          channel: candidate,
          campaign: watchCampaign,
          ...(includeKnown && knownChannels.has(login) ? { alwaysCheck: true } : {}),
        });
        batchRecorders.push((check) => observed.push(observe(check, watchCampaign)));
      }
      for (const [login, candidate] of knownOnly) {
        bestEffortLogins.add(login);
        batchRequestsToCheck.push({
          channel: candidate,
          campaign: watchCampaign,
          alwaysCheck: true,
          bestEffort: true,
        });
        batchRecorders.push((check) => {
          if (passes(check)) observed.push(observe(check, watchCampaign));
        });
      }
    } else if (adapter.selectCandidateChannel) {
      if (knownOnly.length && !knownChecks && adapter.prepareKnownChannelChecks) {
        const candidates = [...knownChannels.values()];
        knownChecks = await adapter.prepareKnownChannelChecks(candidates, { signal });
        // The one-off stream pass counts actual attempted logins, including
        // failed entries. Reusing its evidence adds no unique checks.
        for (const candidate of candidates.slice(0, knownChecks.streams.checked)) {
          checkedLogins.add(candidate.username.toLowerCase());
        }
        for (const check of recordSelection(knownChecks.streams)) {
          precheckedStreams.set(check.candidate.username.toLowerCase(), check);
        }
      }
      if (knownChecks && knownOnly.length) {
        const streams = knownOnly.flatMap(([login]) => precheckedStreams.get(login) ?? []);
        const selection = await knownChecks.checkCampaign(watchCampaign, streams);
        for (const check of recordChecks(selection)) observed.push(observe(check, watchCampaign));
      }
      const selection = await adapter.selectCandidateChannel([...listed.values()], watchCampaign, {
        signal,
        precheckedStreams,
      });
      for (const check of recordChecks(selection)) observed.push(observe(check, watchCampaign));
    } else {
      for (const [login, candidate] of listed) {
        signal.throwIfAborted();
        const check = await adapter.checkChannel(candidate, { campaign: watchCampaign, signal });
        candidatesChecked += 1;
        checkedLogins.add(login);
        observed.push(observe(check, watchCampaign));
        if (!(includeKnown && knownChannels.has(login)) && passes(check)) break;
      }
    }
    observations.push({ campaign, candidates: observed });
  }
  const observedIdleCandidates: DiscoveryCandidateObservation[] = [];
  if (adapter.checkChannels) {
    for (const candidate of idleCandidates) {
      batchRequestsToCheck.push({
        channel: candidate,
        ...(bestEffortLogins.has(candidate.username.toLowerCase()) ? { bestEffort: true } : {}),
      });
      batchRecorders.push((check) => observedIdleCandidates.push(observe(check)));
    }
    const batch = await adapter.checkChannels(batchRequestsToCheck, {
      signal,
      requireComplete: true,
    });
    signal.throwIfAborted();
    if (batch.checks.length !== batchRequestsToCheck.length)
      throw new Error("Channel discovery batch was incomplete");
    uniqueBatchChannelChecks = batch.uniqueChannelChecks;
    const satisfiedCampaigns = new Set<string>();
    for (const [index, request] of batchRequestsToCheck.entries()) {
      const check = batch.checks[index];
      if (!check) {
        if (request.bestEffort) continue;
        if (
          request.alwaysCheck
          || !request.campaign
          || !satisfiedCampaigns.has(request.campaign.id)
        ) {
          throw new Error("Channel discovery batch was incomplete");
        }
        continue;
      }
      candidatesChecked += 1;
      if (request.campaign && !request.alwaysCheck && passes(check)) {
        satisfiedCampaigns.add(request.campaign.id);
      }
      batchRecorders[index]!(check);
    }
  } else if (adapter.selectCandidateChannel) {
    // Failed optional probes have no idle evidence either. Do not retry them
    // through the ordinary path just because a login also occurs in the Watchlist.
    const idleToCheck = knownChecks
      ? idleCandidates.filter((candidate) => {
          const login = candidate.username.toLowerCase();
          return !knownChannels.has(login) || precheckedStreams.has(login);
        })
      : idleCandidates;
    const selection = await adapter.selectCandidateChannel(idleToCheck, undefined, {
      signal,
      precheckedStreams,
    });
    observedIdleCandidates.push(...recordChecks(selection).map((check) => observe(check)));
  } else {
    for (const candidate of idleCandidates) {
      signal.throwIfAborted();
      const check = await adapter.checkChannel(candidate, { signal });
      candidatesChecked += 1;
      checkedLogins.add(candidate.username.toLowerCase());
      observedIdleCandidates.push(observe(check));
    }
  }
  signal.throwIfAborted();
  return {
    campaigns: observations,
    idleCandidates: observedIdleCandidates,
    followedChannels,
    complete: true,
    metrics: {
      campaigns: campaigns.length,
      skippedBeforeChannelWork,
      uniqueChannelChecks: adapter.checkChannels ? uniqueBatchChannelChecks : checkedLogins.size,
      candidates: candidatesChecked,
      cacheHits,
      cacheMisses,
      batchRequests,
      singleFallbacks,
    },
  };
}

export function adapterFromDiscoverySnapshot(
  adapter: PlatformAdapter,
  snapshot: DiscoverySnapshot | undefined,
  session?: WatchSession,
): PlatformAdapter {
  const campaigns = new Map(
    (snapshot?.campaigns ?? []).map((observation) => [observation.campaign.id, observation]),
  );
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "campaignScopedCandidates") return true;
      if (property === "listCandidateChannels") {
        return async (campaign: DropCampaign): Promise<ChannelCandidate[]> =>
          campaigns.get(campaign.id)?.candidates.map(({ candidate }) => candidate) ?? [];
      }
      if (property === "selectCandidateChannel") return undefined;
      if (property === "listFollowedChannels") {
        return async (): Promise<string[]> => [...(snapshot?.followedChannels ?? [])];
      }
      if (property === "checkChannel") {
        return async (candidate: ChannelCandidate, options?: { campaign?: DropCampaign }) => {
          const observations = options?.campaign
            ? (campaigns.get(options.campaign.id)?.candidates ?? [])
            : (snapshot?.idleCandidates ?? []);
          const observation = observations.find(
            ({ candidate: observed }) =>
              observed.username.toLowerCase() === candidate.username.toLowerCase(),
          );
          if (!observation) {
            const currentChannel = session?.channel;
            if (
              options?.campaign
              && session?.campaignId === options.campaign.id
              && currentChannel
              && currentChannel.username.toLowerCase() === candidate.username.toLowerCase()
            ) {
              return { live: true, categoryMatches: true, candidate: currentChannel };
            }
            return { live: false, categoryMatches: false, candidate };
          }
          return {
            live: observation.live,
            categoryMatches: observation.categoryMatches,
            campaignMatches: observation.eligible === "unknown" ? undefined : observation.eligible,
            candidate: observation.candidate,
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Without a snapshot it knows no channel: only the current watch's own channel
// still reads as live for its campaign.
export function selectionAdapterFromDiscoverySnapshot(
  snapshot: DiscoverySnapshot | undefined,
  session?: WatchSession,
): Pick<
  PlatformAdapter,
  | "listCandidateChannels"
  | "campaignScopedCandidates"
  | "selectCandidateChannel"
  | "checkChannel"
  | "listFollowedChannels"
> {
  const campaigns = new Map(
    (snapshot?.campaigns ?? []).map((observation) => [observation.campaign.id, observation]),
  );
  return {
    campaignScopedCandidates: true,
    listCandidateChannels: async (campaign) =>
      campaigns.get(campaign.id)?.candidates.map(({ candidate }) => candidate) ?? [],
    selectCandidateChannel: undefined,
    listFollowedChannels: async () => [...(snapshot?.followedChannels ?? [])],
    checkChannel: async (candidate, options) => {
      const observations = options?.campaign
        ? (campaigns.get(options.campaign.id)?.candidates ?? [])
        : (snapshot?.idleCandidates ?? []);
      const observation = observations.find(
        ({ candidate: observed }) =>
          observed.username.toLowerCase() === candidate.username.toLowerCase(),
      );
      if (!observation) {
        const currentChannel = session?.channel;
        if (
          options?.campaign
          && session?.campaignId === options.campaign.id
          && currentChannel
          && currentChannel.username.toLowerCase() === candidate.username.toLowerCase()
        ) {
          return { live: true, categoryMatches: true, candidate: currentChannel };
        }
        return { live: false, categoryMatches: false, candidate };
      }
      return {
        live: observation.live,
        ...(observation.offlineConfirmed ? { offlineConfirmed: true } : {}),
        categoryMatches: observation.categoryMatches,
        campaignMatches: observation.eligible === "unknown" ? undefined : observation.eligible,
        candidate: observation.candidate,
      };
    },
  };
}

export class DiscoverySnapshotLane<TRequest = undefined> {
  private state: DiscoverySnapshotState = {};
  private generation = 0;
  private revision = 0;
  private running = false;
  private pending = false;
  private pendingCount = 0;
  private pendingRequest?: TRequest;
  private stopped = false;
  private abort?: AbortController;
  private settled: Promise<void> = Promise.resolve();

  constructor(
    readonly platform: Platform,
    private readonly refresh: (
      context: DiscoveryRefreshContext<TRequest>,
    ) => Promise<DiscoveryRefreshResult>,
    private readonly onState?: DiscoverySnapshotListener,
    private readonly now: () => number = Date.now,
  ) {}

  current(): Readonly<DiscoverySnapshotState> {
    return this.state;
  }

  request(request?: TRequest): void {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      this.pendingCount += 1;
      this.pendingRequest = request as TRequest;
      return;
    }
    this.running = true;
    const run = this.runLoop(request as TRequest);
    this.settled = run.then(
      () => undefined,
      () => undefined,
    );
  }

  async requestAndWait(request?: TRequest): Promise<void> {
    this.request(request);
    await this.settle();
  }

  invalidate(): void {
    this.generation += 1;
    this.pending = false;
    this.pendingCount = 0;
    this.abort?.abort();
    this.state = {};
  }

  stop(): void {
    this.stopped = true;
    this.invalidate();
  }

  async settle(): Promise<void> {
    await this.settled;
  }

  private async runLoop(initialRequest: TRequest): Promise<void> {
    let request = initialRequest;
    try {
      do {
        this.pending = false;
        const coalesced = this.pendingCount;
        this.pendingCount = 0;
        await this.runOnce(coalesced, request);
        if (this.pending) request = this.pendingRequest as TRequest;
      } while (this.pending && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(coalesced: number, request: TRequest): Promise<void> {
    const generation = this.generation;
    const startedAt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const result = await this.refresh({ generation, signal: abort.signal, request });
      const finishedAt = this.now();
      if (this.stopped || generation !== this.generation) {
        this.state = {
          ...this.state,
          lastAttempt: {
            startedAt,
            finishedAt,
            complete: false,
            discarded: this.stopped ? "stopped" : "stale_generation",
            coalesced,
            metrics: result.metrics,
          },
        };
      } else if (!result.complete) {
        this.state = {
          ...this.state,
          lastAttempt: {
            startedAt,
            finishedAt,
            complete: false,
            failure: result.failure ?? "Discovery refresh was incomplete",
            coalesced,
            metrics: result.metrics,
          },
        };
      } else {
        this.state = {
          snapshot: {
            platform: this.platform,
            revision: ++this.revision,
            observedAt: finishedAt,
            campaigns: result.campaigns,
            idleCandidates: result.idleCandidates,
            followedChannels: result.followedChannels,
            complete: true,
            metrics: result.metrics,
          },
          lastAttempt: {
            startedAt,
            finishedAt,
            complete: true,
            coalesced,
            metrics: result.metrics,
          },
        };
      }
    } catch (error) {
      const finishedAt = this.now();
      this.state = {
        ...this.state,
        lastAttempt: {
          startedAt,
          finishedAt,
          complete: false,
          failure: errorMessage(error),
          ...(this.stopped || generation !== this.generation
            ? { discarded: this.stopped ? ("stopped" as const) : ("stale_generation" as const) }
            : { error }),
          coalesced,
        },
      };
    } finally {
      if (this.abort === abort) this.abort = undefined;
      await this.onState?.(this.state);
    }
  }
}
