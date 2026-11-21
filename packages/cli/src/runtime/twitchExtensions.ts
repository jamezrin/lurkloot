import {
  createTwitchExtensionDrivers,
  createTwitchExtensionHost,
} from "@lurkloot/core/extensions/host";
import { createTwitchExtensionCommitHook } from "@lurkloot/core/extensions/host/commitHook";
import type { EngineSettings, SchedulerState, WatchSourceId } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import type { TransportHandle } from "../transport";
import { createFortniteSockets } from "./fortniteSockets";
import { createTwitchExtensionMemory } from "./twitchExtensionMemory";

export function createCliTwitchExtensionLane(options: {
  transport: TransportHandle;
  statePath: string;
  loadSettings(): Promise<EngineSettings>;
  loadState(): Promise<SchedulerState>;
  savePatch(patch: SettingsPatch): Promise<void>;
  publish(events: readonly EngineEvent[]): void;
  requestTick(): void;
  onSessionReady(): void;
}) {
  const sockets = createFortniteSockets();
  const lifetime = new AbortController();
  let host: ReturnType<typeof createTwitchExtensionHost> | undefined;
  let access: ReturnType<NonNullable<TransportHandle["twitchExtensionAccess"]>>;
  let identityChange: Promise<void> | undefined;
  let closed = false;

  const diagnostic = (message: string, level: "warn" | "debug" = "warn") =>
    options.publish([{ category: "diagnostic", platform: "twitch", level, message }]);

  function startHost() {
    if (host) return host;
    access = options.transport.twitchExtensionAccess?.();
    host = createTwitchExtensionHost({
      ...options,
      source: {
        now: Date.now,
        hasSession: async () => access !== undefined,
        query: (query, variables, signal) => {
          if (!access) throw new Error("Twitch sign-in unavailable.");
          return access.source.query(query, variables, signal);
        },
      },
      // Headless consent is the provider's own enabled setting, checked by core
      // before discovery and session creation. No browser grant is required.
      permissions: { request: async () => true, contains: async () => true },
      drivers: createTwitchExtensionDrivers({
        fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
        createSocket: sockets.createSocket,
        loadSettings: options.loadSettings,
      }),
      viewerLogin: () => access?.viewerLogin(lifetime.signal) ?? Promise.resolve(undefined),
      memory: createTwitchExtensionMemory(options.statePath),
      diagnostic,
    });
    return host;
  }

  function syncIdentity() {
    const next = options.transport.twitchExtensionAccess?.();
    if (access !== next) {
      access = next;
      identityChange = host?.credentialsChanged({ clientChanged: true });
    }
    return identityChange;
  }
  const enabled = (settings: EngineSettings) =>
    settings.platform.twitch.enabled
    && Object.values(settings.twitchExtensions).some((provider) => provider.enabled);
  const commits = createTwitchExtensionCommitHook(
    {
      invalidate: (settings) => host?.invalidate(settings),
      reconcile: async () => {
        const settings = await options.loadSettings();
        if (closed || (!host && !enabled(settings))) return;
        const lane = startHost();
        await syncIdentity();
        if (!closed) await lane.reconcile();
      },
      recordHeartbeatFailure: async (failure) => host?.recordHeartbeatFailure(failure),
    },
    () => diagnostic("Twitch Extension background reconciliation failed."),
  );

  return {
    async select(
      state: SchedulerState,
      settings: EngineSettings,
      signal?: AbortSignal,
      source?: WatchSourceId,
    ) {
      if (closed || !enabled(settings) || state.authHealth.twitch.status !== "healthy") return;
      const lane = startHost();
      await syncIdentity();
      signal?.throwIfAborted();
      if (!closed && access) return lane.chooseWatchTarget(settings, state, signal, source);
    },
    onCommit: commits.onCommit,
    async setEnabled(id: keyof EngineSettings["twitchExtensions"], enabled: boolean) {
      if (!host && !enabled) {
        await options.savePatch({ twitchExtensions: { [id]: { enabled } } });
        return { enabled };
      }
      return startHost().setEnabled(id, enabled);
    },
    // Hermes broadcast ports (#757, #1105). The provider's periodic refresh
    // continues if push is unavailable. The host must start a session before
    // it can supply a token for the topic.
    refreshNow(provider: string, channelId: string): void {
      if (!closed) host?.refreshNow(provider, channelId);
    },
    // The provider session's JWT stays in memory: never logged or persisted.
    broadcastToken(provider: string, channelId: string): string | undefined {
      return closed ? undefined : host?.broadcastToken(provider, channelId);
    },
    snapshot: () => host?.snapshot() ?? {},
    async close() {
      closed = true;
      lifetime.abort();
      await Promise.all([host?.close(), sockets.close()]);
    },
  };
}
