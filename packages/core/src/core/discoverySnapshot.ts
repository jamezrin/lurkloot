import type { ChannelCandidate, DropCampaign, Platform, WatchSession } from "@lurkloot/shared/models";
import type { PlatformAdapter } from "../platforms/adapter";

export type ChannelEligibility = true | false | "unknown";

export interface DiscoveryCandidateObservation {
  candidate: ChannelCandidate;
  live: boolean;
  categoryMatches: boolean;
  eligible: ChannelEligibility;
  observedAt: number;
}

export interface DiscoveryCampaignObservation {
  campaign: DropCampaign;
  candidates: DiscoveryCandidateObservation[];
}

export interface DiscoveryRefreshMetrics {
  campaigns: number;
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

export interface DiscoveryRefreshContext {
  generation: number;
  signal: AbortSignal;
}

export type DiscoverySnapshotListener = (state: Readonly<DiscoverySnapshotState>) => void | Promise<void>;

export async function collectDiscoverySnapshot(
  adapter: Pick<PlatformAdapter, "platform" | "refreshCampaigns" | "listCandidateChannels" | "checkChannel" | "selectCandidateChannel" | "listFollowedChannels">,
  session: Parameters<PlatformAdapter["refreshCampaigns"]>[0],
  signal: AbortSignal,
  now: () => number = Date.now,
  includeFollowedChannels = true,
  idleCandidates: ChannelCandidate[] = [],
): Promise<DiscoveryRefreshResult> {
  const [campaigns, followedChannels] = await Promise.all([
    adapter.refreshCampaigns(session, { signal }),
    includeFollowedChannels
      ? adapter.listFollowedChannels?.({ signal }) ?? Promise.resolve([])
      : Promise.resolve([]),
  ]);
  const observations: DiscoveryCampaignObservation[] = [];
  let candidatesChecked = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let batchRequests = 0;
  let singleFallbacks = 0;
  for (const campaign of campaigns) {
    signal.throwIfAborted();
    const listedCandidates = await adapter.listCandidateChannels(campaign, { signal });
    const candidates = session?.campaignId === campaign.id && session.channel
      ? [...new Map(
          [session.channel, ...listedCandidates]
            .map((candidate) => [candidate.username.toLowerCase(), candidate] as const),
        ).values()]
      : listedCandidates;
    const observed: DiscoveryCandidateObservation[] = [];
    if (adapter.selectCandidateChannel) {
      const selection = await adapter.selectCandidateChannel(candidates, campaign, { signal });
      candidatesChecked += selection.checked;
      cacheHits += selection.metrics?.cacheHits ?? 0;
      cacheMisses += selection.metrics?.cacheMisses ?? 0;
      batchRequests += selection.metrics?.batchRequests ?? 0;
      singleFallbacks += selection.metrics?.singleFallbacks ?? 0;
      observed.push(...(selection.observations ?? (selection.channel
        ? [{ live: true, categoryMatches: true, candidate: selection.channel }]
        : [])).map((check) => ({
        candidate: check.candidate,
        live: check.live,
        categoryMatches: check.categoryMatches,
        eligible: check.campaignMatches ?? "unknown" as const,
        observedAt: now(),
      })));
    } else {
      for (const candidate of candidates) {
        signal.throwIfAborted();
        const check = await adapter.checkChannel(candidate, { campaign, signal });
        candidatesChecked += 1;
        observed.push({
          candidate: check.candidate,
          live: check.live,
          categoryMatches: check.categoryMatches,
          eligible: check.campaignMatches ?? "unknown",
          observedAt: now(),
        });
        if (check.live && check.categoryMatches && check.campaignMatches !== false) break;
      }
    }
    observations.push({ campaign, candidates: observed });
  }
  const observedIdleCandidates: DiscoveryCandidateObservation[] = [];
  if (adapter.selectCandidateChannel) {
    const selection = await adapter.selectCandidateChannel(idleCandidates, undefined, { signal });
    candidatesChecked += selection.checked;
    cacheHits += selection.metrics?.cacheHits ?? 0;
    cacheMisses += selection.metrics?.cacheMisses ?? 0;
    batchRequests += selection.metrics?.batchRequests ?? 0;
    singleFallbacks += selection.metrics?.singleFallbacks ?? 0;
    observedIdleCandidates.push(...(selection.observations ?? (selection.channel
      ? [{ live: true, categoryMatches: true, candidate: selection.channel }]
      : [])).map((check) => ({
      candidate: check.candidate,
      live: check.live,
      categoryMatches: check.categoryMatches,
      eligible: "unknown" as const,
      observedAt: now(),
    })));
  } else {
    for (const candidate of idleCandidates) {
      signal.throwIfAborted();
      const check = await adapter.checkChannel(candidate, { signal });
      candidatesChecked += 1;
      observedIdleCandidates.push({
        candidate: check.candidate,
        live: check.live,
        categoryMatches: check.categoryMatches,
        eligible: "unknown",
        observedAt: now(),
      });
    }
  }
  return {
    campaigns: observations,
    idleCandidates: observedIdleCandidates,
    followedChannels,
    complete: true,
    metrics: {
      campaigns: campaigns.length,
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
  const campaigns = new Map((snapshot?.campaigns ?? []).map((observation) => [observation.campaign.id, observation]));
  return new Proxy(adapter, {
    get(target, property, receiver) {
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
            ? campaigns.get(options.campaign.id)?.candidates ?? []
            : snapshot?.idleCandidates ?? [];
          const observation = observations.find(({ candidate: observed }) =>
            observed.username.toLowerCase() === candidate.username.toLowerCase());
          if (!observation) {
            const currentChannel = session?.channel;
            if (options?.campaign && session?.campaignId === options.campaign.id && currentChannel
              && currentChannel.username.toLowerCase() === candidate.username.toLowerCase()) {
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

export function selectionAdapterFromDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  session?: WatchSession,
): Pick<PlatformAdapter, "listCandidateChannels" | "selectCandidateChannel" | "checkChannel" | "listFollowedChannels"> {
  const campaigns = new Map(snapshot.campaigns.map((observation) => [observation.campaign.id, observation]));
  return {
    listCandidateChannels: async (campaign) =>
      campaigns.get(campaign.id)?.candidates.map(({ candidate }) => candidate) ?? [],
    selectCandidateChannel: undefined,
    listFollowedChannels: async () => [...snapshot.followedChannels],
    checkChannel: async (candidate, options) => {
      const observations = options?.campaign
        ? campaigns.get(options.campaign.id)?.candidates ?? []
        : snapshot.idleCandidates;
      const observation = observations.find(({ candidate: observed }) =>
        observed.username.toLowerCase() === candidate.username.toLowerCase());
      if (!observation) {
        const currentChannel = session?.channel;
        if (options?.campaign && session?.campaignId === options.campaign.id && currentChannel
          && currentChannel.username.toLowerCase() === candidate.username.toLowerCase()) {
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
    },
  };
}

export class DiscoverySnapshotLane {
  private state: DiscoverySnapshotState = {};
  private generation = 0;
  private revision = 0;
  private running = false;
  private pending = false;
  private pendingCount = 0;
  private stopped = false;
  private abort?: AbortController;
  private settled: Promise<void> = Promise.resolve();

  constructor(
    readonly platform: Platform,
    private readonly refresh: (context: DiscoveryRefreshContext) => Promise<DiscoveryRefreshResult>,
    private readonly onState?: DiscoverySnapshotListener,
    private readonly now: () => number = Date.now,
  ) {}

  current(): Readonly<DiscoverySnapshotState> {
    return this.state;
  }

  request(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      this.pendingCount += 1;
      return;
    }
    this.running = true;
    const run = this.runLoop();
    this.settled = run.then(() => undefined, () => undefined);
  }

  async requestAndWait(): Promise<void> {
    this.request();
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

  private async runLoop(): Promise<void> {
    try {
      do {
        this.pending = false;
        const coalesced = this.pendingCount;
        this.pendingCount = 0;
        await this.runOnce(coalesced);
      } while (this.pending && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(coalesced: number): Promise<void> {
    const generation = this.generation;
    const startedAt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const result = await this.refresh({ generation, signal: abort.signal });
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
          lastAttempt: { startedAt, finishedAt, complete: true, coalesced, metrics: result.metrics },
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
          failure: error instanceof Error ? error.message : String(error),
          ...(this.stopped || generation !== this.generation
            ? { discarded: this.stopped ? "stopped" as const : "stale_generation" as const }
            : {}),
          coalesced,
        },
      };
    } finally {
      if (this.abort === abort) this.abort = undefined;
      await this.onState?.(this.state);
    }
  }
}
