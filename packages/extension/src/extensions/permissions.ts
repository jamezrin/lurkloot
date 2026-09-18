import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import type { TwitchExtensionProviderId } from "@lurkloot/core/extensions/types";
import type { TwitchExtensionProviderDescriptor } from "@lurkloot/core/extensions/types";

export interface ProviderRuntimePort {
  start(provider: TwitchExtensionProviderDescriptor): Promise<void>;
  stop(provider: TwitchExtensionProviderDescriptor): void;
}

export interface ProviderPermissionPort {
  request(details: { origins: string[] }): Promise<boolean>;
  contains(details: { origins: string[] }): Promise<boolean>;
}

export function createProviderPermissions(options: {
  permissions: ProviderPermissionPort;
  runtime: ProviderRuntimePort;
  enabled(id: TwitchExtensionProviderId): Promise<boolean>;
  setEnabled(id: TwitchExtensionProviderId, enabled: boolean): Promise<void>;
  clearTransientState(id: TwitchExtensionProviderId): Promise<void>;
}) {
  const generations = new Map<TwitchExtensionProviderId, number>();
  function invalidate(id: TwitchExtensionProviderId) {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    options.runtime.stop(descriptor(id));
  }
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = pending.then(operation, operation);
    pending = run.then(() => undefined, () => undefined);
    return run;
  }
  function descriptor(id: TwitchExtensionProviderId) {
    const provider = twitchExtensionProviders.find((candidate) => candidate.id === id);
    if (!provider) throw new Error("Unknown Twitch Extension provider.");
    return provider;
  }
  async function disable(id: TwitchExtensionProviderId) {
    try {
      await options.setEnabled(id, false);
    } finally {
      try {
        options.runtime.stop(descriptor(id));
      } finally {
        await options.clearTransientState(id);
      }
    }
  }
  function enable(id: TwitchExtensionProviderId, granted?: Promise<boolean>): Promise<boolean> {
    const provider = descriptor(id);
    const generation = generations.get(id) ?? 0;
    // Invoke directly from the UI gesture, BEFORE any asynchronous storage
    // reads or serialization; permissions.request needs the gesture intact.
    const grant = granted ?? options.permissions.request({ origins: [provider.backendOrigin] });
    // Handle rejection immediately even if another queued operation is slow.
    const outcome = grant.then((granted) => ({ granted }), (error: unknown) => ({ error }));
    return serialize(async () => {
      const result = await outcome;
      if ((generations.get(id) ?? 0) !== generation) return false;
      if ("error" in result) throw result.error;
      if (!result.granted) { await disable(id); return false; }
      if (!await options.permissions.contains({ origins: [provider.backendOrigin] })) {
        await disable(id);
        return false;
      }
      if ((generations.get(id) ?? 0) !== generation) return false;
      try {
        await options.runtime.start(provider);
        if ((generations.get(id) ?? 0) !== generation) { await disable(id); return false; }
        await options.setEnabled(id, true);
      } catch (error) {
        await disable(id);
        throw error;
      }
      if ((generations.get(id) ?? 0) !== generation) { await disable(id); return false; }
      return true;
    });
  }
  return {
    enable(id: TwitchExtensionProviderId): Promise<boolean> { return enable(id); },
    // Extension UI requests access directly from its gesture, then the
    // background verifies that grant before enabling. Never trust a UI boolean.
    enableGranted(id: TwitchExtensionProviderId): Promise<boolean> { return enable(id, Promise.resolve(true)); },
    disable(id: TwitchExtensionProviderId): Promise<void> {
      invalidate(id);
      return serialize(() => disable(id));
    },
    removed(details: { origins?: string[] }): Promise<void> {
      for (const provider of twitchExtensionProviders) {
        if (details.origins?.includes(provider.backendOrigin)) invalidate(provider.id);
      }
      return serialize(async () => {
        const results = await Promise.allSettled(twitchExtensionProviders
          .filter((provider) => details.origins?.includes(provider.backendOrigin))
          .map(async (provider) => {
            if (await options.enabled(provider.id)) await disable(provider.id);
            else options.runtime.stop(provider);
          }));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    },
    reconcile(): Promise<void> {
      return serialize(async () => {
        // Independent providers never interfere with one another on failure.
        const results = await Promise.allSettled(twitchExtensionProviders.map(async (provider) => {
          const generation = generations.get(provider.id) ?? 0;
          if (!await options.enabled(provider.id)) {
            options.runtime.stop(provider);
            return;
          }
          if ((generations.get(provider.id) ?? 0) !== generation) return;
          if (!await options.permissions.contains({ origins: [provider.backendOrigin] })) {
            await disable(provider.id);
            return;
          }
          if ((generations.get(provider.id) ?? 0) !== generation) return;
          try {
            await options.runtime.start(provider);
            if ((generations.get(provider.id) ?? 0) !== generation) await disable(provider.id);
          }
          catch (error) { await disable(provider.id); throw error; }
        }));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    },
  };
}
