import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { PassThrough, type Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SchedulerState } from "@lurkloot/shared/models";
import { describeCredentialHealth } from "../src/authStore";
import { createLogger } from "../src/logger";
import { readyLine, serveLoop, type ServeOptions } from "../src/runtime/serve";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { idleTransport, memoryStateStore } from "./helpers/fakeFarming";

// `serve --ready-json` and `serve --exit-with-stdin`, the options a launcher
// such as the desktop app runs `serve` with (#1023).

const quiet = { ...createLogger("error"), log: () => {}, error: () => {} };

function getStatus(url: string): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const req = httpRequest(
      new URL("v1/health", url),
      { agent: false, signal: AbortSignal.timeout(2_000) },
      (res) => {
        res.on("error", rejectStatus);
        res.on("end", () => resolveStatus(res.statusCode ?? 0));
        res.resume();
      },
    );
    req.on("error", rejectStatus);
    req.end();
  });
}

function collect(stream: Readable): { text: () => string } {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    text += chunk;
  });
  return { text: () => text };
}

function readyUrl(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed = JSON.parse(line) as { event?: string; url?: string };
    if (parsed.event === "ready") return parsed.url;
  }
  return undefined;
}

function startServe(overrides: Partial<ServeOptions>) {
  const stateStore = memoryStateStore();
  const save = vi.fn(async (state: SchedulerState) => stateStore.save(state));
  const transport = idleTransport();
  const running = serveLoop({
    binding: { host: "127.0.0.1", port: 0 },
    settings: DEFAULT_CLI_SETTINGS,
    statePath: "/nonexistent-lurkloot-state.json",
    stateStore: { load: stateStore.load, save },
    transport,
    logger: quiet,
    checkCredentialAvailability: async () => ({ status: "available" }),
    describeCredentials: () => describeCredentialHealth("/nonexistent-lurkloot-auth", {}),
    appRoot: null,
    ...overrides,
  });
  return { running, save, transport };
}

describe("serve launcher options", () => {
  it("formats the ready line as one JSON line", () => {
    const line = readyLine("http://127.0.0.1:4321/");
    expect(line).toBe('{"event":"ready","url":"http://127.0.0.1:4321/"}\n');
    expect(line.indexOf("\n")).toBe(line.length - 1);
  });

  it("prints one ready line once it listens, and stops cleanly when the input ends", async () => {
    const output = new PassThrough();
    const written = collect(output);
    const input = new PassThrough();
    // Others (esbuild's build service) may listen too; serve must add none for good.
    const sigterm = process.listenerCount("SIGTERM");
    const sigint = process.listenerCount("SIGINT");
    const { running, save, transport } = startServe({
      readyOutput: output,
      exitWithInput: input,
    });
    await vi.waitFor(() => expect(readyUrl(written.text())).toBeDefined());
    const lines = written.text().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const url = readyUrl(written.text())!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(url).not.toBe("http://127.0.0.1:0/");
    expect(await getStatus(url)).toBe(200);
    // What the input carries is ignored.
    input.write("anything\n");
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    input.end();
    await running;
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    await expect(getStatus(url)).rejects.toThrow();
    expect(written.text().split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("still stops on SIGTERM with the input open, and lets go of the input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = collect(output);
    const { running, transport } = startServe({ readyOutput: output, exitWithInput: input });
    await vi.waitFor(() => expect(readyUrl(written.text())).toBeDefined());
    process.emit("SIGTERM");
    await running;
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.isPaused()).toBe(true);
  });

  it("prints no ready line and leaves no server when the input ends during startup", async () => {
    const output = new PassThrough();
    const written = collect(output);
    const input = new PassThrough();
    let port = 0;
    const { running, transport } = startServe({
      readyOutput: output,
      exitWithInput: input,
      onListening: (address) => {
        port = address.port;
        input.end();
      },
    });
    await running;
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(written.text()).toBe("");
    // Input ends as the server binds, before the ready hook. Shutdown closes
    // the server before the loop ends.
    expect(port).not.toBe(0);
    await expect(getStatus(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("keeps farming when the ready line cannot be written", async () => {
    const output = new Writable({
      write: (_chunk, _encoding, callback) => callback(new Error("EPIPE")),
    });
    const warn = vi.fn();
    let port = 0;
    const { running, transport } = startServe({
      readyOutput: output,
      logger: { ...quiet, warn },
      onListening: (address) => {
        port = address.port;
      },
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("EPIPE"), "serve"),
    );
    expect(await getStatus(`http://127.0.0.1:${port}/`)).toBe(200);
    process.emit("SIGTERM");
    await running;
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it("stops when the input fails", async () => {
    const input = new PassThrough();
    let port = 0;
    const { running, transport } = startServe({
      exitWithInput: input,
      onListening: (address) => {
        port = address.port;
      },
    });
    await vi.waitFor(() => expect(port).not.toBe(0));
    input.destroy(new Error("EPIPE"));
    await running;
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  // An input that ended before serve watched it sends no more events.
  it.each([
    [
      "ended",
      async () => {
        const input = new PassThrough();
        input.resume();
        input.end();
        await once(input, "end");
        return input;
      },
    ],
    [
      "destroyed",
      async () => {
        const input = new PassThrough();
        input.destroy();
        await once(input, "close");
        return input;
      },
    ],
  ])("stops at once, printing no ready line, when the input is already %s", async (_, made) => {
    const input = await made();
    const output = new PassThrough();
    const written = collect(output);
    let port = 0;
    const { running, transport } = startServe({
      readyOutput: output,
      exitWithInput: input,
      onListening: (address) => {
        port = address.port;
      },
    });
    await running;
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(written.text()).toBe("");
    expect(port).toBe(0);
  });

  it("waits for a state save in flight when the input ends", async () => {
    const input = new PassThrough();
    const order: string[] = [];
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    let entered = false;
    const stateStore = memoryStateStore();
    const { running, transport } = startServe({
      exitWithInput: input,
      stateStore: {
        load: stateStore.load,
        save: async (state) => {
          if (!entered) {
            entered = true;
            order.push("save started");
            await barrier;
            order.push("save finished");
          }
          await stateStore.save(state);
        },
      },
    });
    vi.mocked(transport.dispose).mockImplementation(async () => {
      order.push("dispose");
    });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    input.end();
    // The input's end and the shutdown it starts run, then stop at the save.
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
    }
    expect(order).toEqual(["save started"]);
    expect(settled).toBe(false);
    release();
    await running;
    expect(order).toEqual(["save started", "save finished", "dispose"]);
  });

  it("waits for startup reconciliation to save a stale session when input ends during its read", async () => {
    const input = new PassThrough();
    const stateStore = memoryStateStore();
    const state = await stateStore.load();
    state.sessions.twitch.status = "watching";
    let releaseRead: () => void = () => {};
    const reading = new Promise<void>((resolveRead) => {
      releaseRead = resolveRead;
    });
    const load = vi.fn(async () => {
      await reading;
      return stateStore.load();
    });
    const order: string[] = [];
    const { running, transport } = startServe({
      exitWithInput: input,
      stateStore: {
        load,
        save: async (next) => {
          await stateStore.save(next);
          order.push("save");
        },
      },
    });
    vi.mocked(transport.dispose).mockImplementation(async () => {
      order.push("dispose");
    });

    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalled());
      const ended = once(input, "end");
      input.end();
      await ended;
      // Let shutdown proceed while the first reconciliation read is still held.
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
    } finally {
      input.end();
      releaseRead();
      await running;
      order.push("resolved");
    }
    expect(order[0]).toBe("save");
    expect(order.slice(-2)).toEqual(["dispose", "resolved"]);
    expect((await stateStore.load()).sessions.twitch.status).toBe("paused");
  });

  it("writes nothing to stdout and leaves stdin alone with the options off", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write");
    const stdinListeners = ["data", "end", "close", "error"].map((event) =>
      process.stdin.listenerCount(event),
    );
    try {
      let port = 0;
      const { running } = startServe({
        onListening: (address) => {
          port = address.port;
        },
      });
      await vi.waitFor(() => expect(port).not.toBe(0));
      expect(
        ["data", "end", "close", "error"].map((event) => process.stdin.listenerCount(event)),
      ).toEqual(stdinListeners);
      process.emit("SIGTERM");
      await running;
      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }
  });
});

// The built CLI as a launcher runs it. Bundled into its own directory under
// node_modules (where impit and ws resolve), not dist/, which another test
// file builds at the same time.
const CLI_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
let bundleDir = "";
let bundle = "";

beforeAll(async () => {
  const cacheDir = join(CLI_PACKAGE_DIR, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  bundleDir = await mkdtemp(join(cacheDir, "serve-launcher-"));
  bundle = join(bundleDir, "index.mjs");
  await build({
    entryPoints: [join(CLI_PACKAGE_DIR, "src/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    mainFields: ["module", "main"],
    outfile: bundle,
    external: ["impit", "ws"],
    logLevel: "silent",
  });
}, 60_000);

afterAll(async () => {
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

type Child = ChildProcessByStdio<Writable | null, Readable, Readable>;
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

// Rejects once `ms` pass, so a hung child fails the test inside its own
// timeout and its `finally` still kills it and removes the directory.
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(`${what} took over ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Both platforms off, so the child touches no network.
async function spawnServe(stdin: "pipe" | "ignore" = "pipe"): Promise<{
  child: Child;
  dir: string;
  stderr: { text: () => string };
  stdout: { text: () => string };
  exited: Promise<Exit>;
  stop: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "serve-launcher-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      transport: "http",
      authDir: "./credentials",
      settings: { platform: { twitch: { enabled: false }, kick: { enabled: false } } },
    }),
    "utf8",
  );
  const args = [
    bundle,
    "serve",
    "--config",
    configPath,
    "--port",
    "0",
    "--ready-json",
    "--exit-with-stdin",
  ];
  const options = {
    cwd: dir,
    env: {
      ...process.env,
      SA_TWITCH_AUTH_TOKEN: undefined,
      SA_TWITCH_DEVICE_ID: undefined,
      SA_KICK_SESSION_TOKEN: undefined,
      LURKLOOT_SERVE_TOKEN: undefined,
    },
  };
  const child =
    stdin === "pipe"
      ? spawn(process.execPath, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  // A spawn failure, or a write to a pipe the child already closed, must fail
  // the test, not crash the runner.
  const exited = new Promise<Exit>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
    child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
  });
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.on("error", () => {});
  // The `finally` of every test: the child goes, then its directory.
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await within(exited, 5_000, "the killed child's exit").catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  };
  return { child, dir, stdout: collect(child.stdout), stderr: collect(child.stderr), exited, stop };
}

// The state file is whole: it parses, and no temporary write is left behind.
function expectStateSaved(dir: string): void {
  expect(() => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))).not.toThrow();
  expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe("lurkloot serve under a launcher", () => {
  it("prints the ready line, then saves state and exits 0 when stdin closes", async () => {
    const { child, dir, stdout, exited, stop } = await spawnServe();
    try {
      await vi.waitFor(() => expect(readyUrl(stdout.text())).toBeDefined(), {
        timeout: 10_000,
      });
      const url = readyUrl(stdout.text())!;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(await getStatus(url)).toBe(200);
      await vi.waitFor(() => expect(existsSync(join(dir, "state.json"))).toBe(true), {
        timeout: 5_000,
      });
      child.stdin!.end();
      expect(await within(exited, 10_000, "exit")).toEqual({ code: 0, signal: null });
      expectStateSaved(dir);
      // Lurkloot logs to stderr, so here the ready line is all of stdout. A
      // transport helper (cycletls) may add lines of its own, which is why a
      // launcher scans for the ready line.
      expect(stdout.text().split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      await stop();
    }
  }, 40_000);

  // A launcher that stops reading its child's output before closing stdin must
  // not turn the shutdown log line into a crash (EPIPE).
  it("exits 0 when the launcher closes stdout and stderr before stdin", async () => {
    const { child, dir, stdout, exited, stop } = await spawnServe();
    try {
      await vi.waitFor(() => expect(readyUrl(stdout.text())).toBeDefined(), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(existsSync(join(dir, "state.json"))).toBe(true), {
        timeout: 5_000,
      });
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin!.end();
      expect(await within(exited, 10_000, "exit")).toEqual({ code: 0, signal: null });
      expectStateSaved(dir);
    } finally {
      await stop();
    }
  }, 40_000);

  // Stdin already at end of file when serve looks at it: the launcher has
  // gone, so serve stops without announcing a server nobody will use.
  it("prints no ready line and exits 0 when stdin is closed from the start", async () => {
    const { child, stdout, exited, stop } = await spawnServe();
    try {
      child.stdin!.end();
      expect(await within(exited, 15_000, "exit")).toEqual({ code: 0, signal: null });
      expect(readyUrl(stdout.text())).toBeUndefined();
    } finally {
      await stop();
    }
  }, 40_000);

  it("exits 0 before binding or printing ready when stdin is the null device", async () => {
    const { stdout, stderr, exited, stop } = await spawnServe("ignore");
    try {
      expect(await within(exited, 15_000, "exit")).toEqual({ code: 0, signal: null });
      expect(readyUrl(stdout.text())).toBeUndefined();
      expect(stderr.text()).toContain("Input closed (--exit-with-stdin)");
      expect(stderr.text()).not.toContain("Control plane listening");
    } finally {
      await stop();
    }
  }, 40_000);

  // Windows has no SIGTERM (kill() force-kills there), which is why the
  // stdin option exists.
  it.skipIf(process.platform === "win32")(
    "exits 0 on SIGTERM while stdin stays open",
    async () => {
      const { child, stdout, exited, stop } = await spawnServe();
      try {
        await vi.waitFor(() => expect(readyUrl(stdout.text())).toBeDefined(), {
          timeout: 10_000,
        });
        child.kill("SIGTERM");
        expect(await within(exited, 10_000, "exit")).toEqual({ code: 0, signal: null });
      } finally {
        await stop();
      }
    },
    40_000,
  );
});
