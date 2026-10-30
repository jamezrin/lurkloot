import { describe, expect, it } from "vitest";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { FarmingSessionSummary } from "@lurkloot/shared/farmingSessions";
import { buildActivityTimeline, buildRewardView } from "@lurkloot/popup-ui";

const t = (key: string, substitutions?: string | string[]) =>
  [
    key,
    ...(Array.isArray(substitutions) ? substitutions : substitutions ? [substitutions] : []),
  ].join(":");

function summary(
  id: string,
  startedAt: string,
  endedAt?: string,
  overrides: Partial<FarmingSessionSummary> = {},
): FarmingSessionSummary {
  return {
    id,
    platform: "twitch",
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    tallies: {},
    rewardCounts: {},
    ...overrides,
  };
}

function drop(id: string, at: string, sessionId?: string | null): ActivityHistoryRecord {
  return {
    id,
    at,
    category: "activity",
    code: "reward_claimed",
    level: "info",
    platform: "twitch",
    ...(sessionId !== undefined ? { sessionId } : {}),
    data: {
      campaignId: "c",
      campaignName: "Season 12 Drops",
      rewardId: id,
      rewardName: "Golden Pickaxe",
      rewardImageUrl: "https://static-cdn.jtvnw.net/reward.png",
      gameName: "Rust",
      gameImageUrl: "https://static-cdn.jtvnw.net/rust.jpg",
      channel: "shroud",
      campaignUrl: "https://www.twitch.tv/drops/campaigns",
      method: "automatic",
    },
  } as ActivityHistoryRecord;
}

function interruption(id: string, at: string, sessionId?: string): ActivityHistoryRecord {
  return {
    id,
    at,
    category: "activity",
    code: "interruption",
    level: "warn",
    ...(sessionId ? { platform: "twitch", sessionId } : {}),
    data: { reason: "runtime_restart" },
  } as ActivityHistoryRecord;
}

describe("activity timeline", () => {
  it("files rows by session, outside a session per day, and legacy rows under Earlier", () => {
    const sessions = [
      summary("open", "2026-10-30T10:00:00.000Z"),
      summary("past", "2026-10-29T18:00:00.000Z", "2026-10-29T22:00:00.000Z"),
    ];
    const events = [
      drop("in-open", "2026-10-30T11:00:00.000Z", "open"),
      interruption("status-open", "2026-10-30T10:30:00.000Z", "open"),
      drop("in-past", "2026-10-29T19:00:00.000Z", "past"),
      drop("outside", "2026-10-29T12:00:00.000Z", null),
      drop("legacy", "2026-10-20T12:00:00.000Z"),
    ];

    const blocks = buildActivityTimeline(sessions, events, "twitch");

    expect(blocks.map((block) => block.type)).toEqual(["session", "session", "outside", "earlier"]);
    const [open, past, outside, earlier] = blocks;
    expect(open).toMatchObject({ type: "session", open: true, summary: { id: "open" } });
    expect(open!.rewards.map((row) => row.id)).toEqual(["in-open"]);
    expect(open!.status.map((row) => row.id)).toEqual(["status-open"]);
    expect(past).toMatchObject({ type: "session", open: false });
    expect(past!.rewards.map((row) => row.id)).toEqual(["in-past"]);
    expect(outside!.rewards.map((row) => row.id)).toEqual(["outside"]);
    expect(earlier!.rewards.map((row) => row.id)).toEqual(["legacy"]);
  });

  it("files a platformless row under the session open when it happened", () => {
    const sessions = [summary("open", "2026-10-30T10:00:00.000Z")];
    const blocks = buildActivityTimeline(
      sessions,
      [interruption("global", "2026-10-30T10:15:00.000Z")],
      "twitch",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.status.map((row) => row.id)).toEqual(["global"]);
  });

  it("leaves out a closed session with nothing in it", () => {
    const blocks = buildActivityTimeline(
      [summary("empty", "2026-10-29T18:00:00.000Z", "2026-10-29T18:01:00.000Z")],
      [],
      "twitch",
    );
    expect(blocks).toEqual([]);
  });
});

describe("reward views", () => {
  it("shows a drop with its art, the game's box art and where it came from", () => {
    expect(buildRewardView(drop("d", "2026-10-30T11:00:00.000Z", "s"), t)).toMatchObject({
      layout: "drop",
      title: "Golden Pickaxe",
      imageUrl: "https://static-cdn.jtvnw.net/reward.png",
      overlayImageUrl: "https://static-cdn.jtvnw.net/rust.jpg",
      subtitle: "Rust · Season 12 Drops · shroud",
      linkUrl: "https://www.twitch.tv/drops/campaigns",
    });
  });

  it("shows a Kick card in portrait with its rarity and consolation", () => {
    const view = buildRewardView(
      {
        id: "card",
        at: "2026-10-30T11:00:00.000Z",
        category: "activity",
        code: "reward_obtained",
        level: "info",
        platform: "kick",
        sessionId: "s",
        data: {
          kind: "challenge_card",
          source: { platform: "kick" },
          rarity: "legendary",
          imageUrl: "https://files.kick.com/cards/legendary.png",
          details: [
            { key: "recurrence", value: "daily" },
            { key: "consolationMinutes", value: 30 },
          ],
        },
      },
      t,
    );
    expect(view).toMatchObject({
      layout: "card",
      title: "rewardCardTitle:Legendary",
      imageUrl: "https://files.kick.com/cards/legendary.png",
      rarity: "legendary",
    });
    expect(view?.chips.map((chip) => chip.label)).toEqual([
      "Legendary",
      "daily",
      "rewardConsolationMinutes:30",
    ]);
  });

  it("shows an opened pack with its per-edition counts", () => {
    const view = buildRewardView(
      {
        id: "pack",
        at: "2026-10-30T11:00:00.000Z",
        category: "activity",
        code: "reward_obtained",
        level: "info",
        platform: "twitch",
        data: {
          kind: "extension_pack",
          source: { platform: "twitch", extension: "nopixel" },
          channel: "buddha",
          amount: 3,
          details: [
            { key: "edition_normal", value: 2 },
            { key: "edition_gold", value: 1 },
          ],
        },
      },
      t,
    );
    expect(view).toMatchObject({
      layout: "pack",
      title: "rewardPackTitle:3",
      subtitle: "NoPixelV · buddha",
    });
    expect(view?.chips.map((chip) => chip.label)).toEqual([
      "rewardEditionNormal:2",
      "rewardEditionGold:1",
    ]);
  });

  it("shows a kind it has no layout for through the generic row", () => {
    const view = buildRewardView(
      {
        id: "future",
        at: "2026-10-30T11:00:00.000Z",
        category: "activity",
        code: "reward_obtained",
        level: "info",
        platform: "twitch",
        data: {
          kind: "extension_trophy",
          source: { platform: "twitch", extension: "fortnite" },
          name: "Llama",
          details: [{ key: "tier", value: 2 }],
        },
      } as unknown as ActivityHistoryRecord,
      t,
    );
    expect(view).toMatchObject({ layout: "generic", title: "Llama", subtitle: "Fortnite" });
    expect(view?.chips.map((chip) => chip.label)).toEqual(["tier: 2"]);
  });

  it("is not a reward for status rows", () => {
    expect(buildRewardView(interruption("i", "2026-10-30T11:00:00.000Z"), t)).toBeUndefined();
  });
});
