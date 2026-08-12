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

function kickCampaign(rewards: DropReward[], patch: Partial<DropCampaign> = {}): DropCampaign {
  return campaign(rewards, { ...patch, platform: "kick" });
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

  it("admits a Kick exact-fit reward observed ten seconds after launch", () => {
    const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const drop = reward({
      requiredMinutes: 2,
      watchedMinutes: 0,
      availableFrom: "2026-08-12T12:00:00.000Z",
      availableUntil: "2026-08-12T12:02:00.000Z",
    });

    expect(rewardFeasibility(kickCampaign([drop]), drop, true, 5, launchedAt + 10_000).kind).toBe("feasible");
  });

  it("admits timestamp rounding within five seconds", () => {
    const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const drop = reward({
      requiredMinutes: 2,
      watchedMinutes: 0,
      availableFrom: "2026-08-12T12:00:00.000Z",
      availableUntil: "2026-08-12T12:02:04.999Z",
    });

    expect(rewardFeasibility(kickCampaign([drop]), drop, true, 5, launchedAt + 10_000).kind).toBe("feasible");
  });

  it("rejects an exact-fit reward observed more than fifteen seconds after launch", () => {
    const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const drop = reward({
      requiredMinutes: 2,
      watchedMinutes: 0,
      availableFrom: "2026-08-12T12:00:00.000Z",
      availableUntil: "2026-08-12T12:02:00.000Z",
    });

    expect(rewardFeasibility(kickCampaign([drop]), drop, true, 5, launchedAt + 15_001).kind).toBe("insufficient_time");
  });

  it("rejects a raw deficit larger than elapsed launch time", () => {
    const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const drop = reward({
      requiredMinutes: 2,
      watchedMinutes: 0,
      availableFrom: "2026-08-12T12:00:00.000Z",
      availableUntil: "2026-08-12T12:01:55.000Z",
    });

    expect(rewardFeasibility(kickCampaign([drop]), drop, true, 5, launchedAt + 10_000).kind).toBe("insufficient_time");
  });

  it("keeps the configured margin for a Kick reward whose window is not exact-fit", () => {
    const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const drop = reward({
      requiredMinutes: 2,
      watchedMinutes: 0,
      availableFrom: "2026-08-12T12:00:00.000Z",
      availableUntil: "2026-08-12T12:03:00.000Z",
    });

    expect(rewardFeasibility(kickCampaign([drop]), drop, true, 5, launchedAt + 10_000)).toMatchObject({
      kind: "insufficient_time",
      marginMinutes: 5,
    });
  });

  it("does not apply the launch allowance to Twitch", () => {
    const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const drop = reward({
      requiredMinutes: 2,
      watchedMinutes: 0,
      availableFrom: "2026-08-12T12:00:00.000Z",
      availableUntil: "2026-08-12T12:02:00.000Z",
    });

    expect(rewardFeasibility(campaign([drop]), drop, true, 5, launchedAt + 10_000).kind).toBe("insufficient_time");
  });

  it("keeps skipUnfinishableRewards disabled behavior unchanged", () => {
    const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const drop = reward({
      requiredMinutes: 2,
      watchedMinutes: 0,
      availableFrom: "2026-08-12T12:00:00.000Z",
      availableUntil: "2026-08-12T12:02:00.000Z",
    });

    expect(rewardFeasibility(kickCampaign([drop]), drop, false, 42, launchedAt + 10_000)).toEqual({ kind: "disabled" });
  });
});
