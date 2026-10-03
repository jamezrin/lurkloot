import { describe, expect, it, vi } from "vitest";
import type { CommittedChange } from "@lurkloot/core/controller";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import { createTwitchExtensionCommitHook, twitchExtensionCommitEffect } from "../src/extensions/commitHook";
import { createTwitchExtensionHost } from "../src/extensions/host";

// #594: the lane follows the controller's accepted commits, not storage events
// or every alarm.

function watchingState(): SchedulerState {
  const state = structuredClone(DEFAULT_STATE);
  state.authHealth.twitch = { status: "healthy" };
  state.sessions.twitch = {
    platform: "twitch",
    status: "watching",
    offlineChecks: 0,
    watchMode: "tabless",
    supplementalWatch: { id: "nopixel", tablessOnly: true },
    channel: { platform: "twitch", username: "buddha", url: "https://www.twitch.tv/buddha", channelId: "123" },
  };
  return state;
}

function stateChange(
  mutate: (next: SchedulerState) => void,
  platforms: ("twitch" | "kick")[] = ["twitch"],
  previous = watchingState(),
): CommittedChange<ExtensionSettings> {
  const state = structuredClone(previous);
  mutate(state);
  return { kind: "state", platforms, previous, state, committedAt: Date.now() };
}

function settingsChange(
  mutate: (next: ExtensionSettings) => void,
  twitchEffect: "discovery" | "selection" = "discovery",
): CommittedChange<ExtensionSettings> {
  const previous = structuredClone(DEFAULT_SETTINGS);
  const settings = structuredClone(previous);
  mutate(settings);
  return { kind: "settings", previous, patch: {}, settings, effects: { twitch: twitchEffect }, startup: false };
}

describe("Twitch Extensions commit effects", () => {
  it("ignores a ranking-only settings save", () => {
    expect(twitchExtensionCommitEffect(settingsChange((settings) => {
      settings.farmPinnedOnly = !settings.farmPinnedOnly;
    }, "selection"))).toEqual({ reconcile: false });
  });

  it("reconciles without invalidating after an unrelated settings save", () => {
    expect(twitchExtensionCommitEffect(settingsChange((settings) => {
      settings.diagnosticLogging = !settings.diagnosticLogging;
    }))).toEqual({ reconcile: true });
  });

  it.each([
    ["pauseOnManualWatch", (settings: ExtensionSettings) => { settings.pauseOnManualWatch = !settings.pauseOnManualWatch; }],
    ["Twitch enabled", (settings: ExtensionSettings) => { settings.platform.twitch.enabled = !settings.platform.twitch.enabled; }],
    ["NoPixelV enabled", (settings: ExtensionSettings) => { settings.twitchExtensions.nopixel.enabled = !settings.twitchExtensions.nopixel.enabled; }],
    ["Fortnite enabled", (settings: ExtensionSettings) => { settings.twitchExtensions.fortnite.enabled = !settings.twitchExtensions.fortnite.enabled; }],
    ["auto-open packs", (settings: ExtensionSettings) => { settings.twitchExtensions.nopixel.autoOpenPacks = !settings.twitchExtensions.nopixel.autoOpenPacks; }],
    ["takeovers", (settings: ExtensionSettings) => { settings.twitchExtensions.fortnite.allowTakeovers = !settings.twitchExtensions.fortnite.allowTakeovers; }],
  ])("invalidates, dropping completion, when %s changes", (_name, mutate) => {
    expect(twitchExtensionCommitEffect(settingsChange(mutate)))
      .toEqual({ invalidate: { preserveCompleted: false }, reconcile: true });
  });

  it("ignores a state commit that does not touch Twitch", () => {
    expect(twitchExtensionCommitEffect(stateChange((state) => {
      state.sessions.kick = { ...state.sessions.kick, status: "watching" };
    }, ["kick"]))).toEqual({ reconcile: false });
  });

  it("reconciles without invalidating on a Twitch heartbeat result", () => {
    expect(twitchExtensionCommitEffect(stateChange((state) => {
      state.sessions.twitch.lastHeartbeatAt = new Date().toISOString();
      state.sessions.twitch.lastHeartbeatOk = true;
    }))).toEqual({ reconcile: true });
  });

  it.each([
    ["the session status", (state: SchedulerState) => { state.sessions.twitch.status = "idle"; }],
    ["the channel", (state: SchedulerState) => { state.sessions.twitch.channel = { ...state.sessions.twitch.channel!, channelId: "456" }; }],
    ["a manual close pause", (state: SchedulerState) => { state.manualClosePause = { twitch: { platform: "twitch", closedAt: new Date().toISOString() } }; }],
    ["a manual watch", (state: SchedulerState) => { state.manualWatch = { twitch: { active: true } } as SchedulerState["manualWatch"]; }],
  ])("invalidates, keeping completion while auth stays healthy, when %s changes", (_name, mutate) => {
    expect(twitchExtensionCommitEffect(stateChange(mutate)))
      .toEqual({ invalidate: { preserveCompleted: true }, reconcile: true });
  });

  it("hands a tabless-only session's failed heartbeat result to the host", () => {
    expect(twitchExtensionCommitEffect(stateChange((state) => {
      state.sessions.twitch.lastHeartbeatAt = new Date().toISOString();
      state.sessions.twitch.lastHeartbeatOk = false;
      state.sessions.twitch.heartbeatChecks = 2;
    }))).toEqual({ reconcile: true, heartbeatFailure: { provider: "nopixel", username: "buddha", heartbeatChecks: 2 } });
  });

  it.each([
    ["a successful result", (state: SchedulerState) => { state.sessions.twitch.lastHeartbeatAt = new Date().toISOString(); state.sessions.twitch.lastHeartbeatOk = true; }],
    ["a commit with no new result", (state: SchedulerState) => { state.sessions.twitch.lastHeartbeatOk = false; }],
    ["an ordinary drop session", (state: SchedulerState) => {
      state.sessions.twitch.supplementalWatch = undefined;
      state.sessions.twitch.lastHeartbeatAt = new Date().toISOString();
      state.sessions.twitch.lastHeartbeatOk = false;
    }],
  ])("hands nothing to the host for %s", (_name, mutate) => {
    expect(twitchExtensionCommitEffect(stateChange(mutate)).heartbeatFailure).toBeUndefined();
  });

  it("invalidates and drops completion when Twitch auth stops being healthy", () => {
    expect(twitchExtensionCommitEffect(stateChange((state) => {
      state.authHealth.twitch = { status: "invalid_credentials", checkedAt: new Date().toISOString(), reasonCode: "credentials_rejected", message: { key: "authInvalidCredentials" } };
    }))).toEqual({ invalidate: { preserveCompleted: false }, reconcile: true });
  });
});

describe("Twitch Extensions commit hook", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("invalidates synchronously and never waits on the reconcile", async () => {
    const blocked = deferred();
    const host = { invalidate: vi.fn(), reconcile: vi.fn(() => blocked.promise) };
    const hook = createTwitchExtensionCommitHook(host, vi.fn());

    const result = hook.onCommit(stateChange((state) => { state.sessions.twitch.status = "idle"; }));

    expect(result).toBeUndefined();
    expect(host.invalidate).toHaveBeenCalledWith({ preserveCompleted: true });
    expect(host.reconcile).toHaveBeenCalledOnce();
    blocked.resolve();
    await hook.reconcile();
  });

  it("runs one reconcile at a time, with a single re-run for requests made meanwhile", async () => {
    const first = deferred();
    const host = { invalidate: vi.fn(), reconcile: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined) };
    const hook = createTwitchExtensionCommitHook(host, vi.fn());
    const heartbeat = stateChange((state) => { state.sessions.twitch.lastHeartbeatAt = new Date().toISOString(); });

    hook.onCommit(heartbeat);
    hook.onCommit(heartbeat);
    hook.onCommit(heartbeat);
    const settled = hook.reconcile();
    expect(host.reconcile).toHaveBeenCalledOnce();
    first.resolve();
    await settled;

    expect(host.reconcile).toHaveBeenCalledTimes(2);
  });

  // The last run can end a few microtasks after its reconcile returns; a
  // request made at any point in that window must still run.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("does not drop a request made %i microtasks after the last run returns", async (depth) => {
    let calls = 0;
    let hook!: ReturnType<typeof createTwitchExtensionCommitHook>;
    const later = (remaining: number, run: () => void) => queueMicrotask(remaining <= 1 ? run : () => later(remaining - 1, run));
    const host = {
      invalidate: vi.fn(),
      reconcile: vi.fn(async () => {
        calls += 1;
        if (calls === 1) later(depth, () => { void hook.reconcile(); });
      }),
    };
    hook = createTwitchExtensionCommitHook(host, vi.fn());
    await hook.reconcile();
    await vi.waitFor(() => expect(host.reconcile).toHaveBeenCalledTimes(2));
  });

  it("reports a failed reconcile without its error", async () => {
    const failed = vi.fn();
    const hook = createTwitchExtensionCommitHook({ invalidate: vi.fn(), reconcile: vi.fn(async () => { throw new Error("private provider body"); }) }, failed);
    await hook.reconcile();
    expect(failed).toHaveBeenCalledWith();
  });
});

// The every-alarm reconcile used to pace driver refreshes and session renewal.
// A tabless-only session commits a heartbeat result every minute, so Twitch
// commits keep that cadence.
describe("Twitch Extensions refresh cadence", () => {
  const provider = twitchExtensionProviders.find((candidate) => candidate.id === "nopixel")!;

  async function running() {
    let now = 1_800_000_000_000;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.platform.twitch.enabled = true;
    settings.twitchExtensions.nopixel.enabled = true;
    const state = watchingState();
    const refresh = vi.fn(async () => undefined);
    const driver = vi.fn(async () => ({ stop: vi.fn(), refresh }));
    const query = vi.fn(async () => {
      const jwt = `eyJheader.${btoa(JSON.stringify({ channel_id: "123", exp: now / 1000 + 3600, role: "viewer", opaque_user_id: "Uviewer", user_id: "viewer" })).replace(/=/g, "")}.signature`;
      return { data: { user: { channel: { selfInstalledExtensions: [{ installation: { extension: { id: provider.extensionId, version: "1.0.0" }, activationConfig: { state: "ACTIVE" } }, token: { jwt } }] } } } };
    });
    const host = createTwitchExtensionHost({
      source: { query, hasSession: async () => true, now: () => now },
      permissions: { contains: async () => true, request: async () => { throw new Error("UI must request grants"); } },
      drivers: { nopixel: driver },
      loadSettings: async () => settings,
      loadState: async () => state,
      savePatch: async () => undefined,
      diagnostic: vi.fn(),
      publish: vi.fn(),
    });
    const hook = createTwitchExtensionCommitHook(host, vi.fn());
    await host.setEnabled("nopixel", true);
    await hook.reconcile();
    expect(driver).toHaveBeenCalledOnce();
    return { hook, refresh, driver, state, advance: (ms: number) => { now += ms; } };
  }

  it("refreshes a running driver when a Twitch heartbeat result commits after its interval", async () => {
    const s = await running();
    s.advance(provider.minRefreshIntervalMs);
    s.hook.onCommit(stateChange((state) => { state.sessions.twitch.lastHeartbeatAt = new Date().toISOString(); }, ["twitch"], s.state));
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalledOnce());
    expect(s.driver).toHaveBeenCalledOnce();
  });

  it("does not refresh on a Kick commit", async () => {
    const s = await running();
    s.advance(provider.minRefreshIntervalMs);
    s.hook.onCommit(stateChange((state) => { state.sessions.kick.lastCheckedAt = new Date().toISOString(); }, ["kick"], s.state));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.refresh).not.toHaveBeenCalled();
  });
});
