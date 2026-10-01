import { discoverTwitchExtensionChannels } from "@lurkloot/core/extensions/discovery";
import { pausedForManualWatch } from "@lurkloot/core/manualWatch";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import type { ChannelCandidate, ExtensionSettings, SchedulerState, SupplementalWatchTarget, TwitchExtensionProviderId, TwitchExtensionSummary, WatchSourceId } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { normalizeWatchSourcePriority } from "@lurkloot/shared/watchSources";
import { createProviderPermissions, type ProviderPermissionPort } from "./permissions";
import { createTwitchExtensionRuntime, type TwitchExtensionDriverFactory, type TwitchExtensionTarget } from "./runtime";
import type { SessionSource } from "./session";

// The lane's completion and cooldown deadlines, kept across service-worker
// restarts (#594). Credential-free and bounded: provider ids, epoch deadlines
// and channel logins only. Validated on load, expired entries dropped.
export interface TwitchExtensionLaneMemory {
  readonly version: 1;
  readonly knownComplete: Partial<Record<TwitchExtensionProviderId, number>>;
  readonly completedUntil: Partial<Record<TwitchExtensionProviderId, number>>;
  readonly unavailableUntil: Record<string, number>;
  readonly lastCompletedNoPixelChannel?: string;
  // The Twitch login the deadlines were learned for. Completion belongs to the
  // account, so memory saved for another login is never restored.
  readonly owner?: string;
}

export interface TwitchExtensionLaneMemoryPort {
  load(): Promise<unknown>;
  save(memory: TwitchExtensionLaneMemory): Promise<void>;
}

const CHANNEL_LOGIN = /^[a-z0-9_]{1,25}$/;
// Every deadline the host sets is at most a day away (NoPixelV's is capped at
// the next UTC midnight); anything further out is not ours.
const MAX_DEADLINE_MS = 25 * 60 * 60_000;
const MAX_UNAVAILABLE_ENTRIES = 64;

export function parseTwitchExtensionLaneMemory(value: unknown, now: number): TwitchExtensionLaneMemory | undefined {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return undefined;
  const raw = value as Record<string, unknown>;
  const providerIds = new Set<string>(twitchExtensionProviders.map((provider) => provider.id));
  const deadline = (candidate: unknown): candidate is number => typeof candidate === "number"
    && Number.isFinite(candidate) && candidate > now && candidate <= now + MAX_DEADLINE_MS;
  const byProvider = (field: unknown): Partial<Record<TwitchExtensionProviderId, number>> => {
    const parsed: Partial<Record<TwitchExtensionProviderId, number>> = {};
    if (!field || typeof field !== "object") return parsed;
    for (const [id, until] of Object.entries(field)) {
      if (providerIds.has(id) && deadline(until)) parsed[id as TwitchExtensionProviderId] = until;
    }
    return parsed;
  };
  const unavailableUntil: Record<string, number> = {};
  if (raw.unavailableUntil && typeof raw.unavailableUntil === "object") {
    for (const [key, until] of Object.entries(raw.unavailableUntil).slice(0, MAX_UNAVAILABLE_ENTRIES)) {
      const [id, login, ...rest] = key.split(":");
      if (rest.length === 0 && providerIds.has(id) && CHANNEL_LOGIN.test(login ?? "") && deadline(until)) unavailableUntil[key] = until;
    }
  }
  const channel = raw.lastCompletedNoPixelChannel;
  const owner = raw.owner;
  return {
    version: 1,
    knownComplete: byProvider(raw.knownComplete),
    completedUntil: byProvider(raw.completedUntil),
    unavailableUntil,
    ...(typeof channel === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(channel) ? { lastCompletedNoPixelChannel: channel } : {}),
    ...(typeof owner === "string" && CHANNEL_LOGIN.test(owner) ? { owner } : {}),
  };
}

function normalizedLogin(value: string | undefined): string | undefined {
  const login = value?.toLowerCase();
  return login && CHANNEL_LOGIN.test(login) ? login : undefined;
}

export function createTwitchExtensionHost(options: {
  source: SessionSource;
  permissions: ProviderPermissionPort;
  drivers: Partial<Record<TwitchExtensionProviderId, TwitchExtensionDriverFactory>>;
  loadSettings(): Promise<ExtensionSettings>;
  loadState(): Promise<SchedulerState>;
  savePatch(patch: SettingsPatch): Promise<void>;
  diagnostic(message: string): void;
  // Publishes driver activity; the runtime drops it once the session ended.
  publish(events: readonly EngineEvent[]): void;
  // Where completion and cooldowns outlive the service worker. Without it
  // they live only as long as the host.
  memory?: TwitchExtensionLaneMemoryPort;
  // The signed-in Twitch login (not a credential), which the memory is tied to.
  viewerLogin?(): Promise<string | undefined>;
  // Asks the scheduler to choose again now, rather than at its next poll.
  requestTick?(): void;
}) {
  let generation = 0;
  const allowed = new Set<TwitchExtensionProviderId>();
  const completedUntil = new Map<TwitchExtensionProviderId, number>();
  // Retain completion through ordinary transitions, but allow a bounded
  // reprobe so new packs/giveaways and daily resets cannot be starved by the
  // other provider. Thirty minutes avoids switching on every scheduler tick.
  const knownComplete = new Map<TwitchExtensionProviderId, number>();
  const activeReprobes = new Set<TwitchExtensionProviderId>();
  const unavailableUntil = new Map<string, number>();
  const completionDeadline = (id: TwitchExtensionProviderId, now: number, delay: number) => id === "nopixel"
    ? Math.min(now + delay, (Math.floor(now / 86_400_000) + 1) * 86_400_000)
    : now + delay;
  let lastCompletedNoPixelChannel: string | undefined;
  const summaries: Partial<Record<TwitchExtensionProviderId, TwitchExtensionSummary>> = {};
  let channel: { username: string; displayName?: string } | undefined;

  // What was cleared before the stored memory was restored. A restore never
  // brings back what the host already let go of: an account change, a
  // disable, or an ordinary invalidation that drops the short cooldowns.
  const clearedBeforeRestore = { all: false, completedUntil: false, providers: new Set<TwitchExtensionProviderId>() };
  let restoreApplied = false;
  // The login the in-memory deadlines belong to; undefined when unknown.
  let owner: string | undefined;
  async function currentLogin(): Promise<string | undefined> {
    try {
      return normalizedLogin(await options.viewerLogin?.());
    } catch {
      return undefined;
    }
  }
  const restored = (async () => {
    if (!options.memory) return;
    try {
      const [stored, login] = await Promise.all([options.memory.load(), currentLogin()]);
      owner = login;
      const memory = parseTwitchExtensionLaneMemory(stored, options.source.now());
      // Memory learned for another account, or for an unknown one, stays behind.
      if (!memory || clearedBeforeRestore.all || !login || memory.owner !== login) return;
      const keep = (id: TwitchExtensionProviderId) => !clearedBeforeRestore.providers.has(id);
      for (const [id, until] of Object.entries(memory.knownComplete) as [TwitchExtensionProviderId, number][]) {
        if (keep(id) && !knownComplete.has(id)) knownComplete.set(id, until);
      }
      if (!clearedBeforeRestore.completedUntil) {
        for (const [id, until] of Object.entries(memory.completedUntil) as [TwitchExtensionProviderId, number][]) {
          if (keep(id) && !completedUntil.has(id)) completedUntil.set(id, until);
        }
        if (keep("nopixel")) lastCompletedNoPixelChannel ??= memory.lastCompletedNoPixelChannel;
      }
      for (const [key, until] of Object.entries(memory.unavailableUntil)) {
        if (keep(key.split(":")[0] as TwitchExtensionProviderId) && !unavailableUntil.has(key)) unavailableUntil.set(key, until);
      }
    } catch {
      // Unreadable memory is the same as none: providers are probed again.
    } finally {
      restoreApplied = true;
    }
  })();

  let saving: Promise<void> = Promise.resolve();
  function persist(): void {
    if (!options.memory) return;
    const memory = options.memory;
    saving = saving.then(async () => {
      await restored;
      const now = options.source.now();
      const live = <K extends string>(entries: Iterable<[K, number]>) =>
        Object.fromEntries([...entries].filter(([, until]) => until > now)) as Partial<Record<K, number>>;
      try {
        await memory.save({
          version: 1,
          knownComplete: live(knownComplete),
          completedUntil: live(completedUntil),
          unavailableUntil: live(unavailableUntil) as Record<string, number>,
          ...(lastCompletedNoPixelChannel ? { lastCompletedNoPixelChannel } : {}),
          ...(owner ? { owner } : {}),
        });
      } catch {
        // The next change saves again; memory keeps working meanwhile.
      }
    });
  }
  const runtime = createTwitchExtensionRuntime({
    source: options.source,
    contains: (origin) => options.permissions.contains({ origins: [origin] }),
    drivers: options.drivers,
    report: (id, report) => {
      const previous = summaries[id];
      if (id === "nopixel" && report.status === "complete" && channel) lastCompletedNoPixelChannel = channel.username;
      if (report.status === "complete") {
        const now = options.source.now();
        knownComplete.set(id, completionDeadline(id, now, 30 * 60_000));
      } else if (report.status === "farming") knownComplete.delete(id);
      else if ((report.status === "error" || report.status === "unavailable") && activeReprobes.has(id)) {
        // A failed due reprobe consumes its turn too; it must not repeatedly
        // evict another earning provider while walking unavailable channels.
        knownComplete.set(id, completionDeadline(id, options.source.now(), 30 * 60_000));
      }
      if (["complete", "farming", "error", "unavailable"].includes(report.status)) activeReprobes.delete(id);
      if (report.status === "complete" && (completedUntil.get(id) ?? 0) <= options.source.now()) completedUntil.set(id, completionDeadline(id, options.source.now(), 5 * 60_000));
      if ((report.status === "error" || report.status === "unavailable") && channel) {
        // Start cooldown from the observed failure once. Re-reading an old
        // summary during selection must not renew it and starve this channel.
        unavailableUntil.set(`${id}:${channel.username.toLowerCase()}`, options.source.now() + 5 * 60_000);
      }
      summaries[id] = { ...report, ...(channel ? { channel: { ...channel } } : {}), updatedAt: new Date(options.source.now()).toISOString() };
      if ((report.status === "error" || report.status === "unavailable")
        && (previous?.status !== report.status || previous.reasonCode !== report.reasonCode || previous.channel?.username !== channel?.username)) {
        // Runtime reports have already passed the bounded allowlist validator.
        // Preserve an actionable outcome after discovery moves to another channel,
        // without retaining vendor bodies, credentials or exception text.
        options.diagnostic(`Twitch extension ${id} ${report.status}${channel ? ` on ${channel.username}` : ""}: ${report.reasonCode}`);
      }
      if (["complete", "farming", "error", "unavailable"].includes(report.status)) persist();
    },
    onViolation: (_id, diagnostic) => options.diagnostic(diagnostic),
    publish: options.publish,
  });
  const permissions = createProviderPermissions({
    permissions: options.permissions,
    runtime: {
      // Grant activation permits a later channel selection; it does not open a
      // network connection before the enabled setting is committed.
      start: async (provider) => { allowed.add(provider.id); },
      stop: (provider) => { allowed.delete(provider.id); runtime.stop(provider.id); },
    },
    enabled: async (id) => (await options.loadSettings()).twitchExtensions[id].enabled,
    setEnabled: async (id, enabled) => options.savePatch({ twitchExtensions: { [id]: { enabled } } }),
    clearTransientState: async (id) => {
      delete summaries[id];
      completedUntil.delete(id);
      knownComplete.delete(id);
      activeReprobes.delete(id);
      discovery.delete(id);
      for (const key of unavailableUntil.keys()) if (key.startsWith(`${id}:`)) unavailableUntil.delete(key);
      if (id === "nopixel") lastCompletedNoPixelChannel = undefined;
      if (!restoreApplied) clearedBeforeRestore.providers.add(id);
      persist();
    },
  });
  // One channel discovery per provider at a time, shared by every caller. It
  // runs under its own abort controller rather than the first caller's signal,
  // so cancelling one tick cannot reject another tick waiting on it (#587). It
  // is aborted only once the last caller waiting on it has left.
  interface SharedDiscovery { promise: Promise<ChannelCandidate[]>; abort: AbortController; waiters: number }
  const discovery = new Map<TwitchExtensionProviderId, { channels: ChannelCandidate[]; expiresAt: number; pending?: SharedDiscovery }>();
  async function awaitSharedDiscovery(shared: SharedDiscovery, signal?: AbortSignal): Promise<ChannelCandidate[]> {
    shared.waiters += 1;
    try {
      if (!signal) return await shared.promise;
      signal.throwIfAborted();
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([shared.promise, aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } finally {
      shared.waiters -= 1;
      if (shared.waiters === 0) shared.abort.abort(new DOMException("No caller is waiting for this discovery", "AbortError"));
    }
  }
  async function chooseWatchTarget(settings: ExtensionSettings, state: SchedulerState, signal?: AbortSignal, source?: WatchSourceId): Promise<SupplementalWatchTarget | undefined> {
    await restored;
    const selectedGeneration = generation;
    for (const [key, until] of unavailableUntil) if (until <= options.source.now()) unavailableUntil.delete(key);
    if (!settings.platform.twitch.enabled || state.authHealth.twitch.status !== "healthy" || state.manualClosePause?.twitch
      || pausedForManualWatch(settings, state, "twitch", options.source.now())) return;
    // User order governs selection between providers. Retain an earning
    // provider's current channel only within that source, after higher sources
    // have yielded. Completion deadlines apply even without an earning holder.
    const session = state.sessions.twitch;
    const holderId = session.status === "watching" ? session.supplementalWatch?.id : undefined;
    const holderSummary = holderId ? summaries[holderId as TwitchExtensionProviderId] : undefined;
    const nowForRanking = options.source.now();
    const holderEarning = holderId !== undefined && (knownComplete.get(holderId as TwitchExtensionProviderId) ?? 0) <= nowForRanking
      && (!holderSummary || !["complete", "error", "unavailable"].includes(holderSummary.status));
    const order = normalizeWatchSourcePriority("twitch", settings.platform.twitch.watchSourcePriority);
    const providers = [...twitchExtensionProviders]
      .filter(provider => source === undefined || provider.id === source)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    for (const provider of providers) {
      if (!settings.twitchExtensions[provider.id].enabled || !options.drivers[provider.id]) continue;
      if (!await options.permissions.contains({ origins: [provider.backendOrigin] })) continue;
      signal?.throwIfAborted();
      if (selectedGeneration !== generation) return;
      const now = options.source.now();
      if ((knownComplete.get(provider.id) ?? 0) > now) continue;
      if ((completedUntil.get(provider.id) ?? 0) > now) continue;
      completedUntil.delete(provider.id);
      let cache = discovery.get(provider.id);
      if (!cache) { cache = { channels: [], expiresAt: 0 }; discovery.set(provider.id, cache); }
      // A discovery aborted because every caller left may not have settled yet;
      // a new caller starts a fresh one rather than inheriting that abort.
      if (cache.expiresAt <= now && (!cache.pending || cache.pending.abort.signal.aborted)) {
        const entry = cache;
        const abort = new AbortController();
        const shared: SharedDiscovery = { abort, waiters: 0, promise: Promise.resolve([]) };
        shared.promise = discoverTwitchExtensionChannels({ provider, query: options.source.query, excludedChannels: settings.platform.twitch.excludedChannels ?? [], signal: abort.signal }).then(channels => {
          if (selectedGeneration === generation) { entry.channels = channels; entry.expiresAt = options.source.now() + 5 * 60_000; }
          return channels;
        }).finally(() => { if (entry.pending === shared) entry.pending = undefined; });
        // A discovery every caller has left may reject with nobody listening.
        shared.promise.catch(() => undefined);
        entry.pending = shared;
      }
      const candidates = cache.pending ? await awaitSharedDiscovery(cache.pending, signal) : cache.channels;
      signal?.throwIfAborted();
      if (selectedGeneration !== generation) return;
      const excluded = new Set((settings.platform.twitch.excludedChannels ?? []).map(value => value.toLowerCase()));
      const eligible = (candidate: ChannelCandidate) => !excluded.has(candidate.username) && (unavailableUntil.get(`${provider.id}:${candidate.username}`) ?? 0) <= now;
      // Stay on the current channel while it is still a live, eligible stream
      // for the provider holding the session; discovery refreshes every five
      // minutes, so an offline channel drops out and selection moves on.
      const current = holderEarning && provider.id === holderId
        ? candidates.find(candidate => candidate.username === session.channel?.username.toLowerCase())
        : undefined;
      if (current && eligible(current)) return { id: provider.id, channel: current, tablessOnly: true };
      // Daily completion is viewer-wide, but giveaways belong to channels.
      // Rotate bounded reprobes rather than repeatedly visiting the first stream.
      const previousIndex = provider.id === "nopixel" ? candidates.findIndex(candidate => candidate.username === lastCompletedNoPixelChannel) : -1;
      const ordered = previousIndex < 0 ? candidates : [...candidates.slice(previousIndex + 1), ...candidates.slice(0, previousIndex + 1)];
      const selected = ordered.find(eligible);
      if (selected) return { id: provider.id, channel: selected, tablessOnly: true };
    }
  }
  async function reconcile() {
    await restored;
    const selectedGeneration = ++generation;
    await permissions.reconcile();
    if (selectedGeneration !== generation) return;
    const [settings, state] = await Promise.all([options.loadSettings(), options.loadState()]);
    if (selectedGeneration !== generation) return;
    const session = state.sessions.twitch;
    const candidate = session.channel;
    const paused = Boolean(state.manualClosePause?.twitch) || pausedForManualWatch(settings, state, "twitch", options.source.now());
    const canRun = !paused && settings.platform.twitch.enabled && state.authHealth.twitch.status === "healthy"
      && session.status === "watching" && Boolean(candidate?.channelId);
    channel = canRun && candidate && /^[a-zA-Z0-9_]{1,25}$/.test(candidate.username)
      ? { username: candidate.username } : undefined;
    const selected: Partial<Record<TwitchExtensionProviderId, TwitchExtensionTarget>> = {};
    for (const provider of twitchExtensionProviders) {
      const id = provider.id;
      activeReprobes.delete(id);
      if (!settings.twitchExtensions[id].enabled || !allowed.has(id)) { delete summaries[id]; continue; }
      // Only the scheduler's selected due reprobe may revisit a completed
      // provider. Incidental runs on lower sources must not renew its deadline.
      const completionUntil = knownComplete.get(id);
      if (completionUntil !== undefined && (completionUntil > options.source.now() || session.supplementalWatch?.id !== id)) continue;
      if ((completedUntil.get(id) ?? 0) > options.source.now()) continue;
      if (canRun && candidate?.channelId) {
        selected[id] = { channelId: candidate.channelId, username: candidate.username };
        if (completionUntil !== undefined) activeReprobes.add(id);
      }
      else summaries[id] = { status: "idle", reasonCode: "channel-required", progress: [], pending: [], updatedAt: new Date(options.source.now()).toISOString() };
    }
    await runtime.update(selected);
  }
  async function setEnabled(id: TwitchExtensionProviderId, enabled: boolean): Promise<{ enabled: boolean }> {
    generation += 1;
    const result = enabled ? await permissions.enableGranted(id) : (await permissions.disable(id), false);
    await reconcile();
    return { enabled: result };
  }
  async function removed(details: { origins?: string[] }) {
    generation += 1;
    await permissions.removed(details);
    await reconcile();
  }
  function invalidate({ preserveCompleted = false, forgetCompletion = false }: { preserveCompleted?: boolean; forgetCompletion?: boolean } = {}) {
    generation += 1;
    runtime.stop();
    activeReprobes.clear();
    for (const id of Object.keys(summaries) as TwitchExtensionProviderId[]) {
      if (!forgetCompletion && preserveCompleted && summaries[id]?.status === "complete" && (knownComplete.get(id) ?? 0) > options.source.now()) continue;
      delete summaries[id];
      completedUntil.delete(id);
    }
    if (!preserveCompleted) {
      completedUntil.clear();
      lastCompletedNoPixelChannel = undefined;
      if (!restoreApplied) clearedBeforeRestore.completedUntil = true;
    }
    // Completion belongs to the Twitch account; only an account/credential
    // change (or disable/reset, via clearTransientState) may discard it.
    if (forgetCompletion) {
      knownComplete.clear();
      completedUntil.clear();
      unavailableUntil.clear();
      discovery.clear();
      lastCompletedNoPixelChannel = undefined;
      if (!restoreApplied) clearedBeforeRestore.all = true;
    }
    persist();
  }

  // Twitch's auth cookie changed. The providers stop at once, since the session
  // may belong to someone else now. Completion and cooldowns are forgotten only
  // when the signed-in login actually changed: Twitch re-sets the cookie on
  // ordinary page loads, and that must not wipe what the lane learned.
  async function credentialsChanged(): Promise<void> {
    invalidate({ preserveCompleted: true });
    await restored;
    const login = await currentLogin();
    if (login !== undefined && login === owner) return;
    invalidate({ forgetCompletion: true });
    owner = login;
    persist();
  }

  // A tabless-only session whose heartbeats keep failing (#586, #594). Its
  // channel is cooled like an unavailable report, so selection moves to
  // another channel or source instead of falling back to a tab. A failed due
  // reprobe consumes its turn. An active cooldown is never renewed, so a run
  // of failures cannot starve the channel.
  async function recordHeartbeatFailure(failure: { provider: string; username: string; heartbeatChecks: number }): Promise<void> {
    await restored;
    const provider = twitchExtensionProviders.find((candidate) => candidate.id === failure.provider);
    if (!provider) return;
    const settings = await options.loadSettings();
    if (failure.heartbeatChecks < settings.tablessFallbackFailureLimit) return;
    const now = options.source.now();
    const key = `${provider.id}:${failure.username.toLowerCase()}`;
    if ((unavailableUntil.get(key) ?? 0) > now) return;
    unavailableUntil.set(key, now + 5 * 60_000);
    if (activeReprobes.has(provider.id)) {
      knownComplete.set(provider.id, completionDeadline(provider.id, now, 30 * 60_000));
      activeReprobes.delete(provider.id);
    }
    options.diagnostic(`Twitch extension ${provider.id} heartbeat keeps failing on ${failure.username}; trying another channel`);
    persist();
    // The poll interval can be up to an hour; choose another target now, as
    // the ordinary heartbeat fallback does.
    options.requestTick?.();
  }
  function snapshot() {
    return structuredClone(summaries);
  }
  return { reconcile, chooseWatchTarget, setEnabled, removed, invalidate, snapshot, recordHeartbeatFailure, credentialsChanged };
}
