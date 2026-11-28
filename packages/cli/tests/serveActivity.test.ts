import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { ActivityHistoryRecord, EventEmitter } from "@lurkloot/shared/events";
import type { ActivityPage, ActivitySessionsPage } from "@lurkloot/shared/messages";
import type { DropCampaign } from "@lurkloot/shared/models";
import { createFileActivityHistory } from "../src/activityStore";
import { describeCredentialHealth } from "../src/authStore";
import { createLogger } from "../src/logger";
import { runLoop } from "../src/runtime/run";
import { serveLoop } from "../src/runtime/serve";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { loadState, saveState, stateSidecarPath } from "../src/storage";
import type { TransportHandle } from "../src/transport";
import { deferred } from "./helpers/deferred";
import { idleAdapter, idleTransport, memoryStateStore } from "./helpers/fakeFarming";

// `serve` keeps the activity the farming loop reports (#1088): a claim made
// by the loop is answered over the control plane, survives a restart, and
// clearActivity empties it.

// Keeps every line reported through the CLI's event logging, silently.
const logged: string[] = [];
const quiet = {
  ...createLogger("error"),
  log: (_level: string, message: string) => {
    logged.push(message);
  },
  error: () => {},
};
const PLANTED_SECRET = "diagnostic-secret-sentinel-4242";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function claimableCampaign(): DropCampaign {
  return {
    id: "campaign-1",
    platform: "twitch",
    name: "Launch Week",
    gameName: "Some Game",
    status: "active",
    rewards: [
      {
        id: "reward-1",
        name: "Golden Hat",
        requiredMinutes: 60,
        watchedMinutes: 60,
        status: "claimable",
        claimId: "claim-1",
      },
    ],
  };
}

// Twitch has one claimable reward and claims it; Kick idles. Every refresh
// also reports a diagnostic that must stay out of the activity file.
function claimingTransport(beforeClaim?: (signal?: AbortSignal) => Promise<void>): TransportHandle {
  const base = idleTransport();
  let claimed = false;
  let emit: EventEmitter | undefined;
  const twitch: PlatformAdapter = {
    ...idleAdapter("twitch"),
    refreshCampaigns: async () => {
      emit?.({ category: "diagnostic", level: "info", message: PLANTED_SECRET });
      const campaign = claimableCampaign();
      if (claimed) campaign.rewards[0]!.status = "claimed";
      return [campaign];
    },
    claimReward: async (_campaign, _reward, options) => {
      if (beforeClaim) await beforeClaim(options?.signal);
      claimed = true;
      return true;
    },
  };
  const adapters = { ...base.adapters, twitch };
  return {
    ...base,
    adapters,
    createAdapter: (platform, adapterEmit, settings) => {
      if (platform === "twitch") emit = adapterEmit;
      return {
        ...base.createAdapter(platform, adapterEmit, settings),
        adapter: adapters[platform],
      };
    },
    createAdapters: (adapterEmit, settings) => {
      emit = adapterEmit;
      return { ...base.createAdapters(adapterEmit, settings), adapters };
    },
  };
}

async function message<T>(port: number, body: unknown): Promise<{ status: number; result: T }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/session/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { result: T };
  return { status: response.status, result: json.result };
}

async function serve(statePath: string, transport: TransportHandle) {
  let port = 0;
  const running = serveLoop({
    binding: { host: "127.0.0.1", port: 0 },
    settings: DEFAULT_CLI_SETTINGS,
    statePath,
    stateStore: memoryStateStore(),
    transport,
    logger: quiet,
    appRoot: null,
    checkCredentialAvailability: async () => ({ status: "available" }),
    describeCredentials: () => describeCredentialHealth("/nonexistent-lurkloot-auth", {}),
    onListening: (address) => {
      port = address.port;
    },
  });
  await vi.waitFor(() => expect(port).not.toBe(0));
  return {
    port,
    stop: async () => {
      process.emit("SIGTERM");
      await running;
    },
  };
}

async function activity(port: number): Promise<ActivityHistoryRecord[]> {
  const page = await message<ActivityPage>(port, {
    type: "getActivity",
    category: "activity",
    platform: "twitch",
  });
  expect(page.status).toBe(200);
  return page.result.events;
}

describe("serve activity history", () => {
  it("answers a claim over the control plane, keeps it across a restart, and clears it", async () => {
    dir = await mkdtemp(join(tmpdir(), "serve-activity-"));
    const statePath = join(dir, "state.json");

    const first = await serve(statePath, claimingTransport());
    try {
      await vi.waitFor(
        async () =>
          expect((await activity(first.port)).map((event) => event.code)).toContain(
            "reward_claimed",
          ),
        { timeout: 5_000 },
      );
      const sessions = await message<ActivitySessionsPage>(first.port, {
        type: "getActivitySessions",
        platform: "twitch",
      });
      expect(sessions.result.sessions).toEqual([
        expect.objectContaining({ platform: "twitch", rewardCounts: { drop: 1 } }),
      ]);
      // The CLI snapshot carries no diagnostic logging setting, so the
      // Activity view never offers a diagnostics stream it does not keep.
      const snapshot = await message<{ settings: Record<string, unknown> }>(first.port, {
        type: "getSnapshot",
      });
      expect(snapshot.result.settings).not.toHaveProperty("diagnosticLogging");
    } finally {
      await first.stop();
    }

    // The diagnostic was logged and stays out of activity history.
    expect(logged).toContain(PLANTED_SECRET);
    const onDisk = await readFile(join(dir, "state.json.activity.json"), "utf8");
    expect(onDisk).toContain("reward_claimed");
    expect(onDisk).not.toContain('"diagnostic"');
    expect(onDisk).not.toContain(PLANTED_SECRET);

    const second = await serve(statePath, idleTransport());
    try {
      const claim = (await activity(second.port)).find((event) => event.code === "reward_claimed");
      expect(claim?.data).toEqual(
        expect.objectContaining({ rewardName: "Golden Hat", campaignName: "Launch Week" }),
      );

      const cleared = await message<null>(second.port, { type: "clearActivity" });
      expect(cleared).toEqual({ status: 200, result: null });
      expect(await activity(second.port)).toEqual([]);
      const sessions = await message<ActivitySessionsPage>(second.port, {
        type: "getActivitySessions",
        platform: "twitch",
      });
      expect(sessions.result.sessions).toEqual([]);
    } finally {
      await second.stop();
    }
    expect(JSON.parse(await readFile(join(dir, "state.json.activity.json"), "utf8"))).toEqual(
      expect.objectContaining({ events: [], sessions: [] }),
    );
  });

  it("keeps what `run` reports beside its state file", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-activity-"));
    await runLoop({
      settings: DEFAULT_CLI_SETTINGS,
      statePath: join(dir, "state.json"),
      stateStore: memoryStateStore(),
      transport: claimingTransport(),
      logger: quiet,
      once: true,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    const onDisk = JSON.parse(await readFile(join(dir, "state.json.activity.json"), "utf8")) as {
      events: ActivityHistoryRecord[];
    };
    expect(onDisk.events.map((event) => event.code)).toContain("reward_claimed");
    expect(onDisk.events.every((event) => event.category === "activity")).toBe(true);
  });

  it("persists a claim that resolves after SIGTERM", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-activity-signal-"));
    const statePath = join(dir, "state.json");
    const { promise: committing, resolve: commitStarted } = deferred<void>();
    const { promise: pendingCommit, resolve: finishCommit } = deferred<void>();
    const { promise: aborted, resolve: claimAborted } = deferred<unknown>();
    const transport = claimingTransport(async (signal) => {
      if (!signal) throw new Error("Expected an abortable farming claim");
      signal.addEventListener("abort", () => claimAborted(signal.reason), { once: true });
    });
    const dispose = vi.fn(transport.dispose);
    const { promise: reporting, resolve: reportStarted } = deferred<void>();
    const { promise: pendingReport, resolve: finishReport } = deferred<void>();
    const path = stateSidecarPath(statePath, "activity");
    const history = createFileActivityHistory(path);
    const running = runLoop({
      settings: DEFAULT_CLI_SETTINGS,
      statePath,
      stateStore: {
        load: () => loadState(statePath),
        save: async (state) => {
          if (state.campaigns.twitch[0]?.rewards[0]?.status === "claimed") {
            commitStarted();
            await pendingCommit;
          }
          await saveState(statePath, state);
        },
      },
      activityHistory: {
        ...history,
        append: async (events) => {
          if (
            events.some((event) => event.category === "activity" && event.code === "reward_claimed")
          ) {
            reportStarted();
            await pendingReport;
          }
          await history.append(events);
        },
      },
      transport: { ...transport, dispose },
      logger: quiet,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    try {
      await committing;
      process.emit("SIGTERM");
      expect(await aborted).toEqual(new Error("Controller shutdown"));
      finishCommit();
      await reporting;
      // The state write is complete, but the farming job still owes its report.
      await setImmediate();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      finishCommit();
      finishReport();
      await running;
    }

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toContain("reward_claimed");
    expect(await readFile(statePath, "utf8")).toContain('"status": "claimed"');
  });

  it.each(["SIGTERM", "stdin EOF"] as const)(
    "flushes both sidecars on %s even if disposal fails",
    async (trigger) => {
      dir = await mkdtemp(join(tmpdir(), "serve-activity-stop-"));
      const statePath = join(dir, "state.json");
      const path = stateSidecarPath(statePath, "activity");
      const history = createFileActivityHistory(path);
      await history.clear(); // Put subsequent appends inside the write interval.
      const diagnostics = join(dir, "state.json.diagnostics.json");
      const { promise: pendingClaim, resolve: finishClaim } = deferred<void>();
      const input = new PassThrough();
      let port = 0;
      const running = serveLoop({
        binding: { host: "127.0.0.1", port: 0 },
        settings: DEFAULT_CLI_SETTINGS,
        statePath,
        stateStore: memoryStateStore(),
        activityHistory: history,
        transport: {
          ...claimingTransport(() => pendingClaim),
          dispose: async () => {
            throw new Error("Transport disposal failed");
          },
        },
        logger: quiet,
        appRoot: null,
        exitWithInput: input,
        describeCredentials: () => describeCredentialHealth("/nonexistent-lurkloot-auth", {}),
        checkCredentialAvailability: async () => ({ status: "available" }),
        onListening: (address) => {
          port = address.port;
        },
      });
      const stopped = expect(running).rejects.toThrow("Transport disposal failed");
      try {
        await vi.waitFor(() => expect(port).not.toBe(0));
        // A first diagnostics write puts the later claim mirror inside its write interval.
        await vi.waitFor(async () => expect(await readFile(diagnostics, "utf8")).toBeTruthy());
        finishClaim();
        await vi.waitFor(
          async () => {
            expect((await activity(port)).some((event) => event.code === "reward_claimed")).toBe(
              true,
            );
          },
          { timeout: 5_000 },
        );
        expect(await readFile(path, "utf8")).not.toContain("reward_claimed");
        expect(await readFile(diagnostics, "utf8")).not.toContain("Claimed ");
      } finally {
        finishClaim();
        if (trigger === "SIGTERM") process.emit("SIGTERM");
        else input.end();
        await stopped;
      }
      expect(await readFile(path, "utf8")).toContain("reward_claimed");
      expect(await readFile(diagnostics, "utf8")).toContain("Claimed ");
    },
  );
});
