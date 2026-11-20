import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import { describeCredentialHealth } from "../src/authStore";
import { createLogger } from "../src/logger";
import {
  createDiagnosticsHistory,
  DIAGNOSTICS_LIMIT,
  DIAGNOSTICS_WRITE_INTERVAL_MS,
  diagnosticCredentialValues,
  diagnosticsPath,
  exportCliDiagnostics,
  loadDiagnostics,
} from "../src/runtime/diagnostics";
import { runLoop } from "../src/runtime/run";
import { serveLoop } from "../src/runtime/serve";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { idleTransport, memoryStateStore } from "./helpers/fakeFarming";

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
  it("includes both the stored and wire forms of an encoded Kick credential", () => {
    const token = "12345%7Ctest-kick-session";
    expect(diagnosticCredentialValues({ kick: { sessionToken: token } })).toEqual(
      expect.arrayContaining([token, "12345|test-kick-session"]),
    );
    expect(diagnosticCredentialValues({ kick: { sessionToken: "%broken" } })).toContain("%broken");
  });

  it("exports a bounded buffer in order and keeps it beside a custom state file", async () => {
    const history = await createDiagnosticsHistory(statePath, logger);
    history.append(Array.from({ length: DIAGNOSTICS_LIMIT }, (_, i) => diagnostic(`record ${i}`)));
    history.append([diagnostic("next"), diagnostic("newest")]);
    await history.close();
    const { events: persisted } = await loadDiagnostics(statePath);
    expect(persisted).toEqual(history.recent());
    expect(persisted).toHaveLength(DIAGNOSTICS_LIMIT);
    expect(persisted[0].message).toBe("newest");
    expect(persisted.at(-1)?.message).toBe("record 2");
    if (process.platform !== "win32") {
      expect((await stat(diagnosticsPath(statePath))).mode & 0o777).toBe(0o600);
    }
  });

  it("drains pending writes and ignores a late report after closing", async () => {
    const history = await createDiagnosticsHistory(statePath, logger);
    history.append([diagnostic("before shutdown")]);
    const closed = history.close();
    history.append([diagnostic("late report")]);
    await closed;
    expect((await loadDiagnostics(statePath)).events.map((event) => event.message)).toEqual([
      "before shutdown",
    ]);
  });

  it("coalesces updates within the write interval and flushes pending rows on close", async () => {
    vi.useFakeTimers();
    try {
      const history = await createDiagnosticsHistory(statePath, logger);
      const messagesOnDisk = async () =>
        (await loadDiagnostics(statePath)).events.map((event) => event.message);
      history.append([diagnostic("first")]);
      await vi.waitFor(async () => expect(await messagesOnDisk()).toEqual(["first"]));
      history.append([diagnostic("second")]);
      history.append([diagnostic("third")]);
      expect(history.recent().map((event) => event.message)).toEqual(["third", "second", "first"]);
      expect(await messagesOnDisk()).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WRITE_INTERVAL_MS);
      await vi.waitFor(async () =>
        expect(await messagesOnDisk()).toEqual(["third", "second", "first"]),
      );
      expect((await readFile(diagnosticsPath(statePath), "utf8")).trimEnd()).not.toContain("\n");
      history.append([diagnostic("last")]);
      expect(await messagesOnDisk()).not.toContain("last");
      await history.close();
      expect(await messagesOnDisk()).toEqual(["last", "third", "second", "first"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports engine diagnostics from run even at error log level", async () => {
    await runLoop({
      statePath,
      settings: DEFAULT_CLI_SETTINGS,
      transport: idleTransport(),
      logger,
      once: true,
    });
    const { events } = await loadDiagnostics(statePath);
    expect(events.some((event) => event.level === "debug")).toBe(true);
    expect(await readFile(statePath, "utf8")).not.toContain('"events"');
  });

  it.each(["SIGTERM", "stdin EOF"])("persists the last teardown diagnostic on %s", async (stop) => {
    const input = new PassThrough();
    const transport = idleTransport();
    const createAdapter = transport.createAdapter;
    let emitKickDiagnostic: EventEmitter | undefined;
    transport.createAdapter = (platform, emit, settings) => {
      if (platform === "kick") emitKickDiagnostic = emit;
      return createAdapter(platform, emit, settings);
    };
    vi.mocked(transport.dispose).mockImplementation(async () => {
      emitKickDiagnostic?.({
        ...diagnostic("Final teardown report"),
        platform: "kick",
        code: "kick_fetch_summary",
      });
    });
    const running = serveLoop({
      binding: { host: "127.0.0.1", port: 0 },
      describeCredentials: () => describeCredentialHealth(dir, {}),
      appRoot: null,
      exitWithInput: input,
      settings: DEFAULT_CLI_SETTINGS,
      statePath,
      stateStore: memoryStateStore(),
      checkCredentialAvailability: async () => ({ status: "available" }),
      transport,
      logger,
    });
    try {
      await vi.waitFor(() => expect(emitKickDiagnostic).toBeDefined());
    } finally {
      if (stop === "SIGTERM") process.emit("SIGTERM");
      else input.end();
      await running;
      input.destroy();
    }
    const { events } = await loadDiagnostics(statePath);
    expect(events[0]?.message).toBe("Final teardown report");
  });

  it("uses a readable report when the diagnostics file is missing or corrupt", async () => {
    expect(await loadDiagnostics(statePath)).toEqual({ events: [] });
    await writeFile(diagnosticsPath(statePath), "{broken");
    expect(await loadDiagnostics(statePath)).toEqual({ events: [] });
  });

  it("retries a failed snapshot on close without another append", async () => {
    const path = diagnosticsPath(statePath);
    await mkdir(path);
    const onWarn = vi.fn();
    const history = await createDiagnosticsHistory(statePath, { ...logger, warn: onWarn });
    history.append([diagnostic("before recovery")]);
    await vi.waitFor(() => expect(onWarn).toHaveBeenCalledOnce());
    expect(history.recent().map((event) => event.message)).toEqual(["before recovery"]);

    await rm(path, { recursive: true });
    await history.close();
    expect((await loadDiagnostics(statePath)).events.map((event) => event.message)).toEqual([
      "before recovery",
    ]);
  });

  it("includes global diagnostics and filters the other platform in a serve export", async () => {
    const history = await createDiagnosticsHistory(statePath, logger);
    history.append([
      { ...diagnostic("global event"), platform: undefined },
      { ...diagnostic("kick event"), platform: "kick" },
      diagnostic("twitch event"),
    ]);
    await history.close();
    const result = exportCliDiagnostics({
      snapshot: { state: DEFAULT_STATE, settings: toEngineSettings(DEFAULT_CLI_SETTINGS) },
      events: history.recent(),
      platform: "twitch",
      history: { source: "live buffer" },
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
    const history = await createDiagnosticsHistory(statePath, logger, () => secrets);
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
      diagnostic("Sent PASS oauth:unknown-irc-value"),
      diagnostic("Unexpected integrity v4.local.unknown-integrity-value"),
      diagnostic("Received auth-token unknown-twitch-value"),
    ]);
    await history.close();

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
    const { events } = await loadDiagnostics(statePath);
    const result = exportCliDiagnostics({
      snapshot: { state, settings },
      events,
      platform: "twitch",
      history: { source: "live buffer" },
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
