import type { Platform } from "@lurkloot/shared/models";

export interface CredentialCookieChange {
  cookie: {
    name: string;
    domain: string;
    value: string;
    path: string;
    storeId: string;
    partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
  };
  removed: boolean;
  cause: string;
}

export interface CredentialCookieChangeEvent {
  addListener(listener: (change: CredentialCookieChange) => void): void;
  removeListener(listener: (change: CredentialCookieChange) => void): void;
}

type TimerHandle = number | ReturnType<typeof setTimeout>;

export interface CredentialObserverDeps {
  onChanged: CredentialCookieChangeEvent;
  invalidate(platform: Platform): Promise<void>;
  recheck(platform: Platform): Promise<void>;
  debounceMs?: number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

// The background owns the concrete controller, but credential changes must
// remain auth-only: changed credentials invalidate immediately, then run the
// controller's bounded platform-local health refresh after the debounce.
export interface CredentialHealthController {
  invalidateAuthHealth(platform: Platform): Promise<void>;
  checkAuthHealth(platform: Platform): Promise<void>;
}

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

export function createCredentialObserver(deps: CredentialObserverDeps): () => void {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const timers = new Map<Platform, TimerHandle>();
  // Chrome emits an overwrite removal followed by an explicit insertion even
  // when only the cookie's expiry changes. Compare just that pair: the old
  // value is kept transiently for at most the debounce window, never persisted
  // or reported. A worker restart simply falls back to treating the insertion
  // as a credential change.
  const overwrites = new Map<string, { value: string; timer: TimerHandle }>();

  function invalidateAndScheduleRecheck(platform: Platform): void {
    void deps.invalidate(platform).catch(() => undefined);
    const current = timers.get(platform);
    if (current !== undefined) clearTimer(current);
    timers.set(platform, setTimer(() => {
      timers.delete(platform);
      void deps.recheck(platform).catch(() => undefined);
    }, deps.debounceMs ?? 250));
  }

  const listener = (change: CredentialCookieChange) => {
    const platform = credentialPlatform(change);
    if (!platform) return;

    const cookie = change.cookie;
    const key = JSON.stringify([
      cookie.name, cookie.domain, cookie.path, cookie.storeId,
      cookie.partitionKey?.topLevelSite, cookie.partitionKey?.hasCrossSiteAncestor,
    ]);
    const overwritten = overwrites.get(key);
    if (overwritten) {
      clearTimer(overwritten.timer);
      overwrites.delete(key);
    }
    if (change.removed && change.cause === "overwrite") {
      const timer = setTimer(() => {
        overwrites.delete(key);
        // A missing replacement is a real removal. The pairing window already
        // debounced it; finish invalidation before probing the new session.
        void (async () => {
          await deps.invalidate(platform).catch(() => undefined);
          await deps.recheck(platform).catch(() => undefined);
        })();
      }, deps.debounceMs ?? 250);
      overwrites.set(key, { value: cookie.value, timer });
      return;
    }
    if (!change.removed && overwritten?.value === cookie.value) return;
    invalidateAndScheduleRecheck(platform);
  };

  deps.onChanged.addListener(listener);

  return () => {
    deps.onChanged.removeListener(listener);
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    for (const { timer } of overwrites.values()) clearTimer(timer);
    overwrites.clear();
  };
}

export function createCredentialHealthObserver(
  onChanged: CredentialCookieChangeEvent,
  controller: CredentialHealthController,
): () => void {
  return createCredentialObserver({
    onChanged,
    invalidate: (platform) => controller.invalidateAuthHealth(platform),
    recheck: (platform) => controller.checkAuthHealth(platform),
  });
}
