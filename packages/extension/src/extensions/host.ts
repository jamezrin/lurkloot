import { discoverTwitchExtensionChannels } from "@lurkloot/core/extensions/discovery";
import { MANUAL_WATCH_TTL_MS } from "@lurkloot/core/scheduler";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import type { ChannelCandidate, ExtensionSettings, SchedulerState, SupplementalWatchTarget, TwitchExtensionProviderId, TwitchExtensionSummary } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
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
  const summaries: Partial<Record<TwitchExtensionProviderId, TwitchExtensionSummary>> = {};
  let channel: { username: string; displayName?: string } | undefined;
  const runtime = createTwitchExtensionRuntime({
    source: options.source,
    contains: (origin) => options.permissions.contains({ origins: [origin] }),
    drivers: options.drivers,
    report: (id, report) => {
      const previous = summaries[id];
      if (report.status === "complete" && (completedUntil.get(id) ?? 0) <= options.source.now()) completedUntil.set(id, options.source.now() + 5 * 60_000);
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
    clearTransientState: async (id) => { delete summaries[id]; completedUntil.delete(id); },
  });
  const discovery = new Map<TwitchExtensionProviderId, { channels: ChannelCandidate[]; expiresAt: number; pending?: Promise<ChannelCandidate[]> }>();
  const unavailableUntil = new Map<string, number>();
  async function chooseWatchTarget(settings: ExtensionSettings, state: SchedulerState, signal?: AbortSignal): Promise<SupplementalWatchTarget | undefined> {
    const selectedGeneration = generation;
    for (const [key, until] of unavailableUntil) if (until <= options.source.now()) unavailableUntil.delete(key);
    const manual = state.manualWatch?.twitch;
    if (!settings.platform.twitch.enabled || state.authHealth.twitch.status !== "healthy" || state.manualClosePause?.twitch
      || settings.pauseOnManualWatch && manual?.active && options.source.now() - Date.parse(manual.checkedAt) < MANUAL_WATCH_TTL_MS) return;
    for (const provider of twitchExtensionProviders) {
      if (!settings.twitchExtensions[provider.id].enabled || !options.drivers[provider.id]) continue;
      if (!await options.permissions.contains({ origins: [provider.backendOrigin] })) continue;
      signal?.throwIfAborted();
      if (selectedGeneration !== generation) return;
      const now = options.source.now(), summary = summaries[provider.id];
      if ((completedUntil.get(provider.id) ?? 0) > now) continue;
      completedUntil.delete(provider.id);
      if (summary && (summary.status === "error" || summary.status === "unavailable") && summary.channel) {
        // A fixed provider error cannot poison Twitch auth or continuously
        // preempt normal drops. Discovery moves on with a bounded cooldown.
        const key = `${provider.id}:${summary.channel.username}`;
        if (!unavailableUntil.has(key)) unavailableUntil.set(key, now + 5 * 60_000);
      }
      let cache = discovery.get(provider.id);
      if (!cache) { cache = { channels: [], expiresAt: 0 }; discovery.set(provider.id, cache); }
      if (cache.expiresAt <= now && !cache.pending) {
        const entry = cache;
        entry.pending = discoverTwitchExtensionChannels({ provider, query: options.source.query, excludedChannels: settings.platform.twitch.excludedChannels ?? [], signal }).then(channels => {
          if (selectedGeneration === generation) { entry.channels = channels; entry.expiresAt = options.source.now() + 5 * 60_000; }
          return channels;
        }).finally(() => { entry.pending = undefined; });
      }
      const candidates = cache.pending ? await cache.pending : cache.channels;
      signal?.throwIfAborted();
      if (selectedGeneration !== generation) return;
      const excluded = new Set((settings.platform.twitch.excludedChannels ?? []).map(value => value.toLowerCase()));
      const selected = candidates.find(candidate => !excluded.has(candidate.username) && (unavailableUntil.get(`${provider.id}:${candidate.username}`) ?? 0) <= now);
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
    const manual = state.manualWatch?.twitch;
    const paused = Boolean(state.manualClosePause?.twitch) || Boolean(settings.pauseOnManualWatch && manual?.active && options.source.now() - Date.parse(manual.checkedAt) < MANUAL_WATCH_TTL_MS);
    const canRun = !paused && settings.platform.twitch.enabled && state.authHealth.twitch.status === "healthy"
      && session.status === "watching" && Boolean(candidate?.channelId);
    channel = canRun && candidate && /^[a-zA-Z0-9_]{1,25}$/.test(candidate.username)
      ? { username: candidate.username } : undefined;
    const selected: Partial<Record<TwitchExtensionProviderId, TwitchExtensionTarget>> = {};
    for (const provider of twitchExtensionProviders) {
      const id = provider.id;
      if (!settings.twitchExtensions[id].enabled || !allowed.has(id)) { delete summaries[id]; continue; }
      // Keep the completed earning summary while ordinary drops resume. A
      // different channel without this provider must not replace completion
      // with channel-ineligible during the bounded reprobe cooldown.
      if ((completedUntil.get(id) ?? 0) > options.source.now()) continue;
      if (canRun && candidate?.channelId) selected[id] = { channelId: candidate.channelId, username: candidate.username };
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
  function invalidate({ preserveCompleted = false }: { preserveCompleted?: boolean } = {}) {
    generation += 1;
    runtime.stop();
    for (const id of Object.keys(summaries) as TwitchExtensionProviderId[]) {
      if (preserveCompleted && summaries[id]?.status === "complete" && (completedUntil.get(id) ?? 0) > options.source.now()) continue;
      delete summaries[id];
      completedUntil.delete(id);
    }
    if (!preserveCompleted) completedUntil.clear();
  }
  function snapshot() {
    return structuredClone(summaries);
  }
  return { reconcile, chooseWatchTarget, setEnabled, removed, invalidate, snapshot };
}
