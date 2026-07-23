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
  invalidate(platform: Platform): Promise<void>;
  recheck(platform: Platform): Promise<void>;
  debounceMs?: number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
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

  const listener = (change: CredentialCookieChange) => {
    const platform = credentialPlatform(change);
    if (!platform) return;

    void deps.invalidate(platform).catch(() => undefined);
    const current = timers.get(platform);
    if (current !== undefined) clearTimer(current);
    timers.set(platform, setTimer(() => {
      timers.delete(platform);
      void deps.recheck(platform).catch(() => undefined);
    }, deps.debounceMs ?? 250));
  };

  deps.onChanged.addListener(listener);

  return () => {
    deps.onChanged.removeListener(listener);
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  };
}
