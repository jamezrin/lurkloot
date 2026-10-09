import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate, ExtensionSettings } from "@lurkloot/shared/models";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { allDiagnostics, deferred, farming, harness } from "../helpers/backgroundController";

function chatSettings(alwaysEnterChat: boolean): ExtensionSettings {
  const settings = farming({ ...DEFAULT_SETTINGS, tablessMode: true });
  return {
    ...settings,
    platform: {
      ...settings.platform,
      kick: { ...settings.platform.kick, enabled: false },
      twitch: { ...settings.platform.twitch, alwaysEnterChat },
    },
  };
}

function tablessTwitch(env: ReturnType<typeof harness>): void {
  const watcher = {
    platform: "twitch" as const,
    channelUrl: undefined as string | undefined,
    async start(_candidate: ChannelCandidate) {},
    async tick() { return { ok: true, live: true }; },
    drainEvents() { return []; },
    async stop() {},
  } satisfies TablessWatchController;
  env.twitch.supportsTabless = true;
  env.twitch.createTablessWatcher = () => watcher;
}

describe("chat presence service", () => {
  it("joins the watched channel's chat for a tabless watch when alwaysEnterChat is on", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tabless" });
    expect(env.chatPresenceFactory).toHaveBeenCalledOnce();
    expect(env.chatPresenceClient.follows).toEqual([{ username: "twitch-creator" }]);
  });

  it("does not create a client when nothing wants presence", async () => {
    const env = harness(chatSettings(false));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.chatPresenceFactory).not.toHaveBeenCalled();
  });

  it("does not create a client for a tab watch", async () => {
    const env = harness({ ...chatSettings(true), tablessMode: false });
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.state.sessions.twitch.watchMode).not.toBe("tabless");
    expect(env.chatPresenceFactory).not.toHaveBeenCalled();
  });

  it("stops the client when auth leaves healthy", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.invalidateAuthHealth("twitch");
    expect(env.chatPresenceClient.stops).toBe(1);
  });

  it("rejoins without waiting for a tick when auth becomes healthy again", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.invalidateAuthHealth("twitch");
    expect(env.chatPresenceClient.stops).toBe(1);
    await env.controller.checkAuthHealth("twitch");
    await env.controller.settleBackgroundWork();
    expect(env.chatPresenceFactory).toHaveBeenCalledTimes(2);
  });

  it("does not create a client when auth was invalidated between the commit and the reconcile", async () => {
    const env = harness(chatSettings(true));
    const starting = deferred<void>();
    const watcher = {
      platform: "twitch" as const,
      channelUrl: undefined as string | undefined,
      // The tick publishes its watcher after the commit and before its
      // conclusion reconciles presence; hold it there.
      async start(_candidate: ChannelCandidate) { await starting.promise; },
      async tick() { return { ok: true, live: true }; },
      drainEvents() { return []; },
      async stop() {},
    } satisfies TablessWatchController;
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => watcher;
    const tick = env.controller.tick(["twitch"], "manual_tick");
    await vi.waitFor(() => expect(env.state.sessions.twitch.status).toBe("watching"));
    await env.controller.invalidateAuthHealth("twitch");
    starting.resolve();
    await tick;
    await env.controller.settleBackgroundWork();
    expect(env.chatPresenceFactory).not.toHaveBeenCalled();
  });

  it("stops presence as soon as a manual watch pauses farming", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.chatPresenceClient.current.state).toBe("joined");
    // Hold the manual-watch tick at its auth probe: only the telemetry commit
    // itself may stop presence.
    const probing = deferred<void>();
    vi.mocked(env.twitch.checkAuthHealth).mockImplementation(async () => {
      await probing.promise;
      return { status: "healthy" as const };
    });
    void env.rawController.handleMessage(
      { type: "playbackTelemetry", platform: "twitch", telemetry: { videoCount: 1, mutedVideoCount: 0, unmutedVideoCount: 1, playingVideoCount: 1, blockedPlaybackCount: 0, documentHidden: false } },
      { tab: { id: 999, url: "https://www.twitch.tv/othercreator" } },
    );
    await vi.waitFor(() => expect(env.chatPresenceClient.stops).toBe(1));
    probing.resolve();
    await env.controller.settleBackgroundWork();
  });

  it("stops the client when the setting is switched off", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: false } } } });
    expect(env.chatPresenceClient.stops).toBe(1);
  });

  it("replaces a blocked client on a settings save, never on a tick", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    env.chatPresenceClient.current = { state: "blocked", channel: "twitch-creator", reason: "auth" };
    await env.controller.tick(["twitch"], "manual_tick");
    expect(env.chatPresenceClient.stops).toBe(0);
    expect(env.chatPresenceFactory).toHaveBeenCalledOnce();

    // Unrelated to Twitch's trigger: any save is the user acting, and retries.
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { kick: { alwaysEnterChat: true } } } });
    await env.controller.settleBackgroundWork();
    expect(env.chatPresenceClient.stops).toBe(1);
    expect(env.chatPresenceFactory).toHaveBeenCalledTimes(2);
    expect(env.chatPresenceClient.follows.at(-1)).toEqual({ username: "twitch-creator" });
  });

  it("keeps a joined client across a settings save", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { kick: { alwaysEnterChat: true } } } });
    await env.controller.settleBackgroundWork();
    expect(env.chatPresenceClient.stops).toBe(0);
    expect(env.chatPresenceFactory).toHaveBeenCalledOnce();
  });

  it("does not keep a client whose start finished after auth was invalidated", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    const blocked = deferred<void>();
    env.chatPresenceClient.followBarrier = blocked.promise;
    const tick = env.controller.tick(["twitch"], "manual_tick");
    await vi.waitFor(() => expect(env.chatPresenceClient.follows).toHaveLength(1));
    await env.controller.invalidateAuthHealth("twitch");
    blocked.resolve();
    await tick;
    await env.controller.settleBackgroundWork();
    expect(env.chatPresenceClient.stops).toBeGreaterThanOrEqual(1);
  });

  it("attaches each platform's presence status to snapshots", async () => {
    const env = harness(chatSettings(true));
    tablessTwitch(env);
    await env.controller.tick(["twitch"], "manual_tick");
    const snapshot = await env.controller.handleMessage({ type: "getSnapshot" }) as { state: { chatPresence?: unknown } };
    expect(snapshot.state.chatPresence).toEqual({ twitch: { state: "joined", channel: "twitch-creator" } });
    expect(env.state).not.toHaveProperty("chatPresence");
  });

  it("starts presence from a commit without a tick, as after a worker restart", async () => {
    const env = harness(chatSettings(true), {
      initialState: {
        ...DEFAULT_STATE,
        authHealth: { ...DEFAULT_STATE.authHealth, twitch: { status: "checking" } },
        sessions: {
          ...DEFAULT_STATE.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            watchMode: "tabless",
            offlineChecks: 0,
            channel: { platform: "twitch", username: "prod", url: "https://www.twitch.tv/prod" },
          },
        },
      },
    });
    // The auth probe commits "healthy" with no scheduler tick involved.
    await env.controller.checkAuthHealth("twitch");
    await env.controller.settleBackgroundWork();
    expect(env.chatPresenceFactory).toHaveBeenCalledOnce();
    expect(env.chatPresenceClient.follows).toEqual([{ username: "prod" }]);
  });

  it("keeps one client across a target change", async () => {
    const watching = (username: string) => ({
      ...DEFAULT_STATE,
      authHealth: { ...DEFAULT_STATE.authHealth, twitch: { status: "healthy" as const } },
      sessions: {
        ...DEFAULT_STATE.sessions,
        twitch: {
          platform: "twitch" as const,
          status: "watching" as const,
          watchMode: "tabless" as const,
          offlineChecks: 0,
          channel: { platform: "twitch" as const, username, url: `https://www.twitch.tv/${username}` },
        },
      },
    });
    const env = harness(chatSettings(true), { initialState: watching("prod") });
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: true } } } });
    // A tick that switches channels commits watching → watching (only a
    // platform that was not watching is ever committed as "starting").
    await env.deps.saveState(watching("diables"));
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: true } } } });
    expect(env.chatPresenceFactory).toHaveBeenCalledOnce();
    expect(env.chatPresenceClient.follows).toEqual([{ username: "prod" }, { username: "diables" }]);
    expect(env.chatPresenceClient.stops).toBe(0);
  });

  it("joins for a committed NoPixelV watch and announces it once", async () => {
    const providerChannel = { platform: "twitch" as const, username: "prod", url: "https://www.twitch.tv/prod", channelId: "174754672" };
    const env = harness(chatSettings(false), {
      initialState: {
        ...DEFAULT_STATE,
        authHealth: { ...DEFAULT_STATE.authHealth, twitch: { status: "healthy" } },
        sessions: {
          ...DEFAULT_STATE.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            watchMode: "tabless",
            offlineChecks: 0,
            channel: providerChannel,
            supplementalWatch: { id: "nopixel", tablessOnly: true },
          },
        },
      },
    });
    // A settings save reconciles presence against the stored state.
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: false } } } });
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { alwaysEnterChat: false } } } });
    expect(env.chatPresenceClient.follows).toEqual([{ username: "prod", channelId: "174754672" }, { username: "prod", channelId: "174754672" }]);
    const announcements = allDiagnostics(env).filter((event) => event.message === "Joined prod's chat because nopixel needs chat presence to earn watch time");
    expect(announcements).toHaveLength(1);
  });
});
