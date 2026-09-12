import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import type { TwitchExtensionProviderId } from "@lurkloot/core/extensions/types";
import type { ProviderRegistration } from "./registration";

export interface ProviderPermissionPort {
  request(details: { origins: string[] }): Promise<boolean>;
  contains(details: { origins: string[] }): Promise<boolean>;
}

export function createProviderPermissions(options: {
  permissions: ProviderPermissionPort;
  registration: ProviderRegistration;
  enabled(id: TwitchExtensionProviderId): Promise<boolean>;
  setEnabled(id: TwitchExtensionProviderId, enabled: boolean): Promise<void>;
  clearTransientState(id: TwitchExtensionProviderId): Promise<void>;
}) {
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
        await options.registration.unregister(descriptor(id));
      } finally {
        await options.clearTransientState(id);
      }
    }
  }
  return {
    enable(id: TwitchExtensionProviderId): Promise<boolean> {
      const provider = descriptor(id);
      // Invoke directly from the UI gesture, BEFORE any asynchronous storage
      // reads or serialization; permissions.request needs the gesture intact.
      const grant = options.permissions.request({ origins: [provider.origin] });
      // Handle rejection immediately even if another queued operation is slow.
      const outcome = grant.then((granted) => ({ granted }), (error: unknown) => ({ error }));
      return serialize(async () => {
        const result = await outcome;
        if ("error" in result) throw result.error;
        if (!result.granted) return false;
        if (!await options.permissions.contains({ origins: [provider.origin] })) {
          await disable(id);
          return false;
        }
        try {
          await options.registration.register(provider);
          await options.setEnabled(id, true);
        } catch (error) {
          await disable(id);
          throw error;
        }
        return true;
      });
    },
    disable(id: TwitchExtensionProviderId): Promise<void> { return serialize(() => disable(id)); },
    removed(details: { origins?: string[] }): Promise<void> {
      return serialize(async () => {
        const results = await Promise.allSettled(twitchExtensionProviders
          .filter((provider) => details.origins?.includes(provider.origin))
          .map(async (provider) => {
            if (await options.enabled(provider.id)) await disable(provider.id);
            else await options.registration.unregister(provider);
          }));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    },
    reconcile(): Promise<void> {
      return serialize(async () => {
        // Independent providers never interfere with one another on failure.
        const results = await Promise.allSettled(twitchExtensionProviders.map(async (provider) => {
          if (!await options.enabled(provider.id)) {
            await options.registration.unregister(provider);
            return;
          }
          if (!await options.permissions.contains({ origins: [provider.origin] })) {
            await disable(provider.id);
            return;
          }
          try { await options.registration.register(provider); }
          catch (error) { await disable(provider.id); throw error; }
        }));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    },
  };
}
