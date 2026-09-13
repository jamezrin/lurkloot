import { noPixelReport, parseNoPixelGiveaway, parseNoPixelProgress, parseNoPixelSetup } from "@lurkloot/core/extensions/nopixel/state";
import type { TwitchExtensionReasonCode } from "@lurkloot/shared/models";
import type { TwitchExtensionDriverFactory } from "../runtime";

const backend = "https://nopixel.streamingtoolsmith.com";
type NoPixelPath = "/ping" | "/channel/setup" | "/cards/rewards/daily-watchtime/progress" | "/channel/giveaway" | "/channel/giveaway/join";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
class ProviderFailure extends Error {
  constructor(readonly reason: TwitchExtensionReasonCode, readonly rejected = false) { super(reason); }
}

// Matches the published 1.1.2 client: Bearer auth, one initialization ping,
// channel setup, daily watchtime read and ordinary giveaway join/refetch. No
// pack opening or inventory modification is part of farming.
export function createNoPixelDriver(fetcher: Fetch, onJoined: () => void = () => {}, now: () => number = Date.now, diagnostic: (message: string) => void = () => {}): TwitchExtensionDriverFactory {
  return async (session, emit) => {
    const lifetime = new AbortController();
    let jwt = session.jwt;
    const expiresAt = session.expiresAt;
    const parent = session.signal;
    const abort = () => { jwt = ""; lifetime.abort(); };
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    const rejectedStatuses = new Map<string, number>();
    let joining = false;
    let pending: Promise<void> | undefined;
    const active = () => !lifetime.signal.aborted;
    function stop() { parent?.removeEventListener("abort", abort); rejectedStatuses.clear(); abort(); }
    async function request(path: NoPixelPath, method: "GET" | "POST" = "GET"): Promise<unknown> {
      if (!active()) throw new ProviderFailure("provider-error");
      if (now() >= expiresAt) throw new ProviderFailure("auth-required");
      const abortRequest = new AbortController();
      const cancel = () => abortRequest.abort();
      lifetime.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, Math.min(20_000, expiresAt - now()));
      try {
        const response = await fetcher(`${backend}${path}`, { method, headers: { Authorization: `Bearer ${jwt}` }, credentials: "omit", signal: abortRequest.signal });
        if (!active()) throw new ProviderFailure("provider-error");
        if (!response.ok) {
          const key = `${method} ${path}`;
          if (rejectedStatuses.get(key) !== response.status) {
            rejectedStatuses.set(key, response.status);
            diagnostic(`NoPixelV ${key} rejected: HTTP ${response.status}`);
          }
        }
        if (response.status === 401 || response.status === 403) throw new ProviderFailure("auth-required");
        if (!response.ok) throw new ProviderFailure("provider-error", true);
        if (response.status === 204) return null;
        const text = await response.text();
        if (text.length > 1_048_576) throw new ProviderFailure("compatibility-error");
        try { return JSON.parse(text); } catch { throw new ProviderFailure("compatibility-error"); }
      } finally {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", cancel);
      }
    }
    async function poll() {
      try {
        const setup = parseNoPixelSetup(await request("/channel/setup"));
        if (!active()) return;
        if (!setup) throw new ProviderFailure("compatibility-error");
        const progress = setup.watchtime && setup.connected ? parseNoPixelProgress(await request("/cards/rewards/daily-watchtime/progress")) : undefined;
        if (!active()) return;
        if (setup.watchtime && setup.connected && !progress) throw new ProviderFailure("compatibility-error");
        let giveaway = setup.giveaways ? parseNoPixelGiveaway(await request("/channel/giveaway")) : null;
        if (!active()) return;
        if (giveaway === undefined) throw new ProviderFailure("compatibility-error");
        if (!giveaway || giveaway.entered) joining = false;
        if (giveaway && !giveaway.entered && !joining) {
          // The published response need not contain a giveaway ID. Confirm
          // server-held membership rather than inventing a client dedup key.
          joining = true;
          try { await request("/channel/giveaway/join", "POST"); }
          catch (error) {
            // A definite HTTP rejection did not enter the giveaway. A timeout
            // is ambiguous, so retain the guard until server membership or a
            // fresh session resolves it rather than blindly resubmitting.
            if (error instanceof ProviderFailure && error.rejected) joining = false;
            throw error;
          }
          if (!active()) return;
          giveaway = parseNoPixelGiveaway(await request("/channel/giveaway"));
          if (!active()) return;
          if (giveaway === undefined) throw new ProviderFailure("compatibility-error");
          if (giveaway?.entered) { joining = false; onJoined(); }
        }
        emit(noPixelReport(setup, progress, giveaway));
      } catch (error) {
        if (active()) emit({ status: "error", reasonCode: error instanceof ProviderFailure ? error.reason : "transport-error", progress: [], pending: [] });
      }
    }
    function refresh(): Promise<void> {
      if (!active() || !session.identityLinked) return Promise.resolve();
      if (pending) return pending;
      pending = poll().finally(() => { pending = undefined; });
      return pending;
    }
    if (!session.identityLinked) {
      if (active()) emit({ status: "unavailable", reasonCode: "identity-required", progress: [], pending: [{ key: "account-link", state: "blocked" }] });
    } else {
      try {
        await request("/ping");
        await refresh();
      } catch (error) {
        if (active()) emit({ status: "error", reasonCode: error instanceof ProviderFailure ? error.reason : "transport-error", progress: [], pending: [] });
      }
    }
    return { stop, refresh };
  };
}
