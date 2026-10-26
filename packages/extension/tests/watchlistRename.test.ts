import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE, mergeSchedulerState } from "@lurkloot/core/defaults";
import { formatActivityEvent } from "@lurkloot/popup-ui";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import { parseSettingsImportPayload } from "@lurkloot/shared/settingsExport";
import { migrateSettings } from "@lurkloot/shared/settingsSchema";

// Everything a build before schema 10 could have stored under the Idle
// Watchlist names: channel lists, streak opt-ins and the source id.
const OLD_PLATFORM = {
  twitch: {
    idleWatchlistChannels: ["alpha", "beta"],
    idleWatchlistStreakChannels: ["beta"],
    watchSourcePriority: ["idle_watchlist", "watch_streaks", "drops", "nopixel", "fortnite"],
  },
  kick: {
    idleWatchlistChannels: ["gamma"],
    watchSourcePriority: ["idle_watchlist", "drops"],
  },
};

function expectCarriedOver(settings: ReturnType<typeof mergeSettings>) {
  expect(settings.platform.twitch.watchlistChannels).toEqual(["alpha", "beta"]);
  expect(settings.platform.twitch.watchlistStreakChannels).toEqual(["beta"]);
  expect(settings.platform.twitch.watchSourcePriority).toEqual([
    "watchlist",
    "watch_streaks",
    "drops",
    "nopixel",
    "fortnite",
  ]);
  expect(settings.platform.kick.watchlistChannels).toEqual(["gamma"]);
  expect(settings.platform.kick.watchSourcePriority).toEqual(["watchlist", "drops"]);
}

describe("Idle Watchlist → Watchlist rename (schema 10)", () => {
  it("migrates a stored document with every old key", () => {
    const migration = migrateSettings({
      schemaVersion: 9,
      platform: structuredClone(OLD_PLATFORM),
    });
    expect(migration.settings.platform).toEqual({
      twitch: {
        watchlistChannels: ["alpha", "beta"],
        watchlistStreakChannels: ["beta"],
        watchSourcePriority: ["watchlist", "watch_streaks", "drops", "nopixel", "fortnite"],
      },
      kick: { watchlistChannels: ["gamma"], watchSourcePriority: ["watchlist", "drops"] },
    });
    expect(migration.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "platform.twitch.idleWatchlistChannels",
      "platform.twitch.idleWatchlistStreakChannels",
      "platform.kick.idleWatchlistChannels",
    ]);
    expectCarriedOver(mergeSettings(migration.settings as never));
  });

  it("keeps the old data when a document reaches normalization unmigrated", () => {
    expectCarriedOver(mergeSettings({ platform: structuredClone(OLD_PLATFORM) } as never));
  });

  it("imports an export written before the rename", () => {
    const { settings } = parseSettingsImportPayload({
      kind: "lurkloot-settings",
      schemaVersion: 9,
      exportedAt: "2026-10-01T00:00:00.000Z",
      settings: { ...structuredClone(DEFAULT_SETTINGS), platform: structuredClone(OLD_PLATFORM) },
    });
    expectCarriedOver(settings);
  });

  it("carries the old Idle-first preference over to the Watchlist", () => {
    const settings = mergeSettings(
      migrateSettings({
        schemaVersion: 5,
        idleWatchlistFallbackOnly: false,
        platform: { twitch: { idleWatchlistChannels: ["alpha"] } },
      }).settings as never,
    );
    expect(settings.platform.twitch.watchlistChannels).toEqual(["alpha"]);
    expect(settings.platform.twitch.watchSourcePriority).toEqual([
      "watch_streaks",
      "watchlist",
      "drops",
      "nopixel",
      "fortnite",
    ]);
  });

  it("reads old reason codes from stored sessions and activity history", () => {
    const stored = structuredClone(DEFAULT_STATE) as SchedulerState;
    stored.sessions.twitch = {
      ...stored.sessions.twitch,
      reasonCode: "idle_watchlist_selected" as never,
    };
    stored.sessions.kick = {
      ...stored.sessions.kick,
      reasonCode: "keeping_idle_watchlist" as never,
    };
    const state = mergeSchedulerState(JSON.parse(JSON.stringify(stored)));
    expect(state.sessions.twitch.reasonCode).toBe("watchlist_selected");
    expect(state.sessions.kick.reasonCode).toBe("keeping_watchlist");

    const t = vi.fn((key: string) => key);
    const record: ActivityHistoryRecord = {
      id: "old",
      at: "2026-10-01T00:00:00.000Z",
      category: "activity",
      code: "farming_stopped",
      level: "warn",
      platform: "twitch",
      data: {
        campaignId: "campaign",
        campaignName: "Campaign",
        rewardId: "reward",
        rewardName: "Reward",
        reason: "higher_priority_idle_watchlist" as never,
      },
    };
    formatActivityEvent(record, t);
    expect(t).toHaveBeenCalledWith("activityReasonHigherPriorityWatchlist");
  });
});
