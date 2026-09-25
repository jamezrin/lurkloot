import { createFortniteState } from "@lurkloot/core/extensions/fortnite/state";
import type { TwitchExtensionReasonCode } from "@lurkloot/shared/models";
import type { TwitchExtensionDriverFactory } from "../runtime";
import { connectFortniteSocket } from "./socket";

type Connection = Awaited<ReturnType<typeof connectFortniteSocket>>;
export function createFortniteDriver(options: {
  createSocket: Parameters<typeof connectFortniteSocket>[0]["createSocket"];
  onCaptured?(): void;
  allowTakeovers?: boolean;
  onTakeoverStarted?(): void;
  random?(): number;
  now?(): number;
}): TwitchExtensionDriverFactory {
  return async (session, emit) => {
    const now = options.now ?? Date.now;
    const lifetime = new AbortController();
    let jwt = session.jwt;
    let viewerId = "";
    if (options.allowTakeovers) {
      try { const value = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).user_id; if (typeof value === "string" && value.length <= 256) viewerId = value; } catch { /* No raw credential errors leave the driver. */ }
    }
    let nextEligibilityAt = 0;
    const attemptedTakeovers = new Set<string>();
    const checkingTakeovers = new Set<string>();
    const takeoverRetries = new Map<string, number>();
    const takeoverTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const confirmedTakeovers = new Set<string>();
    let connection: Connection | undefined;
    let model = createFortniteState();
    let pending: Promise<void> | undefined;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    let readPhase: string | undefined;
    let initializing = false;
    let failed = false;
    // Preserve ambiguous attempts across reconnections. A new backend cadence
    // or authoritative count must resolve an attempt; an empty ACK cannot.
    const confirmations = new Map<string, number>();
    const attempts = new Map<string, { phaseId: string; collectableId: string; count: number; confirmed: boolean }>();
    const active = () => !lifetime.signal.aborted && now() < session.expiresAt;
    const abort = () => stop();
    session.signal?.addEventListener("abort", abort, { once: true });
    function stop() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(); jwt = ""; viewerId = "";
      session.signal?.removeEventListener("abort", abort);
      if (captureTimer !== undefined) clearTimeout(captureTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      captureTimer = undefined; retryTimer = undefined;
      const old = connection; connection = undefined; old?.close();
      attempts.clear(); confirmations.clear();
      for (const timer of takeoverTimers.values()) clearTimeout(timer);
      takeoverTimers.clear();
    }
    function reportFailure(reasonCode: TwitchExtensionReasonCode) {
      if (active()) emit({ status: "error", reasonCode, progress: [], pending: [] });
    }
    function attemptKey(candidate: NonNullable<ReturnType<typeof model.captureCandidate>>) { return `${candidate.phaseId}:${candidate.collectableId}:${candidate.nextDropAt}`; }
    function publish() {
      if (!active() || failed) return;
      const current = connection;
      const candidate = model.captureCandidate(current?.serverNow() ?? now());
      for (const attempt of attempts.values()) {
        const key = `${attempt.phaseId}:${attempt.collectableId}`;
        const watermark = Math.max(attempt.count, confirmations.get(key) ?? attempt.count);
        const authoritative = model.captureCount(attempt.phaseId, attempt.collectableId);
        if (!attempt.confirmed && authoritative > watermark) {
          attempt.confirmed = true;
          confirmations.set(key, watermark + 1);
          options.onCaptured?.();
        }
      }
      const report = model.report(current?.serverNow() ?? now());
      const takeover = model.takeoverState(current?.serverNow() ?? now());
      if (options.allowTakeovers && takeover) {
        report.pending.push({ key: "takeover", state: confirmedTakeovers.has(takeover.phaseId) ? "done" : takeover.allowedTakeover && !takeover.active ? "open" : "blocked" });
        if (current && takeover.active && takeover.takeoverId && attemptedTakeovers.has(takeover.phaseId) && !checkingTakeovers.has(takeover.takeoverId) && !takeoverTimers.has(takeover.takeoverId) && (takeoverRetries.get(takeover.takeoverId) ?? 0) < 3) {
          void confirmTakeover(current, takeover.phaseId, takeover.takeoverId);
        }
      }
      emit(report);
      if (captureTimer !== undefined) clearTimeout(captureTimer);
      captureTimer = undefined;
      if (initializing || !current || !candidate || attempts.has(attemptKey(candidate))) return;
      // Ordinary visible-client action, delayed slightly after observing the
      // current sprite. The vendor's nextDropAt identifies the server cadence;
      // it is not a license to submit arbitrary collectables on a fixed loop.
      const delay = 500 + Math.floor(Math.max(0, Math.min(1, options.random?.() ?? Math.random())) * 500);
      captureTimer = setTimeout(() => {
        captureTimer = undefined;
        if (!active() || failed || current !== connection) return;
        const fresh = model.captureCandidate(current.serverNow());
        if (!fresh || attemptKey(fresh) !== attemptKey(candidate) || attempts.has(attemptKey(fresh))) return;
        if (attempts.size >= 1000) { failed = true; reportFailure("compatibility-error"); current.close(); return; }
        attempts.set(attemptKey(fresh), { phaseId: fresh.phaseId, collectableId: fresh.collectableId, count: fresh.count, confirmed: false });
        void current.command("participant.submitCapture", { collectableId: fresh.collectableId }).catch(() => {
          if (active() && current === connection) reportFailure("provider-error");
        });
      }, delay);
    }
    function apply(value: unknown) {
      model.apply(value);
      publish();
    }
    async function confirmTakeover(current: Connection, phaseId: string, takeoverId: string) {
      if (takeoverRetries.size >= 64 && !takeoverRetries.has(takeoverId)) return;
      if (!active() || checkingTakeovers.has(takeoverId) || (takeoverRetries.get(takeoverId) ?? 0) >= 3) return;
      checkingTakeovers.add(takeoverId);
      takeoverRetries.set(takeoverId, (takeoverRetries.get(takeoverId) ?? 0) + 1);
      try {
        const value = await current.command("takeover.get", { takeoverId });
        if (!active() || current !== connection || confirmedTakeovers.has(phaseId)) return;
        const states = value && typeof value === "object" ? (value as { states?: unknown }).states : undefined;
        if (!Array.isArray(states) || states.length > 1000) return;
        const owned = states.some(row => {
          const state = row && typeof row === "object" ? row.state : undefined;
          return state && typeof state === "object" && state.takeoverId === takeoverId && state.fromTwitchUserId === viewerId && state.state === "IN_PROGRESS";
        });
        if (owned && viewerId) { confirmedTakeovers.add(phaseId); options.onTakeoverStarted?.(); publish(); }
      } catch { if (active()) reportFailure("provider-error"); }
      finally {
        checkingTakeovers.delete(takeoverId);
        if (active() && !confirmedTakeovers.has(phaseId) && (takeoverRetries.get(takeoverId) ?? 0) < 3) {
          takeoverTimers.set(takeoverId, setTimeout(() => {
            takeoverTimers.delete(takeoverId);
            if (active() && connection) void confirmTakeover(connection, phaseId, takeoverId);
          }, 10_000));
        }
      }
    }
    async function maybeTakeover(current: Connection) {
      const serverNow = current.serverNow(), target = model.takeoverState(serverNow);
      if (!options.allowTakeovers || !viewerId || !active() || !target?.allowedTakeover || target.active || attemptedTakeovers.has(target.phaseId) || serverNow < nextEligibilityAt) return;
      nextEligibilityAt = serverNow + 120_000;
      const eligibility = await current.command("takeover.checkTakeoverEligibility");
      if (!active() || current !== connection || !eligibility || typeof eligibility !== "object") return;
      const value = eligibility as Record<string, unknown>;
      const cooldown = value.cooldownUntil ?? 0;
      if (typeof cooldown !== "number" || !Number.isFinite(cooldown) || cooldown < 0) return;
      nextEligibilityAt = Math.max(nextEligibilityAt, cooldown);
      if (value.streamer !== true || value.state !== "READY" || cooldown > current.serverNow()) return;
      const fresh = model.takeoverState(current.serverNow());
      if (!fresh || fresh.phaseId !== target.phaseId || !fresh.allowedTakeover || fresh.active || attemptedTakeovers.size >= 64) return;
      // A timeout is ambiguous. Do not replay this phase's takeover on reconnect.
      attemptedTakeovers.add(fresh.phaseId);
      await current.command("takeover.startTakeover");
      publish();
    }
    async function read(current: Connection, type: string, payload?: Record<string, unknown>) {
      const value = await current.command(type, payload);
      if (!active() || current !== connection) return;
      apply(value);
    }
    async function phaseReads(current: Connection) {
      const phaseId = model.activePhaseId(current.serverNow());
      if (!phaseId) return;
      if (readPhase !== phaseId) {
        await read(current, "collectable.listForPhase", { phaseId });
        readPhase = phaseId;
      }
      await read(current, "collectablesChannel.getPhase", { phaseId });
      await read(current, "participant.getParticipantPhase", { phaseId });
    }
    function reconnect() {
      if (!active() || failed || retryTimer !== undefined) return;
      if (retryCount >= 10) { failed = true; reportFailure("transport-error"); return; }
      const delay = Math.min(60_000, 1000 * 3 ** retryCount++);
      retryTimer = setTimeout(() => { retryTimer = undefined; void initialize(); }, delay);
    }
    async function initialize() {
      if (!active() || failed || initializing) return;
      initializing = true;
      model = createFortniteState(); readPhase = undefined;
      let current: Connection | undefined;
      try {
        current = await connectFortniteSocket({ createSocket: options.createSocket, signal: lifetime.signal, now, onPush: push => {
          if (!active() || failed) return;
          try { apply(push.type === "state.change" ? { states: [push.payload] } : push.payload); }
          catch { failed = true; reportFailure("compatibility-error"); connection?.close(); }
        } });
        if (!active()) { current.close(); return; }
        connection = current;
        void current.closed.then(() => {
          if (current !== connection) return;
          connection = undefined;
          if (captureTimer !== undefined) clearTimeout(captureTimer);
          captureTimer = undefined;
          reconnect();
        });
        await current.command("service.hello");
        try { await current.command("twitchAccount.authenticate", { jwt }); }
        catch { failed = true; reportFailure("auth-required"); stop(); return; }
        await current.command("twitchChannel.join", { channelTwitchUserId: session.channelId });
        current.startPing();
        for (const type of ["campaign.get", "competition.get", "competitionPhase.getAll", "participant.get", "reward.list", "collectablesChannel.get"]) await read(current, type);
        await phaseReads(current);
        await maybeTakeover(current);
      } catch (error) {
        if (active() && !failed) {
          const reason = error instanceof Error && error.message === "Fortnite state is incompatible." ? "compatibility-error" : "transport-error";
          if (reason === "compatibility-error") failed = true;
          reportFailure(reason); current?.close(); reconnect();
        }
      } finally { initializing = false; publish(); }
    }
    async function poll() {
      const current = connection;
      if (!current || initializing || failed || !active()) return;
      try { await read(current, "reward.list"); await phaseReads(current); await maybeTakeover(current); }
      catch { if (active()) { reportFailure("transport-error"); current.close(); } }
    }
    function refresh() {
      if (pending) return pending;
      pending = poll().finally(() => { pending = undefined; });
      return pending;
    }
    if (session.signal?.aborted) stop();
    if (!session.identityLinked) {
      if (active()) emit({ status: "unavailable", reasonCode: "identity-required", progress: [], pending: [{ key: "account-link", state: "blocked" }] });
      stop();
    } else await initialize();
    return { stop, refresh };
  };
}
