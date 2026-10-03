import type { Platform } from "@lurkloot/shared/models";

export interface CredentialCookieChange {
  cookie: {
    name: string;
    domain: string;
  };
  removed: boolean;
}

export interface CredentialCookieChangeEvent {
  addListener(listener: (change: CredentialCookieChange) => void): void;
  removeListener(listener: (change: CredentialCookieChange) => void): void;
}

type TimerHandle = number | ReturnType<typeof setTimeout>;

export interface CredentialObserverDeps {
  onChanged: CredentialCookieChangeEvent;
  // The platform's effective credential: the same cookie lookup the transport
  // and the availability check make. Undefined when signed out.
  read(platform: Platform): Promise<string | undefined>;
  invalidate(platform: Platform): Promise<void>;
  recheck(platform: Platform): Promise<void>;
  debounceMs?: number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

// The background owns the concrete controller, but credential changes must
// remain auth-only: they invalidate immediately, then run the controller's
// bounded platform-local health refresh after the observer debounce.
export interface CredentialHealthController {
  invalidateAuthHealth(platform: Platform): Promise<void>;
  checkAuthHealth(platform: Platform): Promise<void>;
}

const CREDENTIAL_PLATFORMS: readonly Platform[] = ["twitch", "kick"];

function normalizedDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

function isDomainOrSubdomain(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

export function credentialPlatform(change: CredentialCookieChange): Platform | undefined {
  const domain = normalizedDomain(change.cookie.domain);
  if (change.cookie.name === "auth-token" && isDomainOrSubdomain(domain, "twitch.tv")) return "twitch";
  if (change.cookie.name === "session_token" && isDomainOrSubdomain(domain, "kick.com")) return "kick";
  return undefined;
}

// A cookie event only says the credential may have changed. Twitch's web
// client rewrites auth-token with the same value and a later expiry on every
// page load, including the page the extension opens to mint an integrity
// token, and browsers report that rewrite differently (Chrome's removal half
// carries the old value, Firefox's both carry the new one). Treated as a login
// change, each rewrite aborted the discovery in flight. So an event triggers a
// read of the credential the extension actually uses, and only a different
// value, signing in or signing out invalidates.
export function createCredentialObserver(deps: CredentialObserverDeps): () => void {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const timers = new Map<Platform, TimerHandle>();
  // The last credential read per platform. It lives only in this closure: it
  // is never persisted or reported.
  const known = new Map<Platform, string | undefined>();
  // One read per platform at a time; events during a read ask for one more.
  const checks = new Map<Platform, { rerun: boolean }>();
  let disposed = false;

  function invalidateAndScheduleRecheck(platform: Platform): void {
    void deps.invalidate(platform).catch(() => undefined);
    const current = timers.get(platform);
    if (current !== undefined) clearTimer(current);
    timers.set(platform, setTimer(() => {
      timers.delete(platform);
      void deps.recheck(platform).catch(() => undefined);
    }, deps.debounceMs ?? 250));
  }

  // The baseline read only records the value. A change that woke the worker
  // is already in it, which is safe: no work was in flight to abort, and the
  // first tick refreshes auth health.
  async function compare(platform: Platform, baseline: boolean): Promise<void> {
    let value: string | undefined;
    try {
      value = await deps.read(platform);
    } catch {
      // Unreadable: count it as a change, as every event counted before, and
      // let the next readable value become the baseline.
      if (disposed) return;
      known.delete(platform);
      if (!baseline) invalidateAndScheduleRecheck(platform);
      return;
    }
    if (disposed) return;
    const changed = !known.has(platform) || known.get(platform) !== value;
    known.set(platform, value);
    if (changed && !baseline) invalidateAndScheduleRecheck(platform);
  }

  function check(platform: Platform, baseline = false): void {
    const running = checks.get(platform);
    if (running) {
      running.rerun = true;
      return;
    }
    const state = { rerun: false };
    checks.set(platform, state);
    void (async () => {
      try {
        let first = baseline;
        do {
          state.rerun = false;
          await compare(platform, first);
          first = false;
        } while (state.rerun && !disposed);
      } finally {
        // In the same turn as the last rerun check, so no event falls between.
        checks.delete(platform);
      }
    })().catch(() => undefined);
  }

  const listener = (change: CredentialCookieChange) => {
    const platform = credentialPlatform(change);
    if (platform) check(platform);
  };

  deps.onChanged.addListener(listener);
  for (const platform of CREDENTIAL_PLATFORMS) check(platform, true);

  return () => {
    disposed = true;
    deps.onChanged.removeListener(listener);
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  };
}

export function createCredentialHealthObserver(
  onChanged: CredentialCookieChangeEvent,
  controller: CredentialHealthController,
  read: (platform: Platform) => Promise<string | undefined>,
): () => void {
  return createCredentialObserver({
    onChanged,
    read,
    invalidate: (platform) => controller.invalidateAuthHealth(platform),
    recheck: (platform) => controller.checkAuthHealth(platform),
  });
}
