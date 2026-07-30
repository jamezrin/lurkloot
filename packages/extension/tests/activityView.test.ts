import { describe, expect, it, vi } from "vitest";
import type { ActivityHistoryRecord, FarmingStopReason } from "@lurkloot/shared/events";
import {
  advanceActivityRequestScope,
  applyActivityMutationForRequest,
  applyActivityPage,
  applyActivityPageForRequest,
  beginActivityMutation,
  buildActivityExport,
  createActivityMutationSequence,
  createActivityRequestScope,
  createActivityStream,
  formatActivityEvent,
  isActivityRequestCurrent,
  isLatestActivityMutation,
  mergeActivityPages,
} from "@lurkloot/popup-ui";

const at = "2026-07-14T12:00:00.000Z";

function event(id: string, eventAt = at): ActivityHistoryRecord {
  return {
    id,
    at: eventAt,
    category: "activity",
    code: "interruption",
    level: "warn",
    data: { reason: "runtime_restart" },
  };
}

describe("activity view model", () => {
  it("formats current activity wording from code and payload", () => {
    const t = vi.fn((key: string, substitutions?: string | string[]) =>
      `${key}:${Array.isArray(substitutions) ? substitutions.join("|") : substitutions ?? ""}`);
    const stopped: ActivityHistoryRecord = {
      id: "stopped",
      at,
      category: "activity",
      code: "farming_stopped",
      level: "warn",
      platform: "twitch",
      data: {
        campaignId: "campaign",
        campaignName: "Campaign",
        rewardId: "reward",
        rewardName: "Reward",
        reason: "runtime_restart",
      },
    };

    expect(formatActivityEvent(stopped, t)).toBe(
      "activityFarmingStopped:Reward|Campaign|activityReasonRuntimeRestart:",
    );
    expect(t).toHaveBeenCalledWith("activityReasonRuntimeRestart");
  });

  it("formats managed page-context opens and closes with their reasons", () => {
    const t = vi.fn((key: string, substitutions?: string | string[]) =>
      `${key}:${Array.isArray(substitutions) ? substitutions.join("|") : substitutions ?? ""}`);

    expect(formatActivityEvent({
      id: "opened",
      at,
      category: "activity",
      code: "page_context_opened",
      level: "info",
      platform: "kick",
      data: { host: "kick.com", reason: "background_rejected" },
    }, t)).toBe("activityPageContextOpened:kick.com|activityPageContextOpenReasonBackgroundRejected:");

    expect(formatActivityEvent({
      id: "closed",
      at,
      category: "activity",
      code: "page_context_closed",
      level: "info",
      platform: "kick",
      data: { host: "kick.com", reason: "background_recovered" },
    }, t)).toBe("activityPageContextClosed:kick.com|activityPageContextCloseReasonBackgroundRecovered:");
  });

  it("formats complete authentication health transitions", () => {
    const t = vi.fn((key: string, substitutions?: string | string[]) =>
      `${key}:${Array.isArray(substitutions) ? substitutions.join("|") : substitutions ?? ""}`);

    expect(formatActivityEvent({
      id: "auth-transition",
      at,
      category: "activity",
      code: "auth_health_changed",
      level: "warn",
      platform: "kick",
      data: { from: "checking", to: "missing_credentials", reason: "credentials_missing" },
    }, t)).toBe("activityAuthHealthChanged:kick|checking|missing_credentials");
    expect(t).toHaveBeenCalledWith("activityAuthHealthChanged", ["kick", "checking", "missing_credentials"]);
  });

  it("formats every farming stop reason through its locale key", () => {
    const t = vi.fn((key: string) => key);
    const reasons: FarmingStopReason[] = [
      "automation_disabled",
      "platform_disabled",
      "authentication_unhealthy",
      "platform_backoff",
      "platform_error",
      "campaign_ineligible",
      "channel_excluded",
      "channel_offline",
      "channel_mismatch",
      "watch_unhealthy",
      "higher_priority_reward",
      "higher_priority_idle_watchlist",
      "watch_requirement_completed",
      "runtime_restart",
      "target_changed",
      "manual_watch",
    ];

    for (const reason of reasons) {
      formatActivityEvent({
        id: reason,
        at,
        category: "activity",
        code: "interruption",
        level: "warn",
        data: { reason },
      }, t);
    }

    expect(t.mock.calls.map(([key]) => key)).toEqual([
      "activityReasonAutomationDisabled", "activityInterruption",
      "activityReasonPlatformDisabled", "activityInterruption",
      "activityReasonAuthenticationUnhealthy", "activityInterruption",
      "activityReasonPlatformBackoff", "activityInterruption",
      "activityReasonPlatformError", "activityInterruption",
      "activityReasonCampaignIneligible", "activityInterruption",
      "activityReasonChannelExcluded", "activityInterruption",
      "activityReasonChannelOffline", "activityInterruption",
      "activityReasonChannelMismatch", "activityInterruption",
      "activityReasonWatchUnhealthy", "activityInterruption",
      "activityReasonHigherPriorityReward", "activityInterruption",
      "activityReasonHigherPriorityIdleWatchlist", "activityInterruption",
      "activityReasonWatchRequirementCompleted", "activityInterruption",
      "activityReasonRuntimeRestart", "activityInterruption",
      "activityReasonTargetChanged", "activityInterruption",
      "activityReasonManualWatch", "activityInterruption",
    ]);
  });

  it("uses stored prose only for diagnostics and legacy fallback", () => {
    const t = vi.fn((key: string) => key);
    const diagnostic: ActivityHistoryRecord = {
      id: "diagnostic",
      at,
      category: "diagnostic",
      level: "debug",
      message: "network detail",
    };
    const legacy: ActivityHistoryRecord = {
      id: "legacy",
      at,
      level: "info",
      message: "old activity",
      legacy: true,
    };

    expect(formatActivityEvent(diagnostic, t)).toBe("network detail");
    expect(formatActivityEvent(legacy, t)).toBe("old activity");
    expect(t).not.toHaveBeenCalled();
  });

  it("merges refreshed and paged results without duplicates", () => {
    expect(mergeActivityPages([event("2"), event("1")], [event("3"), event("2")])
      .map((entry) => entry.id)).toEqual(["3", "2", "1"]);
  });

  it("reopens pagination when a refresh creates a gap after exhaustion", () => {
    let stream = applyActivityPage(
      createActivityStream(),
      { events: [event("3"), event("2")], nextCursor: "after-2" },
      "refresh",
    );
    expect(stream.initialized).toBe(true);
    expect(stream.nextCursor).toBe("after-2");

    stream = applyActivityPage(stream, { events: [event("1")] }, "page");
    expect(stream.nextCursor).toBeUndefined();

    stream = applyActivityPage(
      stream,
      { events: [event("5"), event("4")], nextCursor: "after-4" },
      "refresh",
    );
    expect(stream.events.map((entry) => entry.id)).toEqual(["5", "4", "3", "2", "1"]);
    expect(stream.nextCursor).toBe("after-4");
  });

  it("keeps exhausted coverage when a refreshed page overlaps loaded history", () => {
    const exhausted = applyActivityPage(
      applyActivityPage(createActivityStream(), { events: [event("3"), event("2")], nextCursor: "after-2" }, "refresh"),
      { events: [event("1")] },
      "page",
    );

    const refreshed = applyActivityPage(
      exhausted,
      { events: [event("4"), event("3")], nextCursor: "after-3" },
      "refresh",
    );
    expect(refreshed.nextCursor).toBeUndefined();
  });

  it("replaces stale duplicate content with the incoming record", () => {
    const stale: ActivityHistoryRecord = { id: "same", at, level: "info", message: "stale", legacy: true };
    const fresh: ActivityHistoryRecord = { ...stale, message: "fresh" };

    expect(mergeActivityPages([stale], [fresh])).toEqual([fresh]);
  });

  it("invalidates requests across platform resets and clear generations", () => {
    const twitch = createActivityRequestScope("twitch");
    const kick = advanceActivityRequestScope(twitch, "kick");
    const afterClear = advanceActivityRequestScope(kick);

    expect(isActivityRequestCurrent(twitch, kick)).toBe(false);
    expect(isActivityRequestCurrent(kick, afterClear)).toBe(false);
    expect(isActivityRequestCurrent(afterClear, afterClear)).toBe(true);
  });

  it("rejects an older refresh response after a newer refresh was issued", () => {
    const sequence = createActivityMutationSequence();
    const scope = createActivityRequestScope("twitch");
    const older = beginActivityMutation(sequence);
    const newer = beginActivityMutation(sequence);
    const current = applyActivityMutationForRequest(
      createActivityStream(),
      { events: [event("newer")], nextCursor: "newer-cursor" },
      "refresh",
      scope,
      scope,
      sequence,
      newer,
    );

    expect(isLatestActivityMutation(sequence, older)).toBe(false);
    expect(isLatestActivityMutation(sequence, newer)).toBe(true);
    expect(applyActivityMutationForRequest(
      current,
      { events: [event("older")], nextCursor: "older-cursor" },
      "refresh",
      scope,
      scope,
      sequence,
      older,
    )).toBe(current);
    expect(current.nextCursor).toBe("newer-cursor");
  });

  it("rejects an older page response after a newer disjoint refresh", () => {
    const sequence = createActivityMutationSequence();
    const scope = createActivityRequestScope("twitch");
    const initial = applyActivityPage(
      createActivityStream(),
      { events: [event("covered")], nextCursor: "page-start" },
      "refresh",
    );
    const pageRequest = beginActivityMutation(sequence);
    const refreshRequest = beginActivityMutation(sequence);
    const refreshed = applyActivityMutationForRequest(
      initial,
      { events: [event("new-2"), event("new-1")], nextCursor: "refresh-gap" },
      "refresh",
      scope,
      scope,
      sequence,
      refreshRequest,
    );

    expect(applyActivityMutationForRequest(
      refreshed,
      { events: [event("old-page")], nextCursor: "skipped-gap" },
      "page",
      scope,
      scope,
      sequence,
      pageRequest,
    )).toBe(refreshed);
    expect(refreshed.nextCursor).toBe("refresh-gap");
  });

  it("ignores stale platform pages and stale loading completions", () => {
    const twitchRequest = createActivityRequestScope("twitch");
    const currentScope = advanceActivityRequestScope(twitchRequest, "kick");
    const current = applyActivityPage(createActivityStream(), { events: [event("kick-current")] }, "refresh");
    const platformLessStale: ActivityHistoryRecord = {
      id: "platform-less-stale",
      at,
      category: "diagnostic",
      level: "debug",
      message: "stale",
    };

    expect(applyActivityPageForRequest(
      current,
      { events: [platformLessStale], nextCursor: "stale-cursor" },
      "page",
      twitchRequest,
      currentScope,
    )).toBe(current);
    expect(isActivityRequestCurrent(twitchRequest, currentScope)).toBe(false);
  });

  it("orders merged streams newest first and uses id as a stable tie-breaker", () => {
    expect(mergeActivityPages(
      [event("a", "2026-07-14T11:00:00.000Z")],
      [event("c"), event("b")],
    ).map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });
});

describe("activity export", () => {
  const exportInput = {
    platform: "kick" as const,
    diagnostics: false,
    version: "1.9.0",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    locale: "en",
    at: "2026-07-26T09:00:00.000Z",
  };
  const t = (key: string) => key;

  it("writes a header and the events oldest first, one per line", () => {
    const text = buildActivityExport({
      ...exportInput,
      // Held newest first, as the popup state does.
      events: [
        { id: "b", at: "2026-07-14T12:00:00.000Z", legacy: true, level: "warn", message: "second" },
        { id: "a", at: "2026-07-14T11:00:00.000Z", legacy: true, level: "info", message: "first" },
      ],
    }, t);

    expect(text.split("\n\n")[0].split("\n")).toEqual([
      "Lurkloot activity log",
      "version: 1.9.0",
      "platform: kick",
      "locale: en",
      "exported: 2026-07-26T09:00:00.000Z",
      "browser: Mozilla/5.0 (X11; Linux x86_64)",
      "events: 2",
    ]);
    expect(text.trimEnd().split("\n").slice(-2)).toEqual([
      "2026-07-14T11:00:00.000Z [info] first",
      "2026-07-14T12:00:00.000Z [warn] second",
    ]);
  });

  it("labels the diagnostics view and handles an empty list", () => {
    const text = buildActivityExport({ ...exportInput, diagnostics: true, events: [] }, t);

    expect(text).toContain("Lurkloot diagnostics log");
    expect(text).toContain("events: 0");
    expect(text.trimEnd().endsWith("(no events)")).toBe(true);
  });
});
