import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import { rewardFeasibility } from "@lurkloot/shared/rewards";

const now = Date.parse("2026-07-19T12:00:00.000Z");

function reward(patch: Partial<DropReward> = {}): DropReward {
  return {
    id: "reward",
    name: "Reward",
    requiredMinutes: 60,
    watchedMinutes: 30,
    status: "in_progress",
    ...patch,
  };
}

function campaign(rewards: DropReward[], patch: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "campaign",
    platform: "twitch",
    name: "Campaign",
    status: "active",
    rewards,
    ...patch,
  };
}

describe("reward deadline feasibility", () => {
  it("allows exact equality and accounts for existing progress plus margin", () => {
    const drop = reward({ availableUntil: "2026-07-19T12:35:00.000Z" });
    expect(rewardFeasibility(campaign([drop]), drop, true, 5, now)).toEqual({
      kind: "feasible",
      deadline: "2026-07-19T12:35:00.000Z",
      remainingMinutes: 30,
      availableMilliseconds: 2_100_000,
      marginMinutes: 5,
    });
  });

  it("rejects a one-millisecond shortage", () => {
    const drop = reward({ availableUntil: "2026-07-19T12:34:59.999Z" });
    expect(rewardFeasibility(campaign([drop]), drop, true, 5, now)).toEqual({
      kind: "insufficient_time",
      deadline: "2026-07-19T12:34:59.999Z",
      remainingMinutes: 30,
      availableMilliseconds: 2_099_999,
      marginMinutes: 5,
    });
  });

  it("uses the earliest valid campaign or reward deadline", () => {
    const drop = reward({ availableUntil: "2026-07-19T13:00:00.000Z" });
    const result = rewardFeasibility(campaign([drop], { endsAt: "2026-07-19T12:29:00.000Z" }), drop, true, 0, now);
    expect(result).toMatchObject({ kind: "insufficient_time", deadline: "2026-07-19T12:29:00.000Z" });
  });

  it("keeps rewards farmable when deadlines are missing or invalid", () => {
    const drop = reward({ availableUntil: "not-a-date" });
    expect(rewardFeasibility(campaign([drop], { endsAt: "also-invalid" }), drop, true, 5, now)).toEqual({ kind: "unknown_deadline" });
  });

  it("supports disabling the rule independently of the preserved margin", () => {
    const drop = reward({ availableUntil: "2020-01-01T00:00:00.000Z" });
    expect(rewardFeasibility(campaign([drop]), drop, false, 42, now)).toEqual({ kind: "disabled" });
  });

  it("does not apply to claimed or non-watch rewards", () => {
    const claimed = reward({ status: "claimed", availableUntil: "2020-01-01T00:00:00.000Z" });
    const subscription = reward({ requirement: "subscription", requiredMinutes: 0, requiredSubs: 1, availableUntil: "2020-01-01T00:00:00.000Z" });
    expect(rewardFeasibility(campaign([claimed]), claimed, true, 5, now)).toEqual({ kind: "not_applicable" });
    expect(rewardFeasibility(campaign([subscription]), subscription, true, 5, now)).toEqual({ kind: "not_applicable" });
  });
});
