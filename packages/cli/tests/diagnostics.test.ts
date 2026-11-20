import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { EngineEvent } from "@lurkloot/shared/events";
import { createLogger } from "../src/logger";
import {
  createDiagnosticsHistory,
  DIAGNOSTICS_LIMIT,
  diagnosticsPath,
  exportCliDiagnostics,
  loadDiagnostics,
} from "../src/runtime/diagnostics";
import { runLoop } from "../src/runtime/run";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { idleTransport } from "./helpers/fakeFarming";

let dir: string;
let statePath: string;
const logger = createLogger("error");
const at = "2026-11-19T00:00:00.000Z";
const diagnostic = (message: string): Extract<EngineEvent, { category: "diagnostic" }> => ({
  category: "diagnostic",
  platform: "twitch",
  level: "debug",
  emittedAt: at,
  message,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-diagnostics-"));
  statePath = join(dir, "custom-state.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("CLI diagnostics", () => {
  it("exports a bounded buffer in order and keeps it beside a custom state file", async () => {
    const history = createDiagnosticsHistory(statePath, logger);
    history.append(Array.from({ length: DIAGNOSTICS_LIMIT }, (_, i) => diagnostic(`record ${i}`)));
    history.append([diagnostic("next"), diagnostic("newest")]);
    await history.flush();
    const persisted = await loadDiagnostics(statePath);
    expect(persisted).toEqual(history.recent());
    expect(persisted).toHaveLength(DIAGNOSTICS_LIMIT);
    expect(persisted[0].message).toBe("newest");
    expect(persisted.at(-1)?.message).toBe("record 2");
    if (process.platform !== "win32") {
      expect((await stat(diagnosticsPath(statePath))).mode & 0o777).toBe(0o600);
    }
  });

  it("drains pending writes and ignores a late report after closing", async () => {
    const history = createDiagnosticsHistory(statePath, logger);
    history.append([diagnostic("before shutdown")]);
    const closed = history.close();
    history.append([diagnostic("late report")]);
    await closed;
    expect((await loadDiagnostics(statePath)).map((event) => event.message)).toEqual([
      "before shutdown",
    ]);
  });

  it("exports engine diagnostics from run even at error log level", async () => {
    await runLoop({
      statePath,
      settings: DEFAULT_CLI_SETTINGS,
      transport: idleTransport(),
      logger,
      once: true,
    });
    const events = await loadDiagnostics(statePath);
    expect(events.some((event) => event.level === "debug")).toBe(true);
    expect(await readFile(statePath, "utf8")).not.toContain('"events"');
  });

  it("uses a readable report when the diagnostics file is missing or corrupt", async () => {
    expect(await loadDiagnostics(statePath)).toEqual([]);
    await writeFile(diagnosticsPath(statePath), "{broken");
    expect(await loadDiagnostics(statePath)).toEqual([]);
  });

  it("keeps accepting diagnostics after a snapshot write fails", async () => {
    const path = diagnosticsPath(statePath);
    await mkdir(path);
    const history = createDiagnosticsHistory(statePath, logger);
    history.append([diagnostic("before recovery")]);
    await history.flush();
    expect(history.recent().map((event) => event.message)).toEqual(["before recovery"]);

    await rm(path, { recursive: true });
    history.append([diagnostic("after recovery")]);
    await history.flush();
    expect((await loadDiagnostics(statePath)).map((event) => event.message)).toEqual([
      "after recovery",
      "before recovery",
    ]);
  });

  it("includes global diagnostics and filters the other platform in a serve export", async () => {
    const history = createDiagnosticsHistory(statePath, logger);
    history.append([
      { ...diagnostic("global event"), platform: undefined },
      { ...diagnostic("kick event"), platform: "kick" },
      diagnostic("twitch event"),
    ]);
    await history.flush();
    const result = exportCliDiagnostics({
      snapshot: { state: DEFAULT_STATE, settings: toEngineSettings(DEFAULT_CLI_SETTINGS) },
      events: history.recent(),
      platform: "twitch",
    });
    expect(result.events.map((event) => event.message)).toEqual(["twitch event", "global event"]);
    expect(result.report).not.toContain("kick event");
    expect(result.report.indexOf("global event")).toBeLessThan(
      result.report.indexOf("twitch event"),
    );
  });

  it("excludes credentials from events, persisted history and report context", async () => {
    const secrets = [
      "test-twitch-auth-3434",
      "test-kick-session-4545",
      "test-kasada-session-5656",
      "test-serve-access-6767",
    ];
    const [twitch, kick, kasada, serve] = secrets;
    const history = createDiagnosticsHistory(statePath, logger, () => secrets);
    history.append([
      diagnostic("Discovery completed"),
      {
        ...diagnostic(`Unexpected response: ${twitch} ${kick} ${kasada} ${serve}`),
        code: serve,
        data: { authorization: kick, authToken: twitch, "KP_UIDz-ssn": kasada, cookie: kick },
      },
      diagnostic("AUTHORIZATION: Bearer unknown-header-value"),
      diagnostic('{"Cookie":"unknown-cookie-value; other=unknown-second-cookie"}'),
      diagnostic("KP_UIDz-ssn=unknown-kasada-value"),
      diagnostic("Requested https://test.invalid/path?access_token=unknown-query-token"),
    ]);
    await history.flush();

    const state = structuredClone(DEFAULT_STATE);
    Object.assign(state, { credentials: { twitch, kick, kasada, serve } });
    Object.assign(state.authHealth.twitch, {
      status: "healthy",
      accountId: twitch,
      message: { key: "authHealthy", values: { reference: kasada } },
    });
    Object.assign(state.sessions.twitch, { status: "watching", message: kick });
    state.farmingSessions = { twitch: { id: serve, startedAt: at } };
    const settings = toEngineSettings(DEFAULT_CLI_SETTINGS);
    Object.assign(settings, { serveToken: serve, authorization: twitch });
    settings.platform.twitch.watchlistChannels = [kick];
    const events = await loadDiagnostics(statePath);
    const result = exportCliDiagnostics({
      snapshot: { state, settings },
      events,
      platform: "twitch",
    });
    const persisted = await readFile(diagnosticsPath(statePath), "utf8");
    for (const payload of [persisted, JSON.stringify(result)]) {
      for (const forbidden of [
        ...secrets,
        "unknown-",
        "authorization",
        "cookie",
        "KP_UIDz",
        "authToken",
        "serveToken",
      ]) {
        expect(payload.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
    expect(result.report).toContain("Discovery completed");
    expect(result.report).toContain("auth status: healthy");
    expect(result.report).toContain("status: watching");
    expect(result.report).toContain(`farming started at: ${at}`);
  });
});
