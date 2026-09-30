import { discoverTwitchExtensionChannels } from "@lurkloot/core/extensions/discovery";
import { pausedForManualWatch } from "@lurkloot/core/manualWatch";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import type { ChannelCandidate, ExtensionSettings, SchedulerState, SupplementalWatchTarget, TwitchExtensionProviderId, TwitchExtensionSummary, WatchSourceId } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { normalizeWatchSourcePriority } from "@lurkloot/shared/watchSources";
import { createProviderPermissions, type ProviderPermissionPort } from "./permissions";
import { createTwitchExtensionRuntime, type TwitchExtensionDriverFactory, type TwitchExtensionTarget } from "./runtime";
import type { SessionSource } from "./session";

export function createTwitchExtensionHost(options: {
  source: SessionSource;
  permissions: ProviderPermissionPort;
  drivers: Partial<Record<TwitchExtensionProviderId, TwitchExtensionDriverFactory>>;
  loadSettings(): Promise<ExtensionSettings>;
  loadState(): Promise<SchedulerState>;
  savePatch(patch: SettingsPatch): Promise<void>;
  diagnostic(message: string): void;
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
    },
    onViolation: (_id, diagnostic) => options.diagnostic(diagnostic),
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
    if (!preserveCompleted) { completedUntil.clear(); lastCompletedNoPixelChannel = undefined; }
    // Completion belongs to the Twitch account; only an account/credential
    // change (or disable/reset, via clearTransientState) may discard it.
    if (forgetCompletion) {
      knownComplete.clear();
      completedUntil.clear();
      unavailableUntil.clear();
      discovery.clear();
      lastCompletedNoPixelChannel = undefined;
    }
  }
  function snapshot() {
    return structuredClone(summaries);
  }
  return { reconcile, chooseWatchTarget, setEnabled, removed, invalidate, snapshot };
}
