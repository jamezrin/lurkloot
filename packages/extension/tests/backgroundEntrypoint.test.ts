import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

  it("dispatches only the integrity alarm to the controller refresh", () => {
    expect(alarmListener).toContain("} else if (alarm.name === TWITCH_INTEGRITY_ALARM_NAME) {");
    expect(alarmListener).toContain("void controller.runTwitchIntegrityRefresh();");
    expect(alarmListener).not.toMatch(/else\s*\{/);
  });
});
