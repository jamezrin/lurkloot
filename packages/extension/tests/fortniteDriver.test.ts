import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../src/extensions/fortnite/socket", () => ({ connectFortniteSocket: mock.connect }));
import { createFortniteDriver } from "../src/extensions/fortnite/driver";
const row = (type: string, state: unknown, key = type, version = 1) => ({ type, key, version, state });
const phase = { phaseId: "phase", startsAt: 0, endInteractiveAt: 90000, endsAt: 100000, rewardThreshold: 2, participationRewardId: "p", completionRewardId: "c" };
let push: (value: { type: string; payload: unknown }) => void;
let disconnect: () => void;
let command: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const session = () => ({ jwt: "private-session", expiresAt: 200000, identityLinked: true, channelId: "123", version: "1.1.2", signal: new AbortController().signal });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1000); mock.connect.mockReset();
  command = vi.fn(async (type: string) => {
    const states: Record<string, unknown[]> = {
      "campaign.get": [row("epic.campaign", { state: "ACTIVE" })], "competition.get": [],
      "competitionPhase.getAll": [row("epic.competitionphase", phase)],
      "participant.get": [row("epic.twitch.participant", { epicAccountId: "private-account", isComplete: false })],
      "reward.list": [], "collectablesChannel.get": [],
      "collectable.listForPhase": [row("epic.twitch.collectable", { id: "sprite", phaseId: "phase" })],
      "collectablesChannel.getPhase": [row("epic.twitch.collectableschannelphase", { phaseId: "phase", currentCollectableId: "sprite", nextDropAt: 46000 })],
      "participant.getParticipantPhase": [row("epic.twitch.participantphase", { phaseId: "phase", collectables: {} })],
    };
    return states[type] ? { states: states[type] } : {};
  });
  close = vi.fn();
  mock.connect.mockImplementation(async (options) => {
    push = options.onPush;
    return { command, close, startPing: vi.fn(), serverNow: () => Date.now(), closed: new Promise<void>(resolve => { disconnect = resolve; }) };
  });
});
afterEach(() => vi.useRealTimers());
describe("Fortnite tabless earning driver", () => {
  it("authenticates, joins and captures once, then waits for server confirmation", async () => {
    const captured = vi.fn(); const emit = vi.fn();
    const driver = await createFortniteDriver({ createSocket: vi.fn(), onCaptured: captured, random: () => 0 })(session(), emit);
    expect(command.mock.calls.slice(0, 3)).toEqual([["service.hello"], ["twitchAccount.authenticate", { jwt: "private-session" }], ["twitchChannel.join", { channelTwitchUserId: "123" }]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(command).toHaveBeenCalledWith("participant.submitCapture", { collectableId: "sprite" });
    expect(captured).not.toHaveBeenCalled();
    await driver.refresh?.(); await vi.advanceTimersByTimeAsync(2000);
    expect(command.mock.calls.filter(call => call[0] === "participant.submitCapture")).toHaveLength(1);
    push({ type: "state.change", payload: row("epic.twitch.participantphase", { phaseId: "phase", collectables: { sprite: 1 } }, "epic.twitch.participantphase", 2) });
    expect(captured).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
    driver.stop(); await vi.advanceTimersByTimeAsync(60000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(command.mock.calls.some(call => call[0] === "takeover.startTakeover" || call[0] === "takeover.checkTakeoverEligibility")).toBe(false);
  });
  it("repeats the full handshake on bounded reconnect without replaying an uncertain capture", async () => {
    const driver = await createFortniteDriver({ createSocket: vi.fn(), random: () => 0 })(session(), vi.fn());
    await vi.advanceTimersByTimeAsync(500); disconnect(); await vi.advanceTimersByTimeAsync(1500);
    expect(mock.connect).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.filter(call => call[0] === "twitchAccount.authenticate")).toHaveLength(2);
    expect(command.mock.calls.filter(call => call[0] === "participant.submitCapture")).toHaveLength(1);
    driver.stop();
  });
  it("consumes each authoritative count increment once after a sprite switch", async () => {
    const captured = vi.fn();
    const driver = await createFortniteDriver({ createSocket: vi.fn(), onCaptured: captured, random: () => 0 })(session(), vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    push({ type: "state.change", payload: row("epic.twitch.collectableschannelphase", { phaseId: "phase", currentCollectableId: "sprite", nextDropAt: 92000 }, "epic.twitch.collectableschannelphase", 2) });
    await vi.advanceTimersByTimeAsync(500);
    expect(command.mock.calls.filter(call => call[0] === "participant.submitCapture")).toHaveLength(2);
    push({ type: "state.change", payload: row("epic.twitch.collectableschannelphase", { phaseId: "phase", currentCollectableId: "unknown-sprite", nextDropAt: 138000 }, "epic.twitch.collectableschannelphase", 3) });
    push({ type: "state.change", payload: row("epic.twitch.participantphase", { phaseId: "phase", collectables: { sprite: 1 } }, "epic.twitch.participantphase", 2) });
    expect(captured).toHaveBeenCalledTimes(1);
    driver.stop();
  });
  it("starts an opted-in takeover only with server READY eligibility and confirms ownership", async () => {
    const base = command.getMockImplementation()! as (type: string, payload?: unknown) => Promise<unknown>;
    command.mockImplementation(async (type, payload) => {
      if (type === "takeover.checkTakeoverEligibility") return { streamer: true, state: "READY", cooldownUntil: 0, progress: 100 };
      if (type === "collectablesChannel.getPhase") return { states: [row("epic.twitch.collectableschannelphase", { phaseId: "phase", currentCollectableId: "sprite", nextDropAt: 46000, takeoverInfo: { allowedTakeover: true, active: false } })] };
      if (type === "takeover.get") return { states: [row("epic.takeover", { takeoverId: "takeover", fromTwitchUserId: "viewer", state: "IN_PROGRESS" })] };
      return base(type, payload);
    });
    let failedRead = false;
    const successful = command.getMockImplementation()! as (type: string, payload?: unknown) => Promise<unknown>;
    command.mockImplementation(async (type, payload) => { if (type === "takeover.get" && !failedRead) { failedRead = true; throw new Error("private transient"); } return successful(type, payload); });
    const onTakeoverStarted = vi.fn();
    const credential = `${btoa("{}")}.${btoa(JSON.stringify({ user_id: "viewer" }))}.signature`;
    const driver = await createFortniteDriver({ createSocket: vi.fn(), allowTakeovers: true, onTakeoverStarted })( { ...session(), jwt: credential }, vi.fn());
    expect(command).toHaveBeenCalledWith("takeover.startTakeover");
    expect(onTakeoverStarted).not.toHaveBeenCalled();
    push({ type: "state.change", payload: row("epic.twitch.collectableschannelphase", { phaseId: "phase", currentCollectableId: "sprite", nextDropAt: 46000, takeoverInfo: { allowedTakeover: true, active: true, takeoverId: "takeover" } }, "epic.twitch.collectableschannelphase", 2) });
    await vi.advanceTimersByTimeAsync(0);
    expect(onTakeoverStarted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTakeoverStarted).toHaveBeenCalledOnce();
    await driver.refresh?.();
    expect(command.mock.calls.filter(call => call[0] === "takeover.startTakeover")).toHaveLength(1);
    driver.stop();
  });
  it("cleans up rejected authorization and reports only a fixed reason", async () => {
    command.mockImplementation(async (type) => { if (type === "twitchAccount.authenticate") throw new Error("private vendor token"); return {}; });
    const emit = vi.fn();
    const driver = await createFortniteDriver({ createSocket: vi.fn() })(session(), emit);
    expect(emit).toHaveBeenCalledWith({ status: "error", reasonCode: "auth-required", progress: [], pending: [] });
    expect(close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000); expect(mock.connect).toHaveBeenCalledTimes(1);
    driver.stop();
  });
});
