import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../src/logger";
import { runLoop } from "../src/runtime/run";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { idleTransport, memoryStateStore } from "./helpers/fakeFarming";

const servers = vi.hoisted(() => ({ created: 0 }));

// Counts every HTTP server created anywhere in this process.
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    servers.created += 1;
    return actual.createServer(...args);
  }) as typeof actual.createServer;
  return { ...actual, default: { ...actual, createServer }, createServer };
});

describe("lurkloot run", () => {
  it("starts no server in a single tick", async () => {
    await runLoop({
      settings: DEFAULT_CLI_SETTINGS,
      statePath: "/nonexistent-lurkloot-state.json",
      stateStore: memoryStateStore(),
      transport: idleTransport(),
      logger: createLogger("error"),
      once: true,
    });
    expect(servers.created).toBe(0);
  });

  it("starts no server in the long-running loop", async () => {
    const transport = idleTransport();
    const running = runLoop({
      settings: DEFAULT_CLI_SETTINGS,
      statePath: "/nonexistent-lurkloot-state.json",
      stateStore: memoryStateStore(),
      transport,
      logger: createLogger("error"),
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    process.emit("SIGTERM");
    await running;
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(servers.created).toBe(0);
  });

  it("does not import the control plane", () => {
    const source = readFileSync(join(__dirname, "../src/runtime/run.ts"), "utf8");
    expect(source).not.toMatch(/controlPlane|node:http|from "http"/);
  });
});
