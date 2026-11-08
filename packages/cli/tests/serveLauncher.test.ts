import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
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
    const req = httpRequest(new URL("v1/health", url), { agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolveStatus(res.statusCode ?? 0));
    });
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
// node_modules (where cycletls and ws resolve), not dist/, which another test
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
    external: ["cycletls", "ws"],
    logLevel: "silent",
  });
}, 60_000);

afterAll(async () => {
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

// Both platforms off, so the child touches no network.
async function spawnServe(): Promise<{
  child: Child;
  dir: string;
  stdout: { text: () => string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
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
  const child = spawn(
    process.execPath,
    [bundle, "serve", "--config", configPath, "--port", "0", "--ready-json", "--exit-with-stdin"],
    {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SA_TWITCH_AUTH_TOKEN: undefined,
        SA_TWITCH_DEVICE_ID: undefined,
        SA_KICK_SESSION_TOKEN: undefined,
        LURKLOOT_SERVE_TOKEN: undefined,
      },
    },
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  child.stderr.resume();
  return { child, dir, stdout: collect(child.stdout), exited };
}

describe("lurkloot serve under a launcher", () => {
  it("prints the ready line, then saves state and exits 0 when stdin closes", async () => {
    const { child, dir, stdout, exited } = await spawnServe();
    try {
      await vi.waitFor(() => expect(readyUrl(stdout.text())).toBeDefined(), {
        timeout: 15_000,
      });
      const url = readyUrl(stdout.text())!;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(await getStatus(url)).toBe(200);
      await vi.waitFor(() => expect(existsSync(join(dir, "state.json"))).toBe(true), {
        timeout: 15_000,
      });
      child.stdin.end();
      expect(await exited).toEqual({ code: 0, signal: null });
      // Logs go to stderr; stdout carried the ready line alone.
      expect(stdout.text().split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // Windows has no SIGTERM (kill() force-kills there), which is why the
  // stdin option exists.
  it.skipIf(process.platform === "win32")(
    "exits 0 on SIGTERM while stdin stays open",
    async () => {
      const { child, dir, stdout, exited } = await spawnServe();
      try {
        await vi.waitFor(() => expect(readyUrl(stdout.text())).toBeDefined(), {
          timeout: 15_000,
        });
        child.kill("SIGTERM");
        expect(await exited).toEqual({ code: 0, signal: null });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
