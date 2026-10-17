import { describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "@lurkloot/shared/events";
import {
  fetchKickAccountProgress,
  KICK_LEVEL_URL,
  kickStreakUrl,
  parseKickLevel,
  parseKickStreak,
} from "@lurkloot/core/kick/accountProgress";

// Kick's level and streak, as kick.com returned them (values from a live HAR).
const LEVEL = {
  data: {
    badge: { badge_type: "global", name: "level", metadata: { level: 56 } },
    level: 56,
    progress_xp: 7146,
    total_xp: 219450,
    user_id: 25869961,
    xp_to_next_level: 4636,
  },
  message: "success",
};
const STREAK = { data: { length_days: 25 }, message: "success" };

function fetcher(responses: Record<string, unknown>) {
  const fetchJson = vi.fn(async (url: string) => {
    const response = responses[url];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected ${url}`);
    return response;
  });
  return { fetchJson } as unknown as Parameters<typeof fetchKickAccountProgress>[0] & {
    fetchJson: typeof fetchJson;
  };
}

describe("Kick account progress", () => {
  it("parses the level, the XP inside it and the user it belongs to", () => {
    expect(parseKickLevel(LEVEL)).toEqual({
      progress: { platform: "kick", level: 56, progressXp: 7146, xpToNextLevel: 4636 },
      userId: "25869961",
    });
  });

  it("rejects a level body missing any of level, progress or XP to next", () => {
    expect(parseKickLevel({ data: { level: 56, progress_xp: 10 } })).toBeUndefined();
    expect(
      parseKickLevel({ data: { level: -1, progress_xp: 1, xp_to_next_level: 1 } }),
    ).toBeUndefined();
    expect(
      parseKickLevel({ data: { level: "x", progress_xp: 1, xp_to_next_level: 1 } }),
    ).toBeUndefined();
    expect(parseKickLevel(null)).toBeUndefined();
    expect(parseKickLevel({})).toBeUndefined();
  });

  it("parses the streak in days and nothing else", () => {
    expect(parseKickStreak(STREAK)).toBe(25);
    expect(parseKickStreak({ data: { length_days: 0 } })).toBe(0);
    expect(parseKickStreak({ data: {} })).toBeUndefined();
    expect(parseKickStreak({ data: { length_days: 2.5 } })).toBeUndefined();
  });

  it("reads the streak of the user the level belongs to", async () => {
    const fake = fetcher({ [KICK_LEVEL_URL]: LEVEL, [kickStreakUrl("25869961")]: STREAK });

    await expect(fetchKickAccountProgress(fake, { emit: () => undefined })).resolves.toEqual({
      platform: "kick",
      level: 56,
      progressXp: 7146,
      xpToNextLevel: 4636,
      streakDays: 25,
    });
    expect(fake.fetchJson.mock.calls.map(([url]) => url)).toEqual([
      "https://web.kick.com/api/v1/gamification/user/level",
      "https://web.kick.com/api/v1/gamification/users/25869961/streak",
    ]);
  });

  it("keeps the level when the streak cannot be read", async () => {
    const events: EngineEvent[] = [];
    const fake = fetcher({
      [KICK_LEVEL_URL]: LEVEL,
      [kickStreakUrl("25869961")]: new Error("streak down"),
    });

    const progress = await fetchKickAccountProgress(fake, { emit: (e) => events.push(e) });
    expect(progress).toMatchObject({ level: 56 });
    expect(progress).not.toHaveProperty("streakDays");
    expect(events).toContainEqual(
      expect.objectContaining({ level: "debug", message: "Kick streak read failed: streak down" }),
    );
  });

  it("skips the streak without a user id, and reads nothing from an unreadable level", async () => {
    const withoutUser = fetcher({
      [KICK_LEVEL_URL]: { data: { level: 2, progress_xp: 0, xp_to_next_level: 50 } },
    });
    await expect(fetchKickAccountProgress(withoutUser, { emit: () => undefined })).resolves.toEqual(
      { platform: "kick", level: 2, progressXp: 0, xpToNextLevel: 50 },
    );
    expect(withoutUser.fetchJson).toHaveBeenCalledOnce();

    const unreadable = fetcher({ [KICK_LEVEL_URL]: { data: {} } });
    await expect(
      fetchKickAccountProgress(unreadable, { emit: () => undefined }),
    ).resolves.toBeUndefined();
    expect(unreadable.fetchJson).toHaveBeenCalledOnce();
  });

  it("lets a level failure reach the caller", async () => {
    const fake = fetcher({ [KICK_LEVEL_URL]: new Error("level down") });
    await expect(fetchKickAccountProgress(fake, { emit: () => undefined })).rejects.toThrow(
      "level down",
    );
  });
});
