import type { TwitchExtensionProviderDescriptor } from "@lurkloot/core/extensions/types";

export interface ProviderScript {
  id: string;
  matches: string[];
  js: string[];
  allFrames: boolean;
  runAt: "document_start";
  world: "ISOLATED" | "MAIN";
  persistAcrossSessions: boolean;
}
export interface Mv2ProviderScript {
  matches: string[];
  js: { file: string }[];
  allFrames: boolean;
  runAt: "document_start";
  world: "ISOLATED" | "MAIN";
}
interface RegistrationHandle { unregister(): Promise<void> }
export interface ProviderRegistrationApi {
  scripting?: {
    registerContentScripts(scripts: ProviderScript[]): Promise<unknown>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<unknown>;
  };
  contentScripts?: { register(script: Mv2ProviderScript): Promise<RegistrationHandle> };
}

export function createProviderRegistration(api: ProviderRegistrationApi) {
  const registered = new Map<string, { complete: boolean; handles: RegistrationHandle[] }>();
  function ids(provider: TwitchExtensionProviderDescriptor) {
    return [`lurkloot-${provider.id}-relay`, `lurkloot-${provider.id}-driver`];
  }
  async function unregister(provider: TwitchExtensionProviderDescriptor): Promise<void> {
    const entry = registered.get(provider.id);
    if (api.contentScripts) {
      if (entry) {
        const results = await Promise.allSettled(entry.handles.map((handle) => handle.unregister()));
        const remaining = entry.handles.filter((_, index) => results[index].status === "rejected");
        if (remaining.length) {
          registered.set(provider.id, { complete: false, handles: remaining });
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    } else if (api.scripting) {
      await api.scripting.unregisterContentScripts({ ids: ids(provider) });
    }
    registered.delete(provider.id);
  }
  return {
    async register(provider: TwitchExtensionProviderDescriptor): Promise<void> {
      const previous = registered.get(provider.id);
      if (previous?.complete) return;
      if (previous) await unregister(provider);
      const scripts: ProviderScript[] = ["relay", "driver"].map((role, index) => ({
        id: ids(provider)[index], matches: [provider.origin],
        js: [`content-scripts/twitchExtension${role === "relay" ? "Bridge" : "Driver"}.js`],
        allFrames: true, runAt: "document_start", world: index === 0 ? "ISOLATED" : "MAIN",
        persistAcrossSessions: false,
      }));
      if (api.contentScripts) {
        const handles: RegistrationHandle[] = [];
        try {
          for (const { matches, js, allFrames, runAt, world } of scripts) {
            handles.push(await api.contentScripts.register({ matches, js: js.map((file) => ({ file: `/${file}` })), allFrames, runAt, world }));
          }
        } catch (error) {
          registered.set(provider.id, { complete: false, handles });
          try { await unregister(provider); } catch { /* Retain failed handles for the next cleanup attempt. */ }
          throw error;
        }
        registered.set(provider.id, { complete: true, handles });
      } else if (api.scripting) {
        // Registrations survive a service-worker sleep. Replace this provider's
        // previous pair on wake, even though the in-memory map starts empty.
        await api.scripting.unregisterContentScripts({ ids: ids(provider) });
        try {
          await api.scripting.registerContentScripts(scripts);
        } catch (error) {
          await api.scripting.unregisterContentScripts({ ids: ids(provider) });
          throw error;
        }
        registered.set(provider.id, { complete: true, handles: [] });
      } else {
        throw new Error("Twitch Extension runtime registration is unavailable.");
      }
    },
    unregister,
  };
}
export type ProviderRegistration = ReturnType<typeof createProviderRegistration>;
