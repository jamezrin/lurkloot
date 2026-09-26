import type { JobSchedulerPort } from "@lurkloot/core/controller";

// The subset of browser.alarms the job scheduler uses.
export interface AlarmsApi {
  create(name: string, info: { periodInMinutes?: number; when?: number }): Promise<void> | void;
  get(name: string): Promise<{ scheduledTime: number } | undefined>;
  clear(name: string): Promise<boolean>;
}

// The extension's job scheduler port (#593), backed by browser.alarms. Alarms
// already have the port's semantics: creating one replaces any alarm of the
// same name, the browser clamps short periods, a one-shot alarm is removed
// once it fires, a suspended worker gets one fire per alarm on wake, and
// alarms survive a service-worker restart. Fires reach the controller through
// browser.alarms.onAlarm and controller.runJob.
export function createAlarmJobScheduler(alarms: AlarmsApi): JobSchedulerPort {
  return {
    ensure: async (name, schedule) => {
      await alarms.create(name, schedule);
    },
    cancel: (name) => alarms.clear(name),
    get: async (name) => {
      const alarm = await alarms.get(name);
      return alarm ? { scheduledTime: alarm.scheduledTime } : undefined;
    },
  };
}
