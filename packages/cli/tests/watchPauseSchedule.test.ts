import { describe, expect, it } from "vitest";
import { defaultConfigJsonc, parseConfig, parseConfigJsonc } from "../src/config";
import { DEFAULT_CLI_SETTINGS, parseCliSettings, toEngineSettings } from "../src/settings";

// The daily watch pause window (#1162) in the CLI config: strict, so a typo
// fails loudly instead of farming through the hours meant to pause.
describe("CLI watchPauseSchedule", () => {
  it("is off by default and reaches the engine as written", () => {
    expect(DEFAULT_CLI_SETTINGS.watchPauseSchedule.enabled).toBe(false);
    const settings = parseCliSettings({
      watchPauseSchedule: {
        enabled: true,
        start: "23:30",
        end: "06:00",
        timeZone: "Europe/Madrid",
      },
    });
    expect(toEngineSettings(settings).watchPauseSchedule).toEqual({
      enabled: true,
      start: "23:30",
      end: "06:00",
      timeZone: "Europe/Madrid",
    });
  });

  it("fills fields left out with the defaults", () => {
    expect(parseCliSettings({ watchPauseSchedule: { enabled: true } }).watchPauseSchedule).toEqual({
      ...DEFAULT_CLI_SETTINGS.watchPauseSchedule,
      enabled: true,
    });
  });

  it.each([
    [{ start: "25:00" }, /"watchPauseSchedule.start" must be a 24-hour time/],
    [{ end: "6am" }, /"watchPauseSchedule.end" must be a 24-hour time/],
    [
      { start: "05:00", end: "05:00" },
      /"watchPauseSchedule.start" and "watchPauseSchedule.end" must differ/,
    ],
    [{ timeZone: "Mars/Olympus" }, /"watchPauseSchedule.timeZone" must be an IANA time zone/],
    [{ enabled: "yes" }, /"watchPauseSchedule.enabled" must be a boolean/],
    [{ days: [1] }, /unknown setting "watchPauseSchedule.days"/],
  ])("rejects %j", (block, message) => {
    expect(() => parseCliSettings({ watchPauseSchedule: { enabled: true, ...block } })).toThrow(
      message,
    );
  });

  it("rejects a block that is not an object", () => {
    expect(() => parseCliSettings({ watchPauseSchedule: "22:00-06:00" })).toThrow(
      /"watchPauseSchedule" must be a JSON object/,
    );
  });

  it("documents the block in the generated config", () => {
    const text = defaultConfigJsonc();
    expect(text).toContain('"watchPauseSchedule"');
    const config = parseConfig(parseConfigJsonc(text, "/tmp/config.json"), "/tmp/config.json");
    expect(config.settings.watchPauseSchedule).toEqual(DEFAULT_CLI_SETTINGS.watchPauseSchedule);
  });
});
