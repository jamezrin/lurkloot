import type { TwitchExtensionReport } from "@lurkloot/shared/models";

interface Phase { phaseId: string; startsAt: number; endInteractiveAt: number; endsAt: number; rewardThreshold: number; participationRewardId: string; completionRewardId: string }
interface ParticipantPhase { phaseId: string; collectables: Record<string, number> }
interface ChannelPhase { takeoverInfo?: { active: boolean; allowedTakeover: boolean; takeoverId?: string }; phaseId: string; currentCollectableId?: string; nextDropAt: number }
const types = new Set(["epic.campaign", "epic.competitionphase", "epic.twitch.participant", "epic.twitch.participantphase", "epic.twitch.collectable", "epic.twitch.collectableschannelphase", "epic.clientreward"]);
function incompatible(): never { throw new Error("Fortnite state is incompatible."); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) incompatible(); return value as Record<string, unknown>; }
function id(value: unknown): string { if (typeof value !== "string" || value.length === 0 || value.length > 256) incompatible(); return value; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) incompatible(); return value; }
function counts(value: unknown): Record<string, number> {
  const entries = Object.entries(object(value));
  if (entries.length > 1000) incompatible();
  return Object.fromEntries(entries.map(([key, count]) => [id(key), number(count)]));
}
function parse(type: string, value: unknown): unknown {
  const data = object(value);
  switch (type) {
    case "epic.campaign": return { state: id(data.state) };
    case "epic.competitionphase": {
      const phase = { phaseId: id(data.phaseId), startsAt: number(data.startsAt), endInteractiveAt: number(data.endInteractiveAt), endsAt: number(data.endsAt), rewardThreshold: number(data.rewardThreshold), participationRewardId: id(data.participationRewardId), completionRewardId: id(data.completionRewardId) };
      if (phase.startsAt > phase.endInteractiveAt || phase.endInteractiveAt > phase.endsAt) incompatible();
      return phase;
    }
    case "epic.twitch.participant":
      if (typeof data.epicAccountId !== "string" || typeof data.isComplete !== "boolean") incompatible();
      return { linked: data.epicAccountId.length > 0, complete: data.isComplete };
    case "epic.twitch.participantphase": return { phaseId: id(data.phaseId), collectables: counts(data.collectables ?? {}) };
    case "epic.twitch.collectable": return { id: id(data.id), phaseId: id(data.phaseId) };
    case "epic.twitch.collectableschannelphase": {
      let takeoverInfo: ChannelPhase["takeoverInfo"];
      if (data.takeoverInfo != null) {
        const info = object(data.takeoverInfo);
        if (typeof info.active !== "boolean" || typeof info.allowedTakeover !== "boolean") incompatible();
        takeoverInfo = { active: info.active, allowedTakeover: info.allowedTakeover, ...(info.takeoverId ? { takeoverId: id(info.takeoverId) } : {}) };
      }
      return { ...(takeoverInfo ? { takeoverInfo } : {}), phaseId: id(data.phaseId), ...(data.currentCollectableId ? { currentCollectableId: id(data.currentCollectableId) } : {}), nextDropAt: number(data.nextDropAt ?? 0) };
    }
    case "epic.clientreward":
      if (data.earned !== undefined && typeof data.earned !== "boolean") incompatible();
      return { rewardId: id(data.rewardId), earned: data.earned === true };
    default: incompatible();
  }
}

// Explicitly retain only earning fields. Session/account identifiers, vendor
// properties, images and unknown states never enter this browser-free model.
export function createFortniteState() {
  let entries = new Map<string, { type: string; version: number; value: unknown }>();
  function apply(envelope: unknown) {
    const states = object(envelope).states;
    if (!Array.isArray(states) || states.length > 1000) incompatible();
    const next = new Map(entries);
    for (const raw of states) {
      const row = object(raw);
      if (typeof row.type !== "string") incompatible();
      if (!types.has(row.type)) continue;
      const key = `${row.type}:${id(row.key)}`;
      const version = number(row.version);
      if ((next.get(key)?.version ?? -1) >= version) continue;
      if (row.deleted !== undefined && typeof row.deleted !== "boolean") incompatible();
      next.set(key, { type: row.type, version, value: row.deleted ? undefined : parse(row.type, row.state) });
    }
    if (next.size > 4000) incompatible();
    entries = next;
  }
  function values<T>(type: string): T[] { return [...entries.values()].filter(entry => entry.type === type && entry.value !== undefined).map(entry => entry.value as T); }
  function context(now: number) {
    const phase = values<Phase>("epic.competitionphase").sort((a, b) => a.startsAt - b.startsAt).find(phase => phase.startsAt <= now && now < phase.endsAt);
    const participant = values<{ linked: boolean; complete: boolean }>("epic.twitch.participant")[0];
    const campaign = values<{ state: string }>("epic.campaign")[0];
    const captures = values<ParticipantPhase>("epic.twitch.participantphase").find(value => value.phaseId === phase?.phaseId);
    const channel = values<ChannelPhase>("epic.twitch.collectableschannelphase").find(value => value.phaseId === phase?.phaseId);
    const collectables = values<{ id: string; phaseId: string }>("epic.twitch.collectable").filter(value => value.phaseId === phase?.phaseId);
    const rewards = values<{ rewardId: string; earned: boolean }>("epic.clientreward");
    const earned = (rewardId: string | undefined) => Boolean(rewardId && rewards.some(reward => reward.rewardId === rewardId && reward.earned));
    return { phase, participant, campaign, captures, channel, collectables, participation: earned(phase?.participationRewardId), completion: earned(phase?.completionRewardId) };
  }
  function report(now: number): TwitchExtensionReport {
    const data = context(now);
    const { phase, participant, campaign, captures, collectables } = data;
    if (!participant) return { status: "connecting", reasonCode: "connecting", progress: [], pending: [] };
    if (!participant.linked) return { status: "unavailable", reasonCode: "identity-required", progress: [], pending: [{ key: "account-link", state: "blocked" }] };
    const progress: TwitchExtensionReport["progress"] = phase && captures && collectables.length ? [{ key: "phase-captures", earned: collectables.filter(item => (captures.collectables[item.id] ?? 0) > 0).length, required: collectables.length }] : [];
    const pending: TwitchExtensionReport["pending"] = phase ? [{ key: "participation", state: data.participation ? "done" : "open" }, { key: "completion", state: data.completion ? "done" : "open" }] : [];
    if (participant.complete || data.participation && data.completion) return { status: "complete", reasonCode: "rewards-complete", progress, pending };
    if (!phase || campaign?.state !== "ACTIVE" || now >= phase.endInteractiveAt) return { status: "unavailable", reasonCode: "phase-closed", progress, pending };
    return { status: "farming", reasonCode: "collecting", progress, pending };
  }
  function captureCandidate(now: number) {
    const data = context(now);
    const { phase, captures, channel, collectables } = data;
    if (report(now).status !== "farming" || !phase || !captures || !channel?.currentCollectableId || !collectables.some(item => item.id === channel.currentCollectableId)) return;
    return { phaseId: phase.phaseId, collectableId: channel.currentCollectableId, nextDropAt: channel.nextDropAt, count: captures.collectables[channel.currentCollectableId] ?? 0 };
  }
  function takeoverState(now: number) {
    const { phase, channel } = context(now);
    if (!phase || report(now).status !== "farming" || !channel?.takeoverInfo) return;
    return { phaseId: phase.phaseId, ...channel.takeoverInfo };
  }
  function captureCount(phaseId: string, collectableId: string) { return values<ParticipantPhase>("epic.twitch.participantphase").find(value => value.phaseId === phaseId)?.collectables[collectableId] ?? 0; }
  function activePhaseId(now: number) { return context(now).phase?.phaseId; }
  return { apply, report, captureCandidate, captureCount, takeoverState, activePhaseId };
}
