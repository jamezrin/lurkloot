import { describe, expect, it } from "vitest";
import { createFortniteState } from "@lurkloot/core/extensions/fortnite/state";
const state = (type: string, key: string, version: number, value: unknown) => ({ type, key, version, state: value });
const phase = { phaseId: "phase", startsAt: 1000, endInteractiveAt: 9000, endsAt: 10000, rewardThreshold: 2, participationRewardId: "participation", completionRewardId: "completion" };
function ready() {
  const model = createFortniteState();
  model.apply({ states: [state("epic.campaign", "campaign", 1, { state: "ACTIVE" }), state("epic.competitionphase", "phase", 1, phase), state("epic.twitch.participant", "viewer", 1, { epicAccountId: "private-account", isComplete: false }), state("epic.twitch.collectable", "sprite", 1, { id: "sprite", phaseId: "phase" }), state("epic.twitch.participantphase", "viewer-phase", 1, { phaseId: "phase", collectables: {}, channelCaptures: {} }), state("epic.twitch.collectableschannelphase", "channel-phase", 1, { phaseId: "phase", currentCollectableId: "sprite", nextDropAt: 6000 })] });
  return model;
}
describe("Fortnite authoritative state", () => {
  it("uses interactive windows and keeps private account fields out of reports", () => {
    const model = ready();
    expect(model.captureCandidate(5000)).toEqual({ phaseId: "phase", collectableId: "sprite", nextDropAt: 6000, count: 0 });
    expect(model.captureCandidate(9000)).toBeUndefined();
    expect(model.report(5000)).toMatchObject({ status: "farming", reasonCode: "collecting", progress: [{ key: "phase-captures", earned: 0, required: 1 }] });
    expect(JSON.stringify(model.report(5000))).not.toContain("private-account");
  });
  it("ignores stale pushes and confirms capture using participant state", () => {
    const model = ready();
    model.apply({ states: [state("epic.twitch.participantphase", "viewer-phase", 3, { phaseId: "phase", collectables: { sprite: 1 }, channelCaptures: {} })] });
    model.apply({ states: [state("epic.twitch.participantphase", "viewer-phase", 2, { phaseId: "phase", collectables: {}, channelCaptures: {} })] });
    expect(model.captureCandidate(5000)?.count).toBe(1);
    expect(model.report(5000).progress[0]).toEqual({ key: "phase-captures", earned: 1, required: 1 });
    expect(model.report(5000).status).toBe("farming"); // Collection is not reward confirmation.
  });
  it("requires actual earned rewards for completion", () => {
    const model = ready();
    model.apply({ states: [state("epic.clientreward", "participation", 1, { rewardId: "participation", earned: true }), state("epic.clientreward", "completion", 1, { rewardId: "completion", earned: true })] });
    expect(model.report(5000)).toMatchObject({ status: "complete", reasonCode: "rewards-complete" });
    expect(model.captureCandidate(5000)).toBeUndefined();
  });
  it("fails atomically on incompatible state and bounds envelopes", () => {
    const model = ready();
    expect(() => model.apply({ states: [state("epic.campaign", "campaign", 2, { state: "FINISHED" }), state("epic.competitionphase", "bad", 1, { ...phase, endsAt: NaN })] })).toThrow("Fortnite state is incompatible.");
    expect(model.report(5000).status).toBe("farming");
    expect(() => model.apply({ states: Array(1001).fill(state("unknown", "key", 1, {})) })).toThrow();
  });
  it("blocks earning without a linked account and ignores unknown state types", () => {
    const model = ready();
    model.apply({ states: [state("epic.twitch.participant", "viewer", 2, { epicAccountId: "", isComplete: false }), state("unknown", "key", 1, { token: "never retained" })] });
    expect(model.report(5000)).toMatchObject({ status: "unavailable", reasonCode: "identity-required" });
    expect(model.captureCandidate(5000)).toBeUndefined();
  });
});
