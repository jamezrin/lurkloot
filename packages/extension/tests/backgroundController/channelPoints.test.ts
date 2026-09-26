import { afterEach, describe, expect, it, vi } from "vitest";
import { TWITCH_ALARM_NAME, TWITCH_CHANNEL_POINTS_ALARM_NAME } from "@lurkloot/core/controller";
import type { ChannelCandidate, ExtensionSettings, PlatformAuthHealth } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { allDiagnostics, channel, deferred, farming, harness } from "../helpers/backgroundController";

// Twitch channel points: the job, claim-only runs and the push observer.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Twitch channel points alarm lifecycle", () => {
    it("creates a fixed one-minute alarm independently of the scheduler interval", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pollIntervalMinutes: 60 }));

      await env.controller.ensureAlarm();

      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_CHANNEL_POINTS_ALARM_NAME,
        { periodInMinutes: 1 },
      );
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_ALARM_NAME,
        { periodInMinutes: 60 },
      );
    });

    it.each([
      { twitchEnabled: false, autoClaimChannelPoints: true },
      { twitchEnabled: true, autoClaimChannelPoints: false },
    ])("clears the alarm when a prerequisite is disabled", async ({ twitchEnabled, autoClaimChannelPoints }) => {
      const enabledSettings = farming(DEFAULT_SETTINGS);
      const env = harness({
        ...enabledSettings,
        platform: {
          ...enabledSettings.platform,
          twitch: {
            ...enabledSettings.platform.twitch,
            enabled: twitchEnabled,
            autoClaimChannelPoints,
          },
        },
      });

      await env.controller.ensureAlarm();

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
      expect(env.deps.createAlarm).not.toHaveBeenCalledWith(
        TWITCH_CHANNEL_POINTS_ALARM_NAME,
        expect.anything(),
      );
    });

    it("reconciles the alarm after settings changes", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));

      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: { platform: { twitch: { autoClaimChannelPoints: false } } },
      });

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    });

    it("clears the alarm when startup normalization disables Twitch", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));

      await env.controller.handleStartup();

      expect(env.settings.platform.twitch.enabled).toBe(false);
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    });

    it("clears the alarm during reset and shutdown", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));

      await env.controller.prepareForHostReset();
      env.controller.shutdown();

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_CHANNEL_POINTS_ALARM_NAME);
    });

    it("continues host reset when clearing the alarm fails", async () => {
      const resetHostStorage = vi.fn(async () => undefined);
      const env = harness(farming(DEFAULT_SETTINGS), {
        clearAlarm: async (name) => {
          if (name === TWITCH_CHANNEL_POINTS_ALARM_NAME) {
            throw new Error("alarm storage unavailable");
          }
          return true;
        },
      });

      await expect(env.controller.prepareForHostReset(resetHostStorage)).resolves.toBeUndefined();

      expect(resetHostStorage).toHaveBeenCalledOnce();
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch channel-points alarm",
      }));
    });

    it("contains alarm cleanup failures during shutdown", async () => {
      const env = harness(farming(DEFAULT_SETTINGS), {
        clearAlarm: async (name) => {
          if (name === TWITCH_CHANNEL_POINTS_ALARM_NAME) {
            throw new Error("alarm storage unavailable");
          }
          return true;
        },
      });

      env.controller.shutdown();

      await vi.waitFor(() => expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch channel-points alarm",
      })));
    });
  });

  describe("Twitch channel points claim-only operation", () => {
    it("claims for a recent manual channel without changing the paused session", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      const manualChannel = channel("twitch", { username: "manual-creator", url: "https://www.twitch.tv/manual-creator" });
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "paused",
        channel: channel("twitch", { username: "old-managed" }),
        offlineChecks: 0,
        reasonCode: "manual_watch",
        message: "Manual watch detected",
      };
      env.state.manualWatch = {
        twitch: {
          platform: "twitch",
          tabId: 91,
          checkedAt: new Date().toISOString(),
          active: true,
          channel: manualChannel,
        },
      };
      const beforeSession = structuredClone(env.state.sessions.twitch);
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(manualChannel);
      expect(env.state.sessions.twitch).toEqual(beforeSession);
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "info",
        message: "Claimed channel points for manual-creator",
      }));
    });

    it.each(["tab", "tabless"] as const)("claims for a managed %s watch session", async (watchMode) => {
      const env = harness(farming(DEFAULT_SETTINGS));
      const managedChannel = channel("twitch");
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: managedChannel,
        offlineChecks: 0,
        watchMode,
      };
      env.twitch.claimChannelPoints = vi.fn(async () => false);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(managedChannel);
      expect(allDiagnostics(env).some((event) => event.message.includes("Claimed channel points"))).toBe(false);
    });

    it.each([
      { name: "Twitch is disabled", enabled: false, autoClaim: true, authStatus: "healthy", manual: "recent" },
      { name: "auto-claim is disabled", enabled: true, autoClaim: false, authStatus: "healthy", manual: "recent" },
      { name: "authentication is unknown", enabled: true, autoClaim: true, authStatus: "unknown", manual: "recent" },
      { name: "authentication is unhealthy", enabled: true, autoClaim: true, authStatus: "unhealthy", manual: "recent" },
      { name: "manual telemetry is stale", enabled: true, autoClaim: true, authStatus: "healthy", manual: "stale" },
      { name: "manual telemetry is inactive", enabled: true, autoClaim: true, authStatus: "healthy", manual: "inactive" },
      { name: "the manual channel is unidentified", enabled: true, autoClaim: true, authStatus: "healthy", manual: "unidentified" },
    ] as const)("makes no request when $name", async ({ enabled, autoClaim, authStatus, manual }) => {
      const enabledSettings = farming(DEFAULT_SETTINGS);
      const env = harness({
        ...enabledSettings,
        platform: {
          ...enabledSettings.platform,
          twitch: {
            ...enabledSettings.platform.twitch,
            enabled,
            autoClaimChannelPoints: autoClaim,
          },
        },
      });
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: {
          status: authStatus,
          checkedAt: new Date().toISOString(),
          ...(authStatus === "unhealthy" ? { reason: "signed out" } : {}),
        } as PlatformAuthHealth,
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "paused",
        offlineChecks: 0,
        reasonCode: "manual_watch",
      };
      env.state.manualWatch = {
        twitch: {
          platform: "twitch",
          tabId: 91,
          checkedAt: new Date(manual === "stale" ? Date.now() - 120_000 : Date.now()).toISOString(),
          active: manual !== "inactive",
          ...(manual === "unidentified" ? {} : { channel: channel("twitch") }),
        },
      };
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
    });

    it("reports claim failures without changing scheduler state or starting other work", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: channel("twitch"),
        offlineChecks: 2,
        errorChecks: 3,
        retryAfter: "2026-12-09T23:59:00.000Z",
        heartbeatChecks: 4,
        lastHeartbeatOk: false,
        tablessFallback: true,
        watchMode: "tabless",
      };
      const before = structuredClone(env.state);
      env.twitch.claimChannelPoints = vi.fn(async () => {
        throw new Error("Channel points lookup failed");
      });

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.state).toEqual(before);
      expect(env.deps.saveState).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Channel points lookup failed",
      }));
    });

    it("does not fall back to a managed channel during unidentified active manual playback", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: channel("twitch", { username: "stale-managed" }),
        offlineChecks: 0,
        watchMode: "tab",
      };
      env.state.manualWatch = {
        twitch: {
          platform: "twitch",
          tabId: 91,
          checkedAt: new Date().toISOString(),
          active: true,
        },
      };
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).not.toHaveBeenCalled();
    });

    it("serializes repeated claims and normal Twitch scheduler work", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: channel("twitch"),
        offlineChecks: 0,
        watchMode: "tab",
      };
      const firstClaim = deferred<boolean>();
      let concurrentClaims = 0;
      let maxConcurrentClaims = 0;
      env.twitch.claimChannelPoints = vi.fn(async () => {
        concurrentClaims += 1;
        maxConcurrentClaims = Math.max(maxConcurrentClaims, concurrentClaims);
        const result = await firstClaim.promise;
        concurrentClaims -= 1;
        return result;
      });

      const first = env.controller.runTwitchChannelPointsClaim();
      await vi.waitFor(() => expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce());
      const second = env.controller.runTwitchChannelPointsClaim();
      const tick = env.controller.tick(["twitch"]);
      await Promise.resolve();

      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      firstClaim.resolve(false);
      await Promise.all([first, second, tick]);

      expect(maxConcurrentClaims).toBe(1);
      expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    });
  });

  describe("Twitch channel points push observer", () => {
    function pushSettings(patch: Partial<ExtensionSettings["platform"]["twitch"]> = {}): ExtensionSettings {
      const enabled = farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false });
      return {
        ...enabled,
        platform: {
          ...enabled.platform,
          twitch: {
            ...enabled.platform.twitch,
            ...patch,
          },
        },
      };
    }

    function configureEligibleChannel(
      env: ReturnType<typeof harness>,
      patch: Partial<ChannelCandidate> = { channelId: "channel-1" },
    ): ChannelCandidate {
      const eligible = channel("twitch", patch);
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        channel: eligible,
        offlineChecks: 0,
        watchMode: "tab",
      };
      return eligible;
    }

    async function startObserver(env: ReturnType<typeof harness>, patch?: Partial<ChannelCandidate>): Promise<void> {
      configureEligibleChannel(env, patch);
      env.twitch.claimChannelPoints = vi.fn(async () => true);
      await env.controller.ensureAlarm();
      await env.rawController.settleBackgroundWork();
      expect(env.channelPointsPushController.starts).toBe(1);
      expect(env.channelPointsPushController.stops).toBe(0);
    }

    it("starts the observer once and does not stop on a second reconcile", async () => {
      const env = harness(pushSettings());
      await startObserver(env);

      await env.controller.ensureAlarm();
      await env.rawController.settleBackgroundWork();

      expect(env.channelPointsPushFactory).toHaveBeenCalledOnce();
      expect(env.channelPointsPushController.stops).toBe(0);
    });

    it("recreates the observer after a start failure", async () => {
      const env = harness(pushSettings());
      configureEligibleChannel(env);
      env.channelPointsPushController.startError = new Error("start failed");

      await env.controller.ensureAlarm();
      await env.rawController.settleBackgroundWork();
      expect(env.channelPointsPushFactory).toHaveBeenCalledOnce();
      expect(env.channelPointsPushController.starts).toBe(1);

      await env.controller.ensureAlarm();
      await env.rawController.settleBackgroundWork();
      expect(env.channelPointsPushFactory).toHaveBeenCalledTimes(2);
      expect(env.channelPointsPushController.starts).toBe(2);
    });

    it.each([
      {
        name: "the live-event setting is off",
        apply: async (env: ReturnType<typeof harness>) => {
          await env.controller.handleMessage({
            type: "saveSettings",
            settingsPatch: { platform: { twitch: { channelPointsPushClaim: false } } },
          });
        },
      },
      {
        name: "auto-claim is off",
        apply: async (env: ReturnType<typeof harness>) => {
          await env.controller.handleMessage({
            type: "saveSettings",
            settingsPatch: { platform: { twitch: { autoClaimChannelPoints: false } } },
          });
        },
      },
      {
        name: "Twitch is disabled",
        apply: async (env: ReturnType<typeof harness>) => {
          await env.controller.handleMessage({
            type: "setPlatformEnabled",
            platform: "twitch",
            enabled: false,
          });
        },
      },
      {
        name: "authentication is unhealthy",
        apply: async (env: ReturnType<typeof harness>) => {
          env.state.authHealth = {
            ...env.state.authHealth,
            twitch: {
              status: "invalid_credentials",
              checkedAt: new Date().toISOString(),
              reasonCode: "credentials_rejected",
              message: { key: "authInvalidCredentials" },
            },
          };
          await env.controller.ensureAlarm();
        },
      },
      {
        name: "no eligible channel remains",
        apply: async (env: ReturnType<typeof harness>) => {
          env.state.sessions.twitch = { platform: "twitch", status: "idle", offlineChecks: 0 };
          env.state.manualWatch = undefined;
          await env.controller.ensureAlarm();
        },
      },
    ])("stops the observer when $name", async ({ apply }) => {
      const env = harness(pushSettings());
      await startObserver(env);

      await apply(env);
      await env.rawController.settleBackgroundWork();

      expect(env.channelPointsPushController.stops).toBe(1);
    });

    it.each(["reset", "shutdown"] as const)("stops the observer during host %s", async (cleanup) => {
      const env = harness(pushSettings());
      await startObserver(env);

      if (cleanup === "reset") {
        await env.controller.prepareForHostReset();
      } else {
        env.controller.shutdown();
      }
      await env.rawController.settleBackgroundWork();

      expect(env.channelPointsPushController.stops).toBe(1);
    });

    it("starts or stops from a live-event setting toggle without waiting for the alarm", async () => {
      const env = harness(pushSettings({ channelPointsPushClaim: false }));
      configureEligibleChannel(env);
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.ensureAlarm();
      expect(env.channelPointsPushController.starts).toBe(0);

      env.deps.createAlarm.mockClear();
      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: { platform: { twitch: { channelPointsPushClaim: true } } },
      });

      expect(env.channelPointsPushController.starts).toBe(1);
      expect(env.channelPointsPushController.stops).toBe(0);

      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: { platform: { twitch: { channelPointsPushClaim: false } } },
      });

      expect(env.channelPointsPushController.stops).toBe(1);
    });

    it("saveSettings that enables live-event claiming resolves while start is blocked", async () => {
      const env = harness(pushSettings({ channelPointsPushClaim: false }));
      configureEligibleChannel(env);
      const blocked = deferred<void>();
      env.channelPointsPushController.startBarrier = blocked.promise;

      const save = env.rawController.handleMessage({
        type: "saveSettings",
        settingsPatch: { platform: { twitch: { channelPointsPushClaim: true } } },
      });
      const outcome = await Promise.race([
        save.then(() => "saved" as const),
        new Promise<"blocked">((resolve) => {
          setTimeout(() => resolve("blocked"), 50);
        }),
      ]);

      expect(outcome).toBe("saved");
      expect(env.settings.platform.twitch.channelPointsPushClaim).toBe(true);

      blocked.resolve();
      await env.rawController.settleBackgroundWork();
      expect(env.channelPointsPushController.starts).toBe(1);
    });

    it("skips the alarm lookup while the observer is subscribed", async () => {
      const env = harness(pushSettings());
      await startObserver(env);
      env.channelPointsPushController.subscribed = true;
      env.twitch.claimChannelPoints = vi.fn(async () => true);

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).not.toHaveBeenCalled();
    });

    it("still looks up channel points when the observer is not subscribed", async () => {
      const env = harness(pushSettings());
      const eligible = configureEligibleChannel(env);
      env.twitch.claimChannelPoints = vi.fn(async () => true);
      await env.controller.ensureAlarm();
      await env.rawController.settleBackgroundWork();
      env.channelPointsPushController.subscribed = false;

      await env.controller.runTwitchChannelPointsClaim();

      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(eligible);
    });

    it("claims from a live-event notice for the eligible channel", async () => {
      const env = harness(pushSettings());
      await startObserver(env);

      env.channelPointsPushController.emitClaim({ claimId: "claim-1", channelId: "channel-1" });
      await vi.waitFor(() => expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "channel-1" }),
        expect.objectContaining({ claimId: "claim-1", channelId: "channel-1" }),
      ));
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "info",
        message: "Claimed channel points for twitch-creator",
      }));
    });

    it("drops a live-event notice whose channel id does not match the eligible channel", async () => {
      const env = harness(pushSettings());
      await startObserver(env, { channelId: "a" });

      env.channelPointsPushController.emitClaim({ claimId: "claim-1", channelId: "b" });
      await env.controller.settleBackgroundWork();

      expect(env.twitch.claimChannelPoints).not.toHaveBeenCalled();
    });

    it("claims a live-event notice when the eligible channel has no channel id", async () => {
      const env = harness(pushSettings());
      await startObserver(env, { username: "manual-creator" });

      env.channelPointsPushController.emitClaim({ claimId: "claim-1", channelId: "channel-1" });
      await vi.waitFor(() => expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(
        expect.objectContaining({ username: "manual-creator" }),
        expect.objectContaining({ claimId: "claim-1", channelId: "channel-1" }),
      ));
    });

    it("dedupes an in-flight live-event claim id to a single mutation", async () => {
      const env = harness(pushSettings());
      await startObserver(env);
      const firstClaim = deferred<boolean>();
      env.twitch.claimChannelPoints = vi.fn(async () => firstClaim.promise);

      env.channelPointsPushController.emitClaim({ claimId: "claim-1", channelId: "channel-1" });
      await vi.waitFor(() => expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce());
      env.channelPointsPushController.emitClaim({ claimId: "claim-1", channelId: "channel-1" });
      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
      firstClaim.resolve(true);
      await env.controller.settleBackgroundWork();
      expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce();
    });

    it("does not mutate session error or heartbeat state when the observer reports a failure", async () => {
      const env = harness(pushSettings());
      configureEligibleChannel(env);
      env.state.sessions.twitch = {
        ...env.state.sessions.twitch,
        errorChecks: 3,
        heartbeatChecks: 4,
        lastHeartbeatOk: false,
        tablessFallback: true,
        watchMode: "tabless",
      };
      const beforeSession = structuredClone(env.state.sessions.twitch);
      env.channelPointsPushController.pushDiagnostic("Hermes reconnect failed");

      await env.controller.ensureAlarm();
      await env.rawController.settleBackgroundWork();

      expect(env.state.sessions.twitch).toEqual(beforeSession);
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Hermes reconnect failed",
      }));
    });
  });
});
