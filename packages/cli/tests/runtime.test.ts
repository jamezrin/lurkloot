import { describe, expect, it, vi } from "vitest";
import type { EngineEvent, FarmingStopReason } from "@lurkloot/shared/events";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import type { Logger } from "../src/logger";
import { formatCliEvent, reportCliEvents } from "../src/events";
import { createLogger } from "../src/logger";
import { formatDiscoveredCampaign, subscriptionWaitKeys } from "../src/runtime/status";

function dropReward(overrides: Partial<DropReward>): DropReward {
  return {
    id: "reward",
    name: "Reward",
    requiredMinutes: 0,
    watchedMinutes: 0,
    status: "locked",
    ...overrides,
  };
}

function dropCampaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "arc-raiders-summer",
    platform: "twitch",
    name: "ARC Raiders Summer Drops",
    status: "active",
    rewards: [],
    ...overrides,
  };
}

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
      "automation_disabled", "platform_disabled", "authentication_unhealthy", "platform_backoff", "platform_error",
      "campaign_ineligible", "channel_excluded", "channel_offline", "channel_mismatch",
      "watch_unhealthy", "higher_priority_reward", "higher_priority_idle_watchlist",
      "watch_requirement_completed", "runtime_restart", "target_changed", "manual_watch",
    ];
    for (const reason of reasons) {
      expect(formatCliEvent(rewardEvent("farming_stopped", "Reward", { reason })))
        .toContain(reason.replaceAll("_", " "));
    }
  });

  it("formats managed page-context lifecycle activity", () => {
    expect(formatCliEvent({
      category: "activity",
      code: "page_context_opened",
      level: "info",
      platform: "kick",
      data: { host: "kick.com", reason: "background_rejected" },
    })).toBe("Opened background context on kick.com: background request rejected");
    expect(formatCliEvent({
      category: "activity",
      code: "page_context_closed",
      level: "info",
      platform: "kick",
      data: { host: "kick.com", reason: "background_recovered" },
    })).toBe("Closed background context on kick.com: background requests recovered");
    expect(formatCliEvent({
      category: "activity",
      code: "page_context_closed",
      level: "info",
      platform: "kick",
      data: { host: "kick.com", reason: "runtime_restart" },
    })).toBe("Closed background context on kick.com: extension runtime restarted");
  });
});

describe("CLI campaign status reporting", () => {
  it("formats subscription requirements without inventing partial progress", () => {
    const campaign = dropCampaign({
      eligibility: "waiting_for_subscription",
      rewards: [
        dropReward({ id: "duffel", name: "Purple Duffel Bag", requirement: "subscription", requiredSubs: 1 }),
        dropReward({ id: "mace", name: "Bastion Mace", requirement: "subscription", requiredSubs: 3 }),
      ],
    });

    expect(formatDiscoveredCampaign(campaign)).toEqual([
      "• ARC Raiders Summer Drops — waiting for subscription",
      "  ◦ Purple Duffel Bag — requires 1 qualifying subscription; progress unavailable",
      "  ◦ Bastion Mace — requires 3 qualifying subscriptions; progress unavailable",
    ]);
  });

  it("labels claimed rewards as earned and preserves both requirement types in mixed campaigns", () => {
    const campaign = dropCampaign({
      name: "Mixed Drops",
      rewards: [
        dropReward({ id: "watch", name: "Watch Crown", requirement: "watch", requiredMinutes: 60, watchedMinutes: 30 }),
        dropReward({ id: "sub", name: "Subscriber Cape", requirement: "subscription", requiredSubs: 2 }),
        dropReward({ id: "earned", name: "Earned Badge", requirement: "subscription", requiredSubs: 1, status: "claimed" }),
      ],
    });

    expect(formatDiscoveredCampaign(campaign)).toEqual([
      "• Mixed Drops",
      "  ◦ Watch Crown — requires 60 minutes watched; progress 30/60 minutes",
      "  ◦ Subscriber Cape — requires 2 qualifying subscriptions; progress unavailable",
      "  ◦ Earned Badge — earned",
    ]);
  });

  it("returns stable message keys for active subscription rewards that are genuinely waiting", () => {
    const campaign = dropCampaign({
      eligibility: "waiting_for_subscription",
      rewards: [
        dropReward({ id: "duffel", name: "Purple Duffel Bag", requiredSubs: 1 }),
        dropReward({ id: "mace", name: "Bastion Mace", requirement: "subscription", requiredSubs: 3, status: "in_progress" }),
        dropReward({ id: "watch", name: "Watch Crown", requirement: "watch", requiredMinutes: 60 }),
        dropReward({ id: "earned", name: "Earned Badge", requirement: "subscription", requiredSubs: 1, status: "claimed" }),
      ],
    });

    expect([...subscriptionWaitKeys([campaign])]).toEqual([
      ["twitch:arc-raiders-summer:duffel", "Waiting for 1 qualifying subscription: Purple Duffel Bag from ARC Raiders Summer Drops"],
      ["twitch:arc-raiders-summer:mace", "Waiting for 3 qualifying subscriptions: Bastion Mace from ARC Raiders Summer Drops"],
    ]);
  });

  it("excludes subscription rewards that are not currently waiting for the user", () => {
    const waiting = dropCampaign({
      eligibility: "waiting_for_subscription",
      rewards: [
        dropReward({ id: "claimable", requirement: "subscription", requiredSubs: 1, status: "claimable" }),
        dropReward({ id: "claimed", requirement: "subscription", requiredSubs: 1, status: "claimed" }),
        dropReward({ id: "future", requirement: "subscription", requiredSubs: 1, availableFrom: "2999-01-01T00:00:00.000Z" }),
        dropReward({ id: "ended", requirement: "subscription", requiredSubs: 1, availableUntil: "2000-01-01T00:00:00.000Z" }),
        dropReward({ id: "prerequisite", requirement: "subscription", requiredSubs: 1, preconditionsMet: false }),
      ],
    });
    const mixed = dropCampaign({
      id: "mixed",
      eligibility: "eligible",
      rewards: [
        dropReward({ id: "watch", requirement: "watch", requiredMinutes: 60 }),
        dropReward({ id: "mixed-sub", name: "Mixed Subscription", requirement: "subscription", requiredSubs: 2 }),
      ],
    });
    const upcoming = dropCampaign({
      id: "upcoming",
      status: "upcoming",
      eligibility: "upcoming",
      rewards: [dropReward({ id: "upcoming-sub", requirement: "subscription", requiredSubs: 1 })],
    });
    const expired = dropCampaign({
      id: "expired",
      status: "expired",
      eligibility: "expired",
      rewards: [dropReward({ id: "expired-sub", requirement: "subscription", requiredSubs: 1 })],
    });
    const unlinked = dropCampaign({
      id: "unlinked",
      eligibility: "account_not_linked",
      accountLinked: false,
      rewards: [dropReward({ id: "unlinked-sub", requirement: "subscription", requiredSubs: 1 })],
    });
    const eligibleSubscriptionOnly = dropCampaign({
      id: "eligible-subscription-only",
      eligibility: "eligible",
      rewards: [dropReward({ id: "not-genuinely-waiting", requirement: "subscription", requiredSubs: 1 })],
    });

    expect([...subscriptionWaitKeys([waiting, mixed, upcoming, expired, unlinked, eligibleSubscriptionOnly])]).toEqual([
      ["twitch:mixed:mixed-sub", "Waiting for 2 qualifying subscriptions: Mixed Subscription from ARC Raiders Summer Drops"],
    ]);
  });
});
