import { vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type {
  ChannelCandidate,
  ChannelCheck,
  Platform,
  SchedulerState,
} from "@lurkloot/shared/models";
import { DEFAULT_CLI_SETTINGS } from "../../src/settings";
import type { TransportHandle } from "../../src/transport";

// An offline adapter: healthy auth and empty data, so a loop ticks without
// touching the network.
export function idleAdapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: async () => ({ status: "healthy", message: { key: "authHealthy" } }),
    refreshCampaigns: async () => [],
    listCandidateChannels: async () => [],
    checkChannel: async (candidate: ChannelCandidate): Promise<ChannelCheck> => ({
      live: false,
      categoryMatches: false,
      candidate,
    }),
    claimReward: async () => false,
  };
}

export function idleTransport(): TransportHandle {
  const adapters = { twitch: idleAdapter("twitch"), kick: idleAdapter("kick") };
  const compatibility = () =>
    resolveCompatibility(DEFAULT_CLI_SETTINGS.compatibility, {
      host: "cli",
      twitchIdentity: "web",
    });
  return {
    adapters,
    createAdapter: (platform) => ({ adapter: adapters[platform], ...compatibility() }),
    createAdapters: () => ({ adapters, ...compatibility() }),
    dispose: vi.fn(async () => undefined),
  };
}

// An in-memory state store, so loop tests write no state file.
export function memoryStateStore(): {
  load(): Promise<SchedulerState>;
  save(state: SchedulerState): Promise<void>;
} {
  let state = structuredClone(DEFAULT_STATE);
  return {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
}
