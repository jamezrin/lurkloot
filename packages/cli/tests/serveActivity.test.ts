import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { ActivityHistoryRecord, EventEmitter } from "@lurkloot/shared/events";
import type { ActivityPage, ActivitySessionsPage } from "@lurkloot/shared/messages";
import type { DropCampaign } from "@lurkloot/shared/models";
import { describeCredentialHealth } from "../src/authStore";
import { createLogger } from "../src/logger";
import { runLoop } from "../src/runtime/run";
import { serveLoop } from "../src/runtime/serve";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import type { TransportHandle } from "../src/transport";
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
// also reports a diagnostic carrying a planted secret, which must not be kept.
function claimingTransport(): TransportHandle {
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
    claimReward: async () => {
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

    // The diagnostic was reported, and went to the log only.
    expect(logged).toContain(PLANTED_SECRET);
    const onDisk = await readFile(join(dir, "activity.json"), "utf8");
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
    expect(JSON.parse(await readFile(join(dir, "activity.json"), "utf8"))).toEqual(
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
    const onDisk = JSON.parse(await readFile(join(dir, "activity.json"), "utf8")) as {
      events: ActivityHistoryRecord[];
    };
    expect(onDisk.events.map((event) => event.code)).toContain("reward_claimed");
    expect(onDisk.events.every((event) => event.category === "activity")).toBe(true);
  });
});
