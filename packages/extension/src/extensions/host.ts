import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import type { ExtensionSettings, SchedulerState, TwitchExtensionProviderId, TwitchExtensionSummary } from "@lurkloot/shared/models";
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
  const summaries: Partial<Record<TwitchExtensionProviderId, TwitchExtensionSummary>> = {};
  let channel: { username: string; displayName?: string } | undefined;
  const runtime = createTwitchExtensionRuntime({
    source: options.source,
    contains: (origin) => options.permissions.contains({ origins: [origin] }),
    drivers: options.drivers,
    report: (id, report) => {
      summaries[id] = { ...report, ...(channel ? { channel: { ...channel } } : {}), updatedAt: new Date(options.source.now()).toISOString() };
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
    clearTransientState: async (id) => { delete summaries[id]; },
  });
  async function reconcile() {
    const selectedGeneration = ++generation;
    await permissions.reconcile();
    if (selectedGeneration !== generation) return;
    const [settings, state] = await Promise.all([options.loadSettings(), options.loadState()]);
    if (selectedGeneration !== generation) return;
    const session = state.sessions.twitch;
    const candidate = session.channel;
    const canRun = settings.platform.twitch.enabled && state.authHealth.twitch.status === "healthy"
      && session.status === "watching" && Boolean(candidate?.channelId);
    channel = canRun && candidate && /^[a-zA-Z0-9_]{1,25}$/.test(candidate.username)
      ? { username: candidate.username } : undefined;
    const selected: Partial<Record<TwitchExtensionProviderId, TwitchExtensionTarget>> = {};
    for (const provider of twitchExtensionProviders) {
      const id = provider.id;
      if (!settings.twitchExtensions[id].enabled || !allowed.has(id)) { delete summaries[id]; continue; }
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
  function invalidate() {
    generation += 1;
    runtime.stop();
    for (const id of Object.keys(summaries) as TwitchExtensionProviderId[]) delete summaries[id];
  }
  function snapshot() {
    return structuredClone(summaries);
  }
  return { reconcile, setEnabled, removed, invalidate, snapshot };
}
