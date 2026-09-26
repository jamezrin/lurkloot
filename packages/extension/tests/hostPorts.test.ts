import { describe, expect, it, vi } from "vitest";
import {
  assertHostCapabilities,
  BACKGROUND_JOBS,
  CLI_CAPABILITIES,
  createBackgroundController,
  EXTENSION_CAPABILITIES,
  HostCapabilityMismatchError,
  jobIsInert,
  KICK_ALARM_NAME,
  TWITCH_ALARM_NAME,
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  TWITCH_INTEGRITY_ALARM_NAME,
  WATCH_ALARM_NAME,
  type BackgroundHostPorts,
} from "@lurkloot/core/controller";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import { createAlarmJobScheduler, type AlarmsApi } from "../src/core/jobs";
import { deferred, farming, harness } from "./helpers/backgroundController";
import { hostPortsFromMocks } from "./helpers/hostPorts";

// The host contract (#593): typed ports, declared capabilities, and the job
// scheduler both hosts implement.

// A model of browser.alarms with the behavior the extension relies on:
// create replaces, a one-shot alarm is gone once it fires, and alarms outlive
// the service worker (the model is shared across "restarts").
class FakeAlarms implements AlarmsApi {
  readonly alarms = new Map<string, { scheduledTime: number; periodInMinutes?: number }>();
  create(name: string, info: { periodInMinutes?: number; when?: number }): void {
    this.alarms.set(name, {
      scheduledTime: info.when ?? Date.now() + (info.periodInMinutes ?? 0) * 60_000,
      ...(info.periodInMinutes === undefined ? {} : { periodInMinutes: info.periodInMinutes }),
    });
  }
  async get(name: string) {
    return this.alarms.get(name);
  }
  async clear(name: string) {
    return this.alarms.delete(name);
  }
  // What the browser does when an alarm is due: one-shot alarms are removed.
  fire(name: string): void {
    const alarm = this.alarms.get(name);
    if (alarm && alarm.periodInMinutes === undefined) this.alarms.delete(name);
  }
}

describe("browser.alarms job scheduler", () => {
  it("ensures a periodic job as an alarm and replaces it on the next ensure", async () => {
    const alarms = new FakeAlarms();
    const create = vi.spyOn(alarms, "create");
    const jobs = createAlarmJobScheduler(alarms);

    await jobs.ensure(TWITCH_ALARM_NAME, { periodInMinutes: 7 });
    await jobs.ensure(TWITCH_ALARM_NAME, { periodInMinutes: 3 });

    expect(create.mock.calls).toEqual([
      [TWITCH_ALARM_NAME, { periodInMinutes: 7 }],
      [TWITCH_ALARM_NAME, { periodInMinutes: 3 }],
    ]);
    expect(alarms.alarms.get(TWITCH_ALARM_NAME)?.periodInMinutes).toBe(3);
    expect(alarms.alarms.size).toBe(1);
  });

  it("reports a one-shot job until it fires", async () => {
    const alarms = new FakeAlarms();
    const jobs = createAlarmJobScheduler(alarms);
    const when = Date.now() + 90_000;

    await jobs.ensure(TWITCH_INTEGRITY_ALARM_NAME, { when });
    expect(await jobs.get(TWITCH_INTEGRITY_ALARM_NAME)).toEqual({ scheduledTime: when });
    alarms.fire(TWITCH_INTEGRITY_ALARM_NAME);
    expect(await jobs.get(TWITCH_INTEGRITY_ALARM_NAME)).toBeUndefined();
  });

  it("cancels idempotently and reports whether a job existed", async () => {
    const jobs = createAlarmJobScheduler(new FakeAlarms());
    await jobs.ensure(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    expect(await jobs.cancel(WATCH_ALARM_NAME)).toBe(true);
    expect(await jobs.cancel(WATCH_ALARM_NAME)).toBe(false);
  });

  it("keeps jobs across a service-worker restart, where get reconciles them", async () => {
    const alarms = new FakeAlarms();
    await createAlarmJobScheduler(alarms).ensure(TWITCH_INTEGRITY_ALARM_NAME, { when: Date.now() + 60_000 });
    const restarted = createAlarmJobScheduler(alarms);
    expect(await restarted.get(TWITCH_INTEGRITY_ALARM_NAME)).toBeDefined();
  });
});

describe("host capabilities", () => {
  function extensionPorts(): BackgroundHostPorts<ExtensionSettings> {
    return hostPortsFromMocks(harness(farming(DEFAULT_SETTINGS)).deps, EXTENSION_CAPABILITIES);
  }

  it("declares the hosts' static capability sets", () => {
    expect(EXTENSION_CAPABILITIES).toEqual({
      browserTabs: true,
      twitchIntegrityCapture: true,
      supplementalSources: true,
      twitchChannelPointsJob: true,
    });
    expect(CLI_CAPABILITIES).toEqual({
      browserTabs: false,
      twitchIntegrityCapture: false,
      supplementalSources: false,
      twitchChannelPointsJob: false,
    });
  });

  it("rejects a declared capability whose port is missing", () => {
    const ports = extensionPorts();
    expect(() => assertHostCapabilities({ ...ports, tabs: undefined })).toThrow(
      new HostCapabilityMismatchError("The host declares the browserTabs capability but does not pass tabs"),
    );
    expect(() => createBackgroundController({ ...ports, twitch: { ...ports.twitch, integrity: undefined } })).toThrow(
      "The host declares the twitchIntegrityCapture capability but does not pass twitch.integrity",
    );
  });

  it("rejects a port whose capability is not declared", () => {
    const ports = extensionPorts();
    expect(() => assertHostCapabilities({
      ...ports,
      capabilities: { ...EXTENSION_CAPABILITIES, supplementalSources: false },
    })).toThrow("The host passes twitch.supplementalSources but does not declare the supplementalSources capability");
  });

  it("makes each job that needs a capability inert without it", () => {
    for (const [name, job] of Object.entries(BACKGROUND_JOBS)) {
      expect(jobIsInert(name, EXTENSION_CAPABILITIES)).toBe(false);
      expect(jobIsInert(name, CLI_CAPABILITIES)).toBe(job.requires !== undefined);
    }
    expect(jobIsInert(TWITCH_ALARM_NAME, CLI_CAPABILITIES)).toBe(false);
    expect(jobIsInert(WATCH_ALARM_NAME, CLI_CAPABILITIES)).toBe(false);
    expect(jobIsInert(TWITCH_CHANNEL_POINTS_ALARM_NAME, CLI_CAPABILITIES)).toBe(true);
  });
});

describe("settings commits and the tick jobs", () => {
  it("reschedules the tick jobs at the committed poll interval once the settings lock is released", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { pollIntervalMinutes: 12 } });

    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: 12 });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: 12 });
    // The lock tracker (helpers/lockTracker.ts) fails the test if the job
    // calls ran while the settings lock was held.
  });

  it("leaves the tick jobs at the latest interval when a slow reschedule overlaps a newer commit", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const firstReschedule = deferred<void>();
    const periods: number[] = [];
    vi.mocked(env.deps.createAlarm).mockImplementation(async (name, schedule) => {
      if (name !== TWITCH_ALARM_NAME || !("periodInMinutes" in schedule)) return;
      if (schedule.periodInMinutes === 5) await firstReschedule.promise;
      periods.push(schedule.periodInMinutes);
    });

    const first = env.rawController.handleMessage({ type: "saveSettings", settingsPatch: { pollIntervalMinutes: 5 } });
    await vi.waitFor(() => expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: 5 }));
    // The newer commit saves while the first one's reschedule is still in flight.
    const second = env.rawController.handleMessage({ type: "saveSettings", settingsPatch: { pollIntervalMinutes: 9 } });
    await vi.waitFor(() => expect(env.settings.pollIntervalMinutes).toBe(9));
    firstReschedule.resolve();
    await Promise.all([first, second]);
    await env.controller.settleBackgroundWork();

    expect(periods).toEqual([5, 9]);
  });
});
