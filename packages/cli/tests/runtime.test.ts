import { describe, expect, it, vi } from "vitest";
import type { EngineEvent, FarmingStopReason } from "@lurkloot/shared/events";
import type { Logger } from "../src/logger";
import { formatCliEvent, reportCliEvents } from "../src/events";
import { createLogger } from "../src/logger";

function rewardEvent(
  code: "farming_started" | "farming_stopped" | "reward_claimed",
  rewardName: string,
  extra: Record<string, unknown> = {},
): EngineEvent {
  return {
    category: "activity",
    code,
    level: "info",
    platform: "twitch",
    data: {
      campaignId: "campaign-id",
      campaignName: "Campaign",
      rewardId: "reward-id",
      rewardName,
      ...extra,
    },
  } as EngineEvent;
}

function recordingLogger(lines: string[]): Logger {
  const log = (level: Logger["level"], message: string, scope?: string) => {
    lines.push(`${level.toUpperCase()}${scope ? ` [${scope}]` : ""} ${message}`);
  };
  return {
    level: "debug",
    log,
    debug: (message, scope) => log("debug", message, scope),
    info: (message, scope) => log("info", message, scope),
    warn: (message, scope) => log("warn", message, scope),
    error: (message, scope) => log("error", message, scope),
  };
}

describe("CLI engine event reporting", () => {
  it("logs an event batch in causal order through the logger", async () => {
    const lines: string[] = [];
    await reportCliEvents([
      rewardEvent("farming_started", "Reward A"),
      rewardEvent("farming_stopped", "Reward A", { reason: "target_changed" }),
      rewardEvent("farming_started", "Reward B"),
    ], recordingLogger(lines));

    expect(lines).toEqual([
      "INFO [twitch] Started farming Reward A from Campaign",
      "INFO [twitch] Stopped farming Reward A from Campaign: target changed",
      "INFO [twitch] Started farming Reward B from Campaign",
    ]);
  });

  it.each([
    ["warn", ["WARN [kick] Farming interrupted: platform error (HTTP 503)"]],
    ["error", []],
  ] as const)("suppresses debug and info engine events at the %s logger threshold", async (level, expected) => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    try {
      await reportCliEvents([
        {
          category: "diagnostic",
          code: "request",
          level: "debug",
          platform: "twitch",
          message: "request detail",
        },
        rewardEvent("farming_started", "Reward A"),
        {
          category: "activity",
          code: "interruption",
          level: "warn",
          platform: "kick",
          data: { reason: "platform_error", detail: "HTTP 503" },
        },
      ], createLogger(level));

      const lines = write.mock.calls.map(([line]) => String(line).replace(/^\S+ /, "").trim());
      expect(lines).toEqual(expected);
    } finally {
      write.mockRestore();
    }
  });

  it("formats every activity variant and passes diagnostic prose through", () => {
    expect(formatCliEvent(rewardEvent("reward_claimed", "Reward", { method: "automatic" })))
      .toBe("Claimed Reward from Campaign automatically");
    expect(formatCliEvent({
      category: "activity",
      code: "interruption",
      level: "warn",
      platform: "kick",
      data: { reason: "platform_error", detail: "HTTP 503" },
    })).toBe("Farming interrupted: platform error (HTTP 503)");
    expect(formatCliEvent({
      category: "diagnostic",
      level: "debug",
      platform: "twitch",
      message: "request detail",
      code: "request",
      data: { status: 200 },
    })).toBe("request detail");
  });

  it("formats every stable stop reason", () => {
    const reasons: FarmingStopReason[] = [
      "automation_disabled", "platform_disabled", "platform_backoff", "platform_error",
      "campaign_ineligible", "channel_excluded", "channel_offline", "channel_mismatch",
      "watch_unhealthy", "higher_priority_reward", "higher_priority_watch_queue",
      "watch_requirement_completed", "runtime_restart", "target_changed", "manual_watch",
    ];
    for (const reason of reasons) {
      expect(formatCliEvent(rewardEvent("farming_stopped", "Reward", { reason })))
        .toContain(reason.replaceAll("_", " "));
    }
  });
});
