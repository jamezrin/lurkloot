import { readFileSync } from "node:fs";
import * as controllerModule from "@lurkloot/core/controller";
import { describe, expect, it, vi } from "vitest";

describe("background integrity alarm wiring", () => {
  const source = readFileSync(
    new URL("../entrypoints/background.ts", import.meta.url),
    "utf8",
  );
  const alarmListener = source.slice(
    source.indexOf("browser.alarms.onAlarm.addListener"),
    source.indexOf("browser.tabs.onRemoved.addListener"),
  );

  it("injects the one-shot alarm and integrity lifecycle dependencies", () => {
    expect(source).toContain("createAlarm: (name, options) => browser.alarms.create(name, options),");
    expect(source).toContain("clearAlarm: (name) => browser.alarms.clear(name),");
    expect(source).toContain("ensureTwitchIntegrity: (emit, request) => ensureTwitchIntegrity(emit, request),");
    expect(source).toContain("cancelTwitchIntegrityAcquisition,");
  });

  it("registers the behavioral named-alarm dispatcher", () => {
    expect(alarmListener).toContain(
      "browser.alarms.onAlarm.addListener(createBackgroundAlarmListener(controller));",
    );
  });

  it("behaviorally dispatches named alarms and ignores unrelated alarms", () => {
    const createBackgroundAlarmListener = (
      controllerModule as typeof controllerModule & {
        createBackgroundAlarmListener?: (controller: {
          tickAndHandOff(): Promise<void>;
          runWatchHeartbeat(): Promise<void>;
          runTwitchIntegrityRefresh(): Promise<void>;
        }) => (alarm: { name: string }) => void;
      }
    ).createBackgroundAlarmListener;
    expect(createBackgroundAlarmListener).toBeTypeOf("function");
    if (!createBackgroundAlarmListener) return;
    const controller = {
      tickAndHandOff: vi.fn(async () => undefined),
      runWatchHeartbeat: vi.fn(async () => undefined),
      runTwitchIntegrityRefresh: vi.fn(async () => undefined),
    };
    const listener = createBackgroundAlarmListener(controller);

    listener({ name: "lurkloot.tick.twitch" });
    listener({ name: "lurkloot.tick.kick" });
    listener({ name: "lurkloot.tick" });
    listener({ name: "lurkloot.twitch-integrity" });
    listener({ name: "unrelated.alarm" });

    expect(controller.runTwitchIntegrityRefresh).toHaveBeenCalledOnce();
    expect(controller.tickAndHandOff).toHaveBeenNthCalledWith(1, ["twitch"], "alarm");
    expect(controller.tickAndHandOff).toHaveBeenNthCalledWith(2, ["kick"], "alarm");
    expect(controller.tickAndHandOff).toHaveBeenCalledTimes(2);
    expect(controller.runWatchHeartbeat).not.toHaveBeenCalled();
  });
});
