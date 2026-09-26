import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TWITCH_INTEGRITY_ALARM_NAME } from "@lurkloot/core/controller";
import type { DropCampaign, ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import type { DiagnosticEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import {
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrityWithBrowser,
  registerManagedPageContextTabs,
  resetTwitchIntegrityRefreshBounds,
  setTwitchIntegrity,
  type BrowserTabApi,
} from "@lurkloot/core/tabs";
import { TAB_CHURN_LIMIT } from "@lurkloot/core/criticalHealth";
import type { TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import {
  allDiagnostics,
  asSnapshot,
  campaign,
  deferred,
  farming,
  harness,
  integrityBundle,
  integrityHeaders,
  notFarming,
} from "../helpers/backgroundController";

// The Twitch integrity token.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Twitch integrity expiry scheduling", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      setTwitchIntegrity(undefined);
    });

    afterEach(() => {
      setTwitchIntegrity(undefined);
      vi.useRealTimers();
    });

    it("schedules integrity refresh from token expiry with stable bounded jitter", async () => {
      const integrity = integrityBundle({
        integrity: "stable-test-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      const calls = env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      );
      expect(calls).toHaveLength(1);
      const when = (calls[0][1] as { when: number }).when;
      expect(when).toBeLessThanOrEqual(integrity.expiresAt - 120_000);
      expect(when).toBeGreaterThanOrEqual(integrity.expiresAt - 150_000);
    });

    it("ignores an expired stored token and reports why", async () => {
      const integrity = integrityBundle({
        integrity: "expired-test-token",
        expiresAt: Date.now() - 1,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
      const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
      expect(events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "debug",
        message: expect.stringContaining("expired"),
      }));
    });

    it("persists a captured replacement and replaces its one-shot schedule", async () => {
      const stored = integrityBundle({
        integrity: "stored-test-token",
        expiresAt: Date.now() + 25 * 60_000,
      });
      const replacement = integrityBundle({
        integrity: "replacement-test-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const saveTwitchIntegrity = vi.fn(async () => undefined);
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => stored,
        saveTwitchIntegrity,
      });
      await env.controller.settleBackgroundWork();

      await env.controller.captureTwitchIntegrity(integrityHeaders(replacement));

      expect(saveTwitchIntegrity).toHaveBeenCalledWith(replacement);
      const calls = env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      );
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).not.toEqual(calls[0][1]);
    });

    it("installs and persists a fresh capture without scheduling after Twitch is disabled", async () => {
      const integrity = integrityBundle({
        integrity: "captured-while-disabled",
      });
      const saveTwitchIntegrity = vi.fn(async () => undefined);
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        saveTwitchIntegrity,
      });
      await env.controller.settleBackgroundWork();

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await env.controller.captureTwitchIntegrity(integrityHeaders(integrity));

      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(saveTwitchIntegrity).toHaveBeenCalledWith(integrity);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("restores capture scheduling when a concurrent disable save fails", async () => {
      const integrity = integrityBundle({
        integrity: "captured-during-failed-disable",
      });
      const captureSave = deferred<void>();
      const capturePersisted = deferred<void>();
      const disableSave = deferred<void>();
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        saveTwitchIntegrity: async () => {
          await captureSave.promise;
          capturePersisted.resolve();
        },
        saveSettings: async () => {
          await disableSave.promise;
          throw new Error("settings storage unavailable");
        },
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(integrity));
      await vi.waitFor(() => expect(env.deps.saveTwitchIntegrity).toHaveBeenCalledOnce());
      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

      captureSave.resolve();
      await capturePersisted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      disableSave.resolve();

      await expect(disabling).rejects.toThrow("settings storage unavailable");
      await capturing;

      expect(env.settings.platform.twitch.enabled).toBe(true);
      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
    });

    it("keeps a successful disable authoritative over a capture waiting for persistence", async () => {
      const integrity = integrityBundle({
        integrity: "captured-during-successful-disable",
      });
      const captureSave = deferred<void>();
      const capturePersisted = deferred<void>();
      const disableSave = deferred<void>();
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        saveTwitchIntegrity: async () => {
          await captureSave.promise;
          capturePersisted.resolve();
        },
        saveSettings: async () => disableSave.promise,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();

      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(integrity));
      await vi.waitFor(() => expect(env.deps.saveTwitchIntegrity).toHaveBeenCalledOnce());
      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

      captureSave.resolve();
      await capturePersisted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      disableSave.resolve();
      await Promise.all([capturing, disabling]);

      expect(env.settings.platform.twitch.enabled).toBe(false);
      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
    });

    it("installs valid stored integrity without scheduling when Twitch starts disabled", async () => {
      const integrity = integrityBundle({
        integrity: "stored-while-disabled",
      });
      const env = harness({
        ...farming(DEFAULT_SETTINGS),
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        },
      }, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("uses the same refresh jitter for the same token", async () => {
      const integrity = integrityBundle({
        integrity: "same-token-stable-jitter",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await second.controller.settleBackgroundWork();

      const firstWhen = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      const secondWhen = (second.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      expect(secondWhen).toBe(firstWhen);
    });

    it("does not recreate or relog an unchanged Twitch integrity alarm", async () => {
      const integrity = integrityBundle({
        integrity: "unchanged-alarm-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const scheduledTime = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;

      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        getAlarm: async () => ({ scheduledTime }),
      });
      await second.controller.settleBackgroundWork();

      expect(second.deps.createAlarm).not.toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.anything(),
      );
      expect(second.reportEvents.mock.calls.flatMap(([events]) => events)).not.toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("Scheduled proactive Twitch integrity refresh"),
        }),
      );
    });

    it("recreates and reports a Twitch integrity alarm when its existing target is stale", async () => {
      const integrity = integrityBundle({
        integrity: "stale-alarm-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const scheduledTime = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        getAlarm: async () => ({ scheduledTime: scheduledTime + 1_001 }),
      });
      await second.controller.settleBackgroundWork();

      expect(second.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        { when: scheduledTime },
      );
      expect(second.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          message: `Scheduled proactive Twitch integrity refresh for ${new Date(scheduledTime).toISOString()}`,
        }),
      );
    });

    it("recreates and reports a Twitch integrity alarm when lookup fails", async () => {
      const integrity = integrityBundle({
        integrity: "unreadable-alarm-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const first = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await first.controller.settleBackgroundWork();
      const scheduledTime = (first.deps.createAlarm.mock.calls.find(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )?.[1] as { when: number }).when;
      const second = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        getAlarm: async () => {
          throw new Error("browser alarm lookup failed");
        },
      });
      await second.controller.settleBackgroundWork();

      expect(second.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        { when: scheduledTime },
      );
      expect(second.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          message: `Scheduled proactive Twitch integrity refresh for ${new Date(scheduledTime).toISOString()}`,
        }),
      );
    });

    it("rechecks stored integrity scheduling when the refresh handler runs", async () => {
      const integrity = integrityBundle({
        integrity: "refresh-handler-test-token",
      });
      const loadTwitchIntegrity = vi.fn(async () => integrity);
      const env = harness(undefined, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();

      await env.controller.runTwitchIntegrityRefresh();

      expect(loadTwitchIntegrity).toHaveBeenCalledTimes(2);
      expect(env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toHaveLength(2);
    });

    it("clears a prior alarm instead of creating an immediate refresh", async () => {
      const integrity = integrityBundle({
        expiresAt: Date.now() + 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });

      await env.controller.settleBackgroundWork();

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
    });

    it("forces the next normal tick to replace a valid token whose refresh target is already due", async () => {
      const integrity = integrityBundle({
        integrity: "due-on-next-normal-tick",
        expiresAt: Date.now() + 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      await env.controller.tick(["twitch"], "alarm");

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          forceRefresh: true,
          rejectedToken: integrity.integrity,
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("retries a failed integrity write when the same token is captured again", async () => {
      const integrity = integrityBundle({
        integrity: "retry-persistence-without-exposing-me",
      });
      const saveTwitchIntegrity = vi.fn()
        .mockRejectedValueOnce(new Error("storage unavailable"))
        .mockResolvedValueOnce(undefined);
      const env = harness(undefined, { saveTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await expect(env.controller.captureTwitchIntegrity(integrityHeaders(integrity))).resolves.toBeUndefined();

      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "Could not persist the captured Twitch integrity token",
        }),
      );

      await expect(env.controller.captureTwitchIntegrity(integrityHeaders(integrity))).resolves.toBeUndefined();
      expect(saveTwitchIntegrity).toHaveBeenCalledTimes(2);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).every(
        (event) => event.category !== "diagnostic" || !event.message.includes(integrity.integrity),
      )).toBe(true);
    });

    it("retains a captured token when alarm creation fails", async () => {
      const integrity = integrityBundle({
        integrity: "retained-after-alarm-failure",
      });
      const saveTwitchIntegrity = vi.fn(async () => undefined);
      const env = harness(undefined, {
        saveTwitchIntegrity,
        createAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) throw new Error("alarm unavailable");
        },
      });
      await env.controller.settleBackgroundWork();

      await expect(env.controller.captureTwitchIntegrity(integrityHeaders(integrity))).resolves.toBeUndefined();

      expect(saveTwitchIntegrity).toHaveBeenCalledWith(integrity);
      expect(currentValidTwitchIntegrity()).toEqual(integrity);
      expect(env.reportEvents.mock.calls.flatMap(([batch]) => batch)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: expect.stringContaining("alarm unavailable"),
        }),
      );
    });

    it("never includes integrity token material in diagnostics", async () => {
      const integrity = integrityBundle({
        integrity: "highly-sensitive-integrity-token",
      });
      const env = harness(undefined, {
        createAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) throw new Error("alarm unavailable");
        },
      });
      await env.controller.settleBackgroundWork();

      await env.controller.captureTwitchIntegrity(integrityHeaders(integrity));

      const diagnostics = env.reportEvents.mock.calls
        .flatMap(([batch]) => batch)
        .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every((event) => !event.message.includes(integrity.integrity))).toBe(true);
    });
  });

  describe("Twitch integrity readiness", () => {
    beforeEach(() => {
      setTwitchIntegrity(undefined);
    });

    afterEach(() => {
      setTwitchIntegrity(undefined);
    });

    it("keeps a user-tab capture from satisfying a managed refresh wait", async () => {
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 42 })),
        },
      } satisfies BrowserTabApi;
      const rejected = integrityBundle({ integrity: "controller-rejected-token" });
      const replacement = integrityBundle({ integrity: "controller-user-token" });
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();
      setTwitchIntegrity(rejected, { sourceTabId: 7 });

      const pending = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        50,
        undefined,
        { forceRefresh: true, rejectedToken: rejected.integrity },
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

      await env.controller.captureTwitchIntegrity(integrityHeaders(replacement), 7);

      await expect(pending).resolves.toBe(false);
    });

    it("treats negative tab ids as unattributed integrity captures", async () => {
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 42 })),
        },
      } satisfies BrowserTabApi;
      const rejected = integrityBundle({ integrity: "controller-rejected-token" });
      const replacement = integrityBundle({ integrity: "controller-unattributed-token" });
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();
      setTwitchIntegrity(rejected, { sourceTabId: 7 });

      const pending = ensureTwitchIntegrityWithBrowser(
        browser,
        "https://www.twitch.tv/drops/inventory",
        50,
        undefined,
        { forceRefresh: true, rejectedToken: rejected.integrity },
      );
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());

      await env.controller.captureTwitchIntegrity(integrityHeaders(replacement), -1);

      await expect(pending).resolves.toBe(true);
    });

    it("acquires integrity before Twitch auth and scheduler work", async () => {
      const order: string[] = [];
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => {
          order.push("integrity");
          return true;
        },
      });
      vi.mocked(env.twitch.checkAuthHealth).mockImplementation(async () => {
        order.push("auth");
        return { status: "healthy", checkedAt: "2026-07-28T12:00:00.000Z" };
      });
      vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => {
        order.push("scheduler");
        return [campaign("twitch")];
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(order).toEqual(["integrity", "auth", "scheduler"]);
    });

    it("correlates integrity readiness diagnostics with their scheduler tick", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (emit) => {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "info",
            message: "Integrity readiness probe",
          });
          return true;
        },
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          message: "Integrity readiness probe",
          globalTickId: 1,
          platformTickId: 1,
        }),
      );
    });

    it("continues the same Twitch tick after successful acquisition", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => true,
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.status).toBe("watching");
    });

    it("skips Twitch auth and scheduler work when acquisition returns false", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.deps.createAdapter).not.toHaveBeenCalled();
      expect(env.deps.createAdapters).not.toHaveBeenCalled();
    });

    it("warns that a failed acquisition waits for the next normal scheduler alarm", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: expect.stringContaining("next normal scheduler alarm"),
        }),
      );
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
    });

    it("does not treat acquisition failure as an interruption or unhealthy auth", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });
      const before = structuredClone(env.state.authHealth.twitch);

      await env.controller.tick(["twitch"], "manual_tick");

      const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "interruption",
      }));
      expect(env.state.authHealth.twitch).toEqual(before);
      expect(env.deps.saveState).not.toHaveBeenCalled();
    });

    it("continues Kick auth and scheduler work when Twitch acquisition fails", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => false,
      });

      await env.controller.tick(undefined, "manual_tick");

      expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
      expect(env.state.sessions.kick.status).toBe("watching");
    });

    it("accounts an initial readiness context without labelling it as a proactive refresh", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (_emit, request) => {
          await request?.onManagedPageContextOpen?.();
          return false;
        },
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(env.state.criticalHealth?.twitch?.records).toContainEqual(
        expect.objectContaining({
          kind: "context_open",
          code: "integrity_readiness",
        }),
      );
      expect(env.state.criticalHealth?.twitch?.records).not.toContainEqual(
        expect.objectContaining({
          kind: "context_open",
          code: "proactive_integrity_refresh",
        }),
      );
    });

    it("correlates nested Twitch integrity accounting diagnostics with their scheduler tick", async () => {
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (_emit, request) => {
          await request?.onManagedPageContextOpen?.();
          return false;
        },
      });
      const now = Date.now();
      env.state.criticalHealth = {
        twitch: {
          status: "ok",
          failingMs: 0,
          failingTicks: 0,
          managedTabOpens: Array.from(
            { length: TAB_CHURN_LIMIT - 1 },
            (_, index) => new Date(now - index * 1_000).toISOString(),
          ),
          breakerOpen: false,
          records: [],
        },
      };

      await env.controller.tick(["twitch"], "manual_tick");

      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        code: "critical_failure_detected",
        mirroredActivity: true,
        globalTickId: 1,
        platformTickId: 1,
      }));
    });

    it("correlates failed Twitch integrity accounting diagnostics with their scheduler tick", async () => {
      const env = harness(undefined, {
        saveState: vi.fn().mockRejectedValueOnce(new Error("storage unavailable")),
        ensureTwitchIntegrity: async (_emit, request) => {
          await request?.onManagedPageContextOpen?.();
          return false;
        },
      });

      await env.controller.tick(["twitch"], "manual_tick");

      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "Could not account for a managed Twitch integrity page context",
        globalTickId: 1,
        platformTickId: 1,
      }));
    });

    it("continues Kick when disabling Twitch cancels the acquisition awaited by an all-platform tick", async () => {
      const acquisition = deferred<boolean>();
      const env = harness(undefined, {
        ensureTwitchIntegrity: async () => acquisition.promise,
        cancelTwitchIntegrityAcquisition: (reason) => acquisition.reject(reason),
      });
      const ticking = env.controller.tick(undefined, "alarm");
      await vi.waitFor(() => expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce());

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });

      await expect(ticking).resolves.toEqual({});
      expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
      expect(env.state.sessions.kick.status).toBe("watching");
      await env.rawController.settleBackgroundWork();
    });

    it("exits silently when shutdown aborts integrity acquisition", async () => {
      let acquisitionSignal: AbortSignal | undefined;
      const env = harness(undefined, {
        ensureTwitchIntegrity: async (_emit, request) => new Promise<boolean>((_resolve, reject) => {
          acquisitionSignal = request?.signal;
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        }),
      });

      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());
      env.reportEvents.mockClear();

      env.controller.shutdown();

      await expect(ticking).resolves.toEqual({});
      expect(acquisitionSignal?.aborted).toBe(true);
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "interruption",
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        category: "diagnostic",
        level: "error",
      }));
    });

    it("returns from Twitch enablement before detached acquisition resolves", async () => {
      const acquisition = deferred<boolean>();
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        ensureTwitchIntegrity: async () => acquisition.promise,
      });
      let acquisitionSettled = false;
      acquisition.promise.finally(() => {
        acquisitionSettled = true;
      });

      const snapshot = asSnapshot(await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      }));

      await vi.waitFor(() => expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce());
      expect(acquisitionSettled).toBe(false);
      expect(snapshot.settings.platform.twitch.enabled).toBe(true);
      expect(snapshot.state.sessions.twitch.status).toBe("starting");

      acquisition.resolve(false);
      await env.rawController.settleBackgroundWork();
    });

    it("does not let a stale Twitch enable reopen integrity or start farming after disable supersedes it", async () => {
      const enableSave = deferred<void>();
      const disableSave = deferred<void>();
      let saveCount = 0;
      let exposeStoredIntegrity = false;
      const stored = integrityBundle({
        integrity: "stale-enable-schedule",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        saveSettings: async () => {
          saveCount += 1;
          await (saveCount === 1 ? enableSave.promise : disableSave.promise);
        },
        loadTwitchIntegrity: async () => exposeStoredIntegrity ? stored : undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();
      vi.mocked(env.twitch.refreshCampaigns).mockClear();
      env.deps.cancelTwitchIntegrityAcquisition.mockClear();
      exposeStoredIntegrity = true;

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalledOnce();

      enableSave.resolve();
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledTimes(2));
      await enabling;
      await env.rawController.settleBackgroundWork();

      disableSave.resolve();
      await disabling;
      await env.rawController.settleBackgroundWork();

      expect(env.settings.platform.twitch.enabled).toBe(false);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm.mock.calls.some(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      )).toBe(false);
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    });

    it("clears an enable alarm creation that finishes after disable supersedes it", async () => {
      const alarmCreate = deferred<void>();
      let alarmScheduled = false;
      let exposeStoredIntegrity = false;
      const stored = integrityBundle({
        integrity: "alarm-create-completion-race",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        loadTwitchIntegrity: async () => exposeStoredIntegrity ? stored : undefined,
        createAlarm: async (name) => {
          if (name !== TWITCH_INTEGRITY_ALARM_NAME) return;
          await alarmCreate.promise;
          alarmScheduled = true;
        },
        clearAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) alarmScheduled = false;
          return true;
        },
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();
      env.deps.saveSettings.mockClear();
      exposeStoredIntegrity = true;

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      ));

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.settings.platform.twitch.enabled).toBe(false));

      alarmCreate.resolve();
      await Promise.all([enabling, disabling]);
      await env.rawController.settleBackgroundWork();

      expect(alarmScheduled).toBe(false);
    });

    it("compensates a starting-state save that finishes after disable supersedes it", async () => {
      const startingSave = deferred<void>();
      const disabledSave = deferred<void>();
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        ensureTwitchIntegrity: async () => true,
      });
      let persistedState = structuredClone(env.state);
      env.deps.loadState.mockImplementation(async () => persistedState);
      env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
        if (next.sessions.twitch.status === "starting") {
          await startingSave.promise;
        } else if (next.sessions.twitch.reasonCode === "automation_disabled") {
          await disabledSave.promise;
        }
        persistedState = next;
      });

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: expect.objectContaining({
            twitch: expect.objectContaining({ status: "starting" }),
          }),
        }),
      ));

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.settings.platform.twitch.enabled).toBe(false));

      startingSave.resolve();
      await vi.waitFor(() => expect(env.deps.saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: expect.objectContaining({
            twitch: expect.objectContaining({ reasonCode: "automation_disabled" }),
          }),
        }),
      ));
      const stateBeforeDisableTickLands = structuredClone(persistedState);

      disabledSave.resolve();
      await Promise.all([enabling, disabling]);
      await env.rawController.settleBackgroundWork();

      expect(stateBeforeDisableTickLands.sessions.twitch.status).not.toBe("starting");
    });

    it.each(["reset", "shutdown"] as const)(
      "does not resume a pending Twitch enable after %s supersedes it",
      async (cleanup) => {
        const enableSave = deferred<void>();
        const env = harness(notFarming(DEFAULT_SETTINGS), {
          saveSettings: async () => enableSave.promise,
          loadTwitchIntegrity: async () => undefined,
          ensureTwitchIntegrity: async () => true,
        });
        await env.controller.settleBackgroundWork();
        env.deps.ensureTwitchIntegrity.mockClear();
        vi.mocked(env.twitch.refreshCampaigns).mockClear();
        env.deps.createAlarm.mockClear();

        const enabling = env.rawController.handleMessage({
          type: "setPlatformEnabled",
          platform: "twitch",
          enabled: true,
        });
        await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());

        let cleanupFinished: Promise<void>;
        if (cleanup === "reset") {
          cleanupFinished = env.controller.prepareForHostReset();
          await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledWith(
            TWITCH_INTEGRITY_ALARM_NAME,
          ));
        } else {
          env.controller.shutdown();
          cleanupFinished = Promise.resolve();
        }

        enableSave.resolve();
        await Promise.all([enabling, cleanupFinished]);
        await env.rawController.settleBackgroundWork();

        expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
        expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
        expect(env.state.sessions.twitch.status).not.toBe("starting");
        expect(env.deps.createAlarm.mock.calls.some(
          ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
        )).toBe(false);
      },
    );

    it("does not admit a new platform-toggle tick after shutdown", async () => {
      const env = harness(notFarming(DEFAULT_SETTINGS), {
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();
      vi.mocked(env.twitch.refreshCampaigns).mockClear();

      env.controller.shutdown();
      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await env.rawController.settleBackgroundWork();

      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.state.sessions.twitch.status).not.toBe("starting");
    });

    it("preserves a newer enable schedule when an older disable clear finishes last", async () => {
      const alarmClear = deferred<void>();
      let holdAlarmClear = false;
      let alarmScheduled = false;
      const stored = integrityBundle({
        integrity: "disable-clear-completion-race",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => stored,
        createAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) alarmScheduled = true;
        },
        clearAlarm: async (name) => {
          if (name === TWITCH_INTEGRITY_ALARM_NAME) {
            if (holdAlarmClear) await alarmClear.promise;
            alarmScheduled = false;
          }
          return true;
        },
      });
      await env.controller.settleBackgroundWork();
      expect(alarmScheduled).toBe(true);
      env.deps.saveSettings.mockClear();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();
      holdAlarmClear = true;

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
      ));

      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledTimes(2));

      alarmClear.resolve();
      await Promise.all([disabling, enabling]);
      await env.rawController.settleBackgroundWork();

      expect(env.settings.platform.twitch.enabled).toBe(true);
      expect(alarmScheduled).toBe(true);
    });

    it("reconciles lifecycle to persisted enabled state when overlapping disable and enable saves both fail", async () => {
      const disableSave = deferred<void>();
      let saveCount = 0;
      const env = harness(undefined, {
        saveSettings: async () => {
          saveCount += 1;
          if (saveCount === 1) await disableSave.promise;
          throw new Error("settings storage unavailable");
        },
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());
      const enabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });

      disableSave.resolve();
      await expect(disabling).rejects.toThrow("settings storage unavailable");
      await expect(enabling).rejects.toThrow("settings storage unavailable");
      expect(env.settings.platform.twitch.enabled).toBe(true);

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
    });

    it("restores lifecycle admission when a current disable fails on its first settings load", async () => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();
      env.deps.loadSettings.mockRejectedValueOnce(
        new Error("settings storage unavailable"),
      );

      await expect(env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      })).rejects.toThrow("settings storage unavailable");
      expect(env.settings.platform.twitch.enabled).toBe(true);

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
    });

    it("recreates the refresh schedule from a valid stored token when Twitch is re-enabled", async () => {
      const integrity = integrityBundle({
        integrity: "reschedule-after-enable",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
      });
      await env.controller.settleBackgroundWork();

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await env.rawController.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: true,
      });

      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
      await env.rawController.settleBackgroundWork();
    });
  });

  describe("Twitch integrity refresh alarm", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      setTwitchIntegrity(undefined);
    });

    afterEach(() => {
      setTwitchIntegrity(undefined);
      vi.useRealTimers();
    });

    it("reloads current settings and stored integrity on every invocation", async () => {
      const loadTwitchIntegrity = vi.fn(async () => integrityBundle());
      const env = harness(undefined, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.loadSettings.mockClear();
      loadTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();
      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.loadSettings).toHaveBeenCalledTimes(2);
      expect(loadTwitchIntegrity).toHaveBeenCalledTimes(2);
    });

    it("clears the refresh alarm without minting when Twitch is disabled", async () => {
      const loadTwitchIntegrity = vi.fn(async () => integrityBundle());
      const env = harness({
        ...farming(DEFAULT_SETTINGS),
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        },
      }, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.clearAlarm.mockClear();
      env.deps.createAlarm.mockClear();
      loadTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(loadTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("reschedules a naturally captured newer token without minting", async () => {
      const newer = integrityBundle({
        integrity: "naturally-captured-newer-token",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => newer,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm).toHaveBeenCalledOnce();
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_INTEGRITY_ALARM_NAME,
        expect.objectContaining({ when: expect.any(Number) }),
      );
    });

    it.each([
      ["missing", false],
      ["inside the refresh window", true],
    ])("forces one fresh-context acquisition when the stored token is %s", async (_label, hasNearExpiryToken) => {
      const integrity = hasNearExpiryToken
        ? integrityBundle({ expiresAt: Date.now() + 90_000 })
        : undefined;
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.clearAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          forceRefresh: true,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("relies on captured-token persistence to schedule after successful acquisition", async () => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it.each([
      ["returns false", async () => false],
      ["throws", async () => {
        throw new Error("page context failed");
      }],
    ])("does not create a retry alarm when acquisition %s", async (_label, ensureTwitchIntegrity) => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity,
      });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();

      await expect(env.controller.runTwitchIntegrityRefresh()).resolves.toBeUndefined();

      expect(env.deps.createAlarm).not.toHaveBeenCalled();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: expect.stringContaining("next normal scheduler alarm"),
        }),
      );
    });

    it("uses the real tabs single-flight while keeping proactive managed opens diagnostic-only and churn-accounted", async () => {
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 93 })),
        },
      } satisfies BrowserTabApi;
      registerManagedPageContextTabs({});
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: (emit, request) => ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          5_000,
          emit,
          request,
        ),
        cancelTwitchIntegrityAcquisition,
      });
      await env.controller.settleBackgroundWork();

      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledTimes(2));
      setTwitchIntegrity(integrityBundle({
        integrity: "real-composition-replacement",
      }), { isNew: true });
      await Promise.all([refreshing, ticking]);

      const reported = env.reportEvents.mock.calls.flatMap(([events]) => events);
      const emittedActivity = reported.some((event) =>
        event.category === "activity" && event.code === "page_context_opened");
      const proactiveDiagnostic = reported.some((event) =>
        event.category === "diagnostic"
        && event.platform === "twitch"
        && event.message.includes("proactive"));
      const managedTabOpens = env.state.criticalHealth?.twitch?.managedTabOpens.length;
      const recordedProactiveOpen = env.state.criticalHealth?.twitch?.records.some((record) =>
        record.kind === "context_open" && record.code === "proactive_integrity_refresh");
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);

      expect(browser.tabs.create).toHaveBeenCalledOnce();
      expect(emittedActivity).toBe(false);
      expect(proactiveDiagnostic).toBe(true);
      expect(reported).not.toContainEqual(expect.objectContaining({
        category: "activity",
        code: "page_context_opened",
      }));
      expect(managedTabOpens).toBeGreaterThanOrEqual(1);
      expect(recordedProactiveOpen).toBe(true);
    });

    it("revalidates the stored token when a late alarm runs", async () => {
      let stored = integrityBundle({
        integrity: "original-near-expiry-token",
        expiresAt: Date.now() + 90_000,
      });
      const loadTwitchIntegrity = vi.fn(async () => stored);
      const env = harness(undefined, { loadTwitchIntegrity });
      await env.controller.settleBackgroundWork();
      env.deps.createAlarm.mockClear();
      env.deps.ensureTwitchIntegrity.mockClear();
      stored = integrityBundle({
        integrity: "replacement-captured-while-asleep",
        expiresAt: Date.now() + 30 * 60_000,
      });

      await env.controller.runTwitchIntegrityRefresh();

      expect(loadTwitchIntegrity).toHaveBeenCalledTimes(2);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
      expect(env.deps.createAlarm).toHaveBeenCalledOnce();
    });

    it("does not let alarm preflight overwrite a fresh capture waiting for persistence", async () => {
      const oldIntegrity = integrityBundle({
        integrity: "stored-before-capture",
        expiresAt: Date.now() + 30 * 60_000,
      });
      const replacement = integrityBundle({
        integrity: "captured-before-storage-finishes",
        expiresAt: Date.now() + 40 * 60_000,
      });
      const capturedReplacement = {
        ...replacement,
        expiresAt: Date.now() + 30 * 60_000,
      };
      let stored = oldIntegrity;
      const saveGate = deferred<void>();
      const loadTwitchIntegrity = vi.fn(async () => stored);
      const env = harness(undefined, {
        loadTwitchIntegrity,
        saveTwitchIntegrity: async (value) => {
          await saveGate.promise;
          stored = value;
        },
      });
      await env.controller.settleBackgroundWork();
      loadTwitchIntegrity.mockClear();
      env.deps.createAlarm.mockClear();

      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(replacement));
      await vi.waitFor(() => expect(env.deps.saveTwitchIntegrity).toHaveBeenCalledOnce());
      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const preflightWaitedForCapture = loadTwitchIntegrity.mock.calls.length === 0;
      const memoryStayedFreshWhileSaving = currentValidTwitchIntegrity()?.integrity === replacement.integrity;

      saveGate.resolve();
      await Promise.all([capturing, refreshing]);

      expect(preflightWaitedForCapture).toBe(true);
      expect(memoryStayedFreshWhileSaving).toBe(true);
      expect(stored).toEqual(capturedReplacement);
      expect(currentValidTwitchIntegrity()).toEqual(capturedReplacement);
      const integrityAlarmCalls = env.deps.createAlarm.mock.calls.filter(
        ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
      );
      expect(integrityAlarmCalls.length).toBeGreaterThan(0);
      expect(new Set(integrityAlarmCalls.map(([, options]) => JSON.stringify(options))).size).toBe(1);
    });

    // The invariant both of these guard: installing a captured token must never
    // need a lock that a waiting mint's own caller is holding. runTick and
    // runPlatformWatchHeartbeat both hold the platform lock across work that can
    // force a refresh, so a capture that took that lock could not be installed
    // until the holder gave up — which it only did by timing out.
    it("installs a captured token while a tick holds the platform lock", async () => {
      const replacement = integrityBundle({
        integrity: "captured-during-locked-tick",
      });
      const refreshGate = deferred<void>();
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();
      setTwitchIntegrity(undefined);

      // refreshCampaigns runs during the Twitch tick, which holds the tick
      // open until it returns.
      env.twitch.refreshCampaigns = vi.fn(async () => {
        await refreshGate.promise;
        return [campaign("twitch")];
      });

      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());

      // Deliberately not awaited: persistence still queues behind the tick, and
      // the install must already have happened by the time the call returns.
      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(replacement));
      const installedWhileLocked = currentValidTwitchIntegrity()?.integrity;

      refreshGate.resolve();
      await Promise.all([capturing, ticking]);
      setTwitchIntegrity(undefined);

      expect(installedWhileLocked).toBe(replacement.integrity);
    });

    it("satisfies a rejection-recovery mint raised from inside the platform lock", async () => {
      const replacement = integrityBundle({
        integrity: "minted-during-locked-tick",
      });
      const browser = {
        tabs: {
          get: vi.fn(),
          update: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          query: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 77 })),
        },
      } satisfies BrowserTabApi;
      registerManagedPageContextTabs({});
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);
      const env = harness(undefined, { loadTwitchIntegrity: async () => undefined });
      await env.controller.settleBackgroundWork();

      let mintedInsideLock: boolean | undefined;
      // Stands in for the adapter forcing a refresh after Twitch rejects a token
      // it still considers unexpired (platforms/twitch/index.ts). This runs under
      // the platform lock, so before the fix it could only ever time out.
      env.twitch.refreshCampaigns = vi.fn(async () => {
        mintedInsideLock = await ensureTwitchIntegrityWithBrowser(
          browser,
          "https://www.twitch.tv/drops/inventory",
          1_000,
          () => undefined,
          { forceRefresh: true, reason: "rejection_recovery" },
        );
        return [campaign("twitch")];
      });

      const ticking = env.controller.tick(["twitch"], "manual_tick");
      await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
      const capturing = env.controller.captureTwitchIntegrity(integrityHeaders(replacement));

      await ticking;
      await capturing;
      resetTwitchIntegrityRefreshBounds();
      setTwitchIntegrity(undefined);

      expect(mintedInsideLock).toBe(true);
    });

    it("forces the next normal tick after a proactive refresh is deferred", async () => {
      const integrity = integrityBundle({
        integrity: "deferred-proactive-token",
        expiresAt: Date.now() + 90_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => false,
      });
      await env.controller.settleBackgroundWork();

      await env.controller.runTwitchIntegrityRefresh();
      env.deps.ensureTwitchIntegrity.mockClear();
      await env.controller.tick(["twitch"], "alarm");

      expect(env.deps.ensureTwitchIntegrity).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          forceRefresh: true,
          rejectedToken: integrity.integrity,
        }),
      );
    });

    it("reports proactive start timing before a debug-level deferral", async () => {
      const integrity = integrityBundle({
        integrity: "timed-proactive-token",
        expiresAt: Date.now() + 90_000,
      });
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => integrity,
        ensureTwitchIntegrity: async () => false,
      });
      await env.controller.settleBackgroundWork();
      env.reportEvents.mockClear();

      await env.controller.runTwitchIntegrityRefresh();

      const diagnostics = env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
      const started = diagnostics.findIndex((event) =>
        event.level === "debug"
        && event.message.includes("Starting proactive Twitch integrity refresh")
        && event.message.includes("90000ms remaining"));
      const deferred = diagnostics.findIndex((event) =>
        event.level === "debug"
        && event.message.includes("next normal scheduler alarm"));
      expect(started).toBeGreaterThanOrEqual(0);
      expect(deferred).toBeGreaterThan(started);
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("Could not refresh Twitch integrity"),
      }));
    });

    it.each(["disable", "reset", "shutdown"] as const)(
      "does not schedule from a pending startup token load after %s cleanup",
      async (cleanup) => {
        const stored = integrityBundle({
          integrity: `startup-${cleanup}-future-token`,
          expiresAt: Date.now() + 30 * 60_000,
        });
        const integrityRead = deferred<TwitchIntegrity | undefined>();
        const env = harness(undefined, {
          loadTwitchIntegrity: async () => integrityRead.promise,
          ensureTwitchIntegrity: async () => true,
        });
        await vi.waitFor(() => expect(env.deps.loadTwitchIntegrity).toHaveBeenCalledOnce());
        env.deps.createAlarm.mockClear();
        env.deps.clearAlarm.mockClear();
        env.deps.ensureTwitchIntegrity.mockClear();

        let cleanupFinished: Promise<void> | undefined;
        if (cleanup === "disable") {
          await env.rawController.handleMessage({
            type: "setPlatformEnabled",
            platform: "twitch",
            enabled: false,
          });
        } else if (cleanup === "reset") {
          cleanupFinished = env.controller.prepareForHostReset();
          await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledWith(
            TWITCH_INTEGRITY_ALARM_NAME,
          ));
        } else {
          env.controller.shutdown();
        }

        integrityRead.resolve(stored);
        await cleanupFinished;
        await env.rawController.settleBackgroundWork();

        expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
        expect(env.deps.createAlarm.mock.calls.some(
          ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
        )).toBe(false);
      },
    );

    it.each([
      ["settings", "disable", true],
      ["settings", "reset", false],
      ["settings", "shutdown", false],
      ["integrity", "disable", true],
      ["integrity", "reset", false],
      ["integrity", "shutdown", true],
    ] as const)(
      "does not restart Twitch work when %s preflight resumes after %s",
      async (pausedRead, cleanup, hasFutureToken) => {
        const stored = hasFutureToken
          ? integrityBundle({
              integrity: `${pausedRead}-${cleanup}-future-token`,
              expiresAt: Date.now() + 30 * 60_000,
            })
          : undefined;
        const env = harness(undefined, {
          loadTwitchIntegrity: async () => stored,
          ensureTwitchIntegrity: async () => true,
        });
        await env.controller.settleBackgroundWork();
        env.deps.createAlarm.mockClear();
        env.deps.ensureTwitchIntegrity.mockClear();
        env.deps.loadSettings.mockClear();
        const loadTwitchIntegrity = env.deps.loadTwitchIntegrity!;
        loadTwitchIntegrity.mockClear();
        const settingsRead = deferred<ExtensionSettings>();
        const integrityRead = deferred<TwitchIntegrity | undefined>();
        if (pausedRead === "settings") {
          env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
        } else {
          loadTwitchIntegrity.mockImplementationOnce(() => integrityRead.promise);
        }

        const refreshing = env.controller.runTwitchIntegrityRefresh();
        if (pausedRead === "settings") {
          await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
        } else {
          await vi.waitFor(() => expect(loadTwitchIntegrity).toHaveBeenCalledOnce());
        }

        let cleanupFinished: Promise<unknown> | undefined;
        if (cleanup === "disable") {
          cleanupFinished = env.rawController.handleMessage({
            type: "setPlatformEnabled",
            platform: "twitch",
            enabled: false,
          });
        } else if (cleanup === "reset") {
          cleanupFinished = env.controller.prepareForHostReset();
        } else {
          env.controller.shutdown();
        }

        if (pausedRead === "settings") {
          settingsRead.resolve(farming(DEFAULT_SETTINGS));
        } else {
          integrityRead.resolve(stored);
        }
        await Promise.all([refreshing, cleanupFinished]);
        if (cleanup === "disable") {
          await env.rawController.settleBackgroundWork();
        }

        expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
        expect(env.deps.createAlarm.mock.calls.some(
          ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
        )).toBe(false);
      },
    );

    it("cancels acquisition and clears the alarm when Twitch is disabled", async () => {
      let acquisitionSignal: AbortSignal | undefined;
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async (_emit, request) => new Promise<boolean>((_resolve, reject) => {
          acquisitionSignal = request?.signal;
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        }),
      });
      await env.controller.settleBackgroundWork();
      env.reportEvents.mockClear();
      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });

      expect(acquisitionSignal?.aborted).toBe(true);
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
      await refreshing;
      await env.rawController.settleBackgroundWork();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: expect.stringContaining("cancelled because Twitch stopped"),
        }),
      );
    });

    it("does not admit an alarm queued while the Twitch disable write is pending", async () => {
      const settingsSave = deferred<void>();
      const env = harness(undefined, {
        saveSettings: async () => settingsSave.promise,
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      const disabling = env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });
      await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalledOnce());
      const queuedAlarm = env.controller.runTwitchIntegrityRefresh();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const admittedBeforeDisablePersisted = env.deps.ensureTwitchIntegrity.mock.calls.length > 0;

      settingsSave.resolve();
      await Promise.all([disabling, queuedAlarm]);
      await env.rawController.settleBackgroundWork();
      expect(admittedBeforeDisablePersisted).toBe(false);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
    });

    it("does not admit a fresh queued alarm after reset cleanup starts", async () => {
      const alarmClear = deferred<boolean>();
      const env = harness(undefined, {
        clearAlarm: async () => alarmClear.promise,
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      const resetting = env.controller.prepareForHostReset();
      await vi.waitFor(() => expect(env.deps.clearAlarm).toHaveBeenCalledOnce());
      const queuedAlarm = env.controller.runTwitchIntegrityRefresh();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const admittedAfterResetStarted = env.deps.ensureTwitchIntegrity.mock.calls.length > 0;

      alarmClear.resolve(true);
      await Promise.all([resetting, queuedAlarm]);
      expect(admittedAfterResetStarted).toBe(false);
      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
    });

    it("does not admit a fresh queued alarm after shutdown", async () => {
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async () => true,
      });
      await env.controller.settleBackgroundWork();
      env.deps.ensureTwitchIntegrity.mockClear();

      env.controller.shutdown();
      await env.controller.runTwitchIntegrityRefresh();

      expect(env.deps.ensureTwitchIntegrity).not.toHaveBeenCalled();
    });

    it("does not abort in-flight Kick work when Twitch is disabled", async () => {
      const kickDiscovery = deferred<DropCampaign[]>();
      let kickSignal: AbortSignal | undefined;
      const env = harness(undefined);
      vi.mocked(env.kick.refreshCampaigns).mockImplementation(async (_session, { signal } = {}) => {
        kickSignal = signal;
        return kickDiscovery.promise;
      });
      const ticking = env.controller.tick(["kick"], "manual_tick");
      await vi.waitFor(() => expect(kickSignal).toBeDefined());

      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "twitch",
        enabled: false,
      });

      expect(kickSignal?.aborted).toBe(false);
      kickDiscovery.resolve([campaign("kick")]);
      await ticking;
      await env.rawController.settleBackgroundWork();
    });

    it("cancels an owned refresh during host reset", async () => {
      let acquisitionSignal: AbortSignal | undefined;
      const env = harness(undefined, {
        loadTwitchIntegrity: async () => undefined,
        ensureTwitchIntegrity: async (_emit, request) => new Promise<boolean>((_resolve, reject) => {
          acquisitionSignal = request?.signal;
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        }),
      });
      await env.controller.settleBackgroundWork();
      const refreshing = env.controller.runTwitchIntegrityRefresh();
      await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());

      await env.controller.prepareForHostReset();
      await refreshing;

      expect(acquisitionSignal?.aborted).toBe(true);
      expect(env.deps.cancelTwitchIntegrityAcquisition).toHaveBeenCalled();
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_INTEGRITY_ALARM_NAME);
    });
  });
});
