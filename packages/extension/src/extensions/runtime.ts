import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import { validateTwitchExtensionReport } from "@lurkloot/core/extensions/reports";
import type { TwitchExtensionProviderId, TwitchExtensionReport } from "@lurkloot/shared/models";
import { withTwitchExtensionSession, type DriverSession, type SessionSource, type TwitchExtensionSessionOutcome } from "./session";

export interface TwitchExtensionDriver {
  stop(): void;
  refresh?(): Promise<void>;
}
export interface TwitchExtensionTarget { channelId: string; username?: string }
export type TwitchExtensionDriverFactory = (session: DriverSession, emit: (value: unknown) => void, channel?: { username: string }) => Promise<TwitchExtensionDriver>;

export function createTwitchExtensionRuntime(options: {
  source: SessionSource;
  contains(origin: string): Promise<boolean>;
  drivers: Partial<Record<TwitchExtensionProviderId, TwitchExtensionDriverFactory>>;
  report(provider: TwitchExtensionProviderId, report: TwitchExtensionReport): void;
  onViolation(provider: TwitchExtensionProviderId, diagnostic: string): void;
}) {
  interface Entry {
    channelId: string;
    abort: AbortController;
    driver?: TwitchExtensionDriver;
    expiresAt: number;
    nextRefreshAt: number;
    pending?: Promise<void>;
    expiryTimer?: ReturnType<typeof setTimeout>;
  }
  const entries = new Map<TwitchExtensionProviderId, Entry>();
  const quarantined = new Set<TwitchExtensionProviderId>();
  function dispose(entry: Entry) {
    if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
    entry.abort.abort();
    const driver = entry.driver;
    entry.driver = undefined;
    try { driver?.stop(); } catch { /* Vendor exceptions never leave this runtime. */ }
  }
  function stop(id?: TwitchExtensionProviderId) {
    for (const [provider, entry] of entries) {
      if (id && provider !== id) continue;
      entries.delete(provider);
      dispose(entry);
    }
  }
  function emit(id: TwitchExtensionProviderId, entry: Entry, value: unknown) {
    if (entries.get(id) !== entry || entry.abort.signal.aborted) return;
    const report = validateTwitchExtensionReport(value);
    if (!report) {
      quarantined.add(id);
      stop(id);
      options.onViolation(id, "Twitch Extension runtime stopped: invalid provider report.");
      return;
    }
    options.report(id, report);
    if (report.reasonCode === "auth-required" || report.reasonCode === "identity-required") dispose(entry);
  }
  function outcomeReport(outcome: TwitchExtensionSessionOutcome): TwitchExtensionReport | undefined {
    if (outcome === "ready" || outcome === "cancelled") return;
    const reasonCode = outcome === "expired" ? "auth-required" : outcome === "unavailable" ? "channel-ineligible" : outcome;
    return { status: outcome === "auth-required" || outcome === "expired" || outcome === "unavailable" ? "unavailable" : "error", reasonCode, progress: [], pending: [] };
  }
  async function update(selected: Partial<Record<TwitchExtensionProviderId, string | TwitchExtensionTarget>>): Promise<void> {
    const work: Promise<void>[] = [];
    for (const provider of twitchExtensionProviders) {
      const id = provider.id;
      const target = selected[id];
      const channelId = typeof target === "string" ? target : target?.channelId;
      const username = typeof target === "object" && typeof target.username === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(target.username) ? target.username : undefined;
      if (!channelId || !/^\d{1,20}$/.test(channelId)) {
        stop(id);
        // A disabled/re-enabled provider may retry after a protocol fix, but
        // never repeatedly restart a violating driver during the same selection.
        quarantined.delete(id);
        continue;
      }
      const factory = options.drivers[id];
      if (!factory || quarantined.has(id)) continue;
      let entry = entries.get(id);
      if (entry?.channelId !== channelId) { stop(id); entry = undefined; }
      if (entry?.pending) { work.push(entry.pending); continue; }
      const now = options.source.now();
      if (entry && now < entry.nextRefreshAt) continue;
      if (entry?.driver && entry.expiresAt > now + 60_000) {
        const active = entry;
        active.nextRefreshAt = now + provider.minRefreshIntervalMs;
        active.pending = (async () => {
          try { await active.driver?.refresh?.(); }
          catch {
            emit(id, active, { status: "error", reasonCode: "provider-error", progress: [], pending: [] });
            dispose(active);

          } finally { active.pending = undefined; }
        })();
        work.push(active.pending);
        continue;
      }
      stop(id);
      const next: Entry = { channelId, abort: new AbortController(), expiresAt: 0, nextRefreshAt: now + provider.minRefreshIntervalMs };
      entries.set(id, next);
      next.pending = (async () => {
        try {
          const granted = await options.contains(provider.backendOrigin);
          if (next.abort.signal.aborted || entries.get(id) !== next) return;
          if (!granted) {
            emit(id, next, { status: "unavailable", reasonCode: "permission-required", progress: [], pending: [] });
            return;
          }
          const outcome = await withTwitchExtensionSession(options.source, provider, channelId, async (session) => {
            next.expiresAt = session.expiresAt;
            next.expiryTimer = setTimeout(() => {
              if (entries.get(id) !== next) return;
              emit(id, next, { status: "unavailable", reasonCode: "auth-required", progress: [], pending: [] });
              stop(id);
            }, Math.min(2_147_483_647, Math.max(0, session.expiresAt - options.source.now())));
            const driver = await factory(session, (value) => emit(id, next, value), username ? { username } : undefined);
            next.driver = driver;
            if (next.abort.signal.aborted || entries.get(id) !== next) dispose(next);
          }, next.abort.signal);
          const report = outcomeReport(outcome);
          if (report) { emit(id, next, report); dispose(next); }
        } catch {
          emit(id, next, { status: "error", reasonCode: "transport-error", progress: [], pending: [] });
          dispose(next);
        } finally { next.pending = undefined; }
      })();
      work.push(next.pending);
    }
    await Promise.all(work);
  }
  return { update, stop };
}
