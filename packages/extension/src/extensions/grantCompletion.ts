import { twitchExtensionProviders, twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
import type { TwitchExtensionProviderId } from "@lurkloot/shared/models";

interface IntentStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
const intentKey = (id: TwitchExtensionProviderId) => `twitchExtensionEnableIntent.${id}`;
const INTENT_TTL_MS = 2 * 60_000;

// The Chrome permission prompt can destroy the action popup. Record only the
// explicit provider choice and timestamp before prompting; background onAdded
// consumes it independently. No grant alone enables an unsolicited provider.
export async function requestTwitchExtensionGrant(options: {
  storage: IntentStorage;
  request(details: { origins: string[] }): Promise<boolean>;
  now(): number;
}, id: TwitchExtensionProviderId): Promise<boolean> {
  const key = intentKey(id);
  const saved = options.storage.set({ [key]: options.now() });
  // Call synchronously within the original gesture, without awaiting storage.
  const grant = options.request({ origins: [twitchExtensionProvider(id)!.backendOrigin] });
  try {
    const [, granted] = await Promise.all([saved, grant]);
    if (!granted) await options.storage.remove(key);
    return granted;
  } catch (error) {
    await options.storage.remove(key);
    throw error;
  }
}

export function createTwitchExtensionGrantCompletion(options: {
  storage: IntentStorage;
  now(): number;
  enable(id: TwitchExtensionProviderId): Promise<void>;
  contains(details: { origins: string[] }): Promise<boolean>;
}) {
  const generations = new Map<TwitchExtensionProviderId, number>();
  const cancelledAt = new Map<TwitchExtensionProviderId, number>();
  const dirty = new Set<TwitchExtensionProviderId>();
  const pending = new Map<TwitchExtensionProviderId, Promise<void>>();
  function cancel(id: TwitchExtensionProviderId): Promise<void> {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    cancelledAt.set(id, options.now());
    return options.storage.remove(intentKey(id));
  }
  async function consume(id: TwitchExtensionProviderId) {
    const generation = generations.get(id) ?? 0;
    if (!await options.contains({ origins: [twitchExtensionProvider(id)!.backendOrigin] })) return;
    if ((generations.get(id) ?? 0) !== generation) return;
    const key = intentKey(id);
    const stored = await options.storage.get(key);
    const timestamp = stored[key];
    if (timestamp === undefined) return;
    await options.storage.remove(key);
    if ((generations.get(id) ?? 0) !== generation || typeof timestamp !== "number" || !Number.isFinite(timestamp)
      || timestamp <= (cancelledAt.get(id) ?? -Infinity) || timestamp > options.now() || options.now() - timestamp > INTENT_TTL_MS) return;
    // The host rechecks the actual backend grant before committing the setting.
    await options.enable(id);
  }
  function schedule(id: TwitchExtensionProviderId): Promise<void> {
    const existing = pending.get(id);
    if (existing) { dirty.add(id); return existing; }
    const run = (async () => {
      do { dirty.delete(id); await consume(id); } while (dirty.has(id));
    })().finally(() => { pending.delete(id); });
    pending.set(id, run);
    return run;
  }
  return {
    cancel,
    cancelAll: () => Promise.all(twitchExtensionProviders.map(provider => cancel(provider.id))),
    async removed(details: { origins?: string[] }) {
      await Promise.all(twitchExtensionProviders.filter(provider => details.origins?.includes(provider.backendOrigin)).map(provider => cancel(provider.id)));
    },
    async added(details: { origins?: string[] }) {
      await Promise.all(twitchExtensionProviders.filter(provider => details.origins?.includes(provider.backendOrigin)).map(provider => schedule(provider.id)));
    },
    async changed(changes: Record<string, { newValue?: unknown }>) {
      // The native prompt may close the popup before its queued write completes.
      // Either arrival order finishes the same explicit request after a real grant.
      await Promise.all(twitchExtensionProviders.filter(provider => typeof changes[intentKey(provider.id)]?.newValue === "number").map(provider => schedule(provider.id)));
    },
  };
}
