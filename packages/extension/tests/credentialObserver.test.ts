import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialHealthObserver,
  createCredentialObserver,
  type CredentialCookieChange,
  type CredentialCookieChangeEvent,
} from "../src/core/credentialObserver";
import type { Platform } from "@lurkloot/shared/models";

// The browser's cookie jar as the observer reads it: one effective credential
// per platform.
type Credentials = Partial<Record<Platform, string>>;

function harness(initial: Credentials = {}, read?: (platform: Platform) => Promise<string | undefined>) {
  let listener: ((change: CredentialCookieChange) => void) | undefined;
  const credentials: Credentials = { ...initial };
  const onChanged = {
    addListener: vi.fn((next: (change: CredentialCookieChange) => void) => {
      listener = next;
    }),
    removeListener: vi.fn(),
  };
  const readCredential = vi.fn(read ?? (async (platform: Platform) => credentials[platform]));
  const invalidate = vi.fn(async () => undefined);
  const recheck = vi.fn(async () => undefined);
  const dispose = createCredentialObserver({ onChanged, read: readCredential, invalidate, recheck, debounceMs: 250 });
  return {
    credentials,
    dispose,
    invalidate,
    onChanged,
    read: readCredential,
    recheck,
    change(value: CredentialCookieChange) {
      if (!listener) throw new Error("observer listener was not registered");
      listener(value);
    },
    get listener() {
      return listener;
    },
  };
}

const change = (name: string, domain: string, removed = false): CredentialCookieChange => ({
  cookie: { name, domain },
  removed,
});

// What a browser reports for one write over an existing cookie.
const rewrite = (name = "auth-token", domain = ".twitch.tv"): CredentialCookieChange[] => [
  change(name, domain, true),
  change(name, domain),
];

// Reads are asynchronous, so a test lets them settle without passing the
// recheck debounce.
const flush = () => vi.advanceTimersByTimeAsync(0);

function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("credential cookie observer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["sign-in", "twitch", {}, { twitch: "token-a" }, change("auth-token", ".twitch.tv")],
    ["sign-out", "kick", { kick: "session-a" }, {}, change("session_token", "kick.com", true)],
    ["account switch", "twitch", { twitch: "token-a" }, { twitch: "token-b" }, change("auth-token", "passport.twitch.tv")],
  ] as const)("invalidates the affected platform on %s", async (_kind, platform, before, after, event) => {
    const env = harness(before);
    await flush();

    delete env.credentials[platform];
    Object.assign(env.credentials, after);
    env.change(event);
    await flush();

    expect(env.invalidate).toHaveBeenCalledOnce();
    expect(env.invalidate).toHaveBeenCalledWith(platform);
    expect(JSON.stringify(env.invalidate.mock.calls)).not.toContain("token-");
  });

  it("ignores a page rewriting the same credential with a later expiry", async () => {
    const env = harness({ twitch: "token-a" });
    await flush();

    for (const event of rewrite()) env.change(event);
    await flush();
    for (const event of rewrite()) env.change(event);
    await vi.runAllTimersAsync();

    expect(env.invalidate).not.toHaveBeenCalled();
    expect(env.recheck).not.toHaveBeenCalled();
  });

  it("invalidates once when both halves of a rewrite describe the new credential", async () => {
    // Firefox reports an overwrite as a removal and an insertion that both
    // carry the replacement cookie, so the events alone cannot tell a rewrite
    // from a different account.
    const env = harness({ twitch: "token-a" });
    await flush();

    env.credentials.twitch = "token-b";
    for (const event of rewrite()) env.change(event);
    await flush();

    expect(env.invalidate).toHaveBeenCalledOnce();
  });

  it("ignores a rewrite that leaves the credential the extension reads unchanged", async () => {
    // An auth-token on another twitch.tv host is not the one requests send.
    const env = harness({ twitch: "token-a" });
    await flush();

    for (const event of rewrite("auth-token", "passport.twitch.tv")) env.change(event);
    await flush();

    expect(env.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    change("unique_id", ".twitch.tv"),
    change("other", "kick.com"),
    change("auth-token", "example.com"),
    change("session_token", "notkick.com"),
  ])("does not read the credential for unrelated cookie change %j", async (event) => {
    const env = harness({ twitch: "token-a", kick: "session-a" });
    await flush();
    env.read.mockClear();

    env.change(event);
    await vi.runAllTimersAsync();

    expect(env.read).not.toHaveBeenCalled();
    expect(env.invalidate).not.toHaveBeenCalled();
    expect(env.recheck).not.toHaveBeenCalled();
  });

  it("reads once more for every burst of changes that arrives during a read", async () => {
    const env = harness({ twitch: "token-a" });
    await flush();
    const first = held<string | undefined>();
    env.read.mockImplementationOnce(() => first.promise);
    env.read.mockClear();

    env.credentials.twitch = "token-b";
    env.change(change("auth-token", ".twitch.tv"));
    env.change(change("auth-token", ".twitch.tv", true));
    env.change(change("auth-token", "www.twitch.tv"));
    first.release("token-b");
    await flush();

    expect(env.read).toHaveBeenCalledTimes(2);
    expect(env.invalidate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(249);
    expect(env.recheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(env.recheck).toHaveBeenCalledOnce();
    expect(env.recheck).toHaveBeenCalledWith("twitch");
  });

  it("compares a change during the startup read against that read", async () => {
    const baseline = held<string | undefined>();
    const env = harness({}, async (platform) => platform === "twitch" ? baseline.promise : undefined);

    env.read.mockImplementation(async (platform) => platform === "twitch" ? "token-a" : undefined);
    for (const event of rewrite()) env.change(event);
    baseline.release("token-a");
    await flush();

    expect(env.read.mock.calls.filter(([platform]) => platform === "twitch")).toHaveLength(2);
    expect(env.invalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate for a startup read that fails", async () => {
    const env = harness({}, async () => {
      throw new Error("cookies unavailable");
    });
    await flush();

    expect(env.invalidate).not.toHaveBeenCalled();
  });

  it("counts a change it cannot read as a credential change", async () => {
    const env = harness({ twitch: "token-a" });
    await flush();
    env.read.mockRejectedValueOnce(new Error("cookies unavailable"));

    env.change(change("auth-token", ".twitch.tv"));
    await flush();
    expect(env.invalidate).toHaveBeenCalledOnce();

    // The next readable value is then a new baseline, compared as a change.
    env.change(change("auth-token", ".twitch.tv"));
    await flush();
    env.change(change("auth-token", ".twitch.tv"));
    await flush();
    expect(env.invalidate).toHaveBeenCalledTimes(2);
  });

  it("debounces Twitch and Kick independently", async () => {
    const env = harness({ twitch: "token-a", kick: "session-a" });
    await flush();

    env.credentials.twitch = "token-b";
    env.credentials.kick = "session-b";
    env.change(change("auth-token", "twitch.tv"));
    env.change(change("session_token", ".kick.com"));
    await vi.advanceTimersByTimeAsync(250);

    expect(env.recheck).toHaveBeenCalledTimes(2);
    expect(env.recheck).toHaveBeenCalledWith("twitch");
    expect(env.recheck).toHaveBeenCalledWith("kick");
  });

  it("uses bounded auth-only refreshes after independently debounced credential changes", async () => {
    let listener: ((event: CredentialCookieChange) => void) | undefined;
    const credentials: Credentials = { twitch: "token-a", kick: "session-a" };
    const states = new Map<Platform, "checking" | "healthy" | "scheduler-ran">();
    const events: CredentialCookieChangeEvent = {
      addListener(next) {
        listener = next;
      },
      removeListener() {},
    };
    const controller = {
      async invalidateAuthHealth(platform: Platform) {
        states.set(platform, "checking");
      },
      async checkAuthHealth(platform: Platform) {
        states.set(platform, "healthy");
      },
      async tickAndHandOff(platforms: Platform[]) {
        for (const platform of platforms) states.set(platform, "scheduler-ran");
      },
    };

    const dispose = createCredentialHealthObserver(events, controller, async (platform) => credentials[platform]);
    await flush();
    credentials.twitch = "token-b";
    delete credentials.kick;
    listener?.(change("auth-token", "twitch.tv"));
    listener?.(change("session_token", "kick.com", true));
    await flush();

    expect(states).toEqual(new Map<Platform, "checking" | "healthy" | "scheduler-ran">([
      ["twitch", "checking"],
      ["kick", "checking"],
    ]));

    await vi.advanceTimersByTimeAsync(250);

    expect(states).toEqual(new Map<Platform, "checking" | "healthy" | "scheduler-ran">([
      ["twitch", "healthy"],
      ["kick", "healthy"],
    ]));
    dispose();
  });

  it("clears a valid zero-valued timer handle when coalescing", async () => {
    let listener: ((event: CredentialCookieChange) => void) | undefined;
    const credentials: Credentials = { twitch: "token-a" };
    const clearTimer = vi.fn();
    createCredentialObserver({
      onChanged: {
        addListener: (next) => {
          listener = next;
        },
        removeListener: vi.fn(),
      },
      read: async (platform) => credentials[platform],
      invalidate: vi.fn(async () => undefined),
      recheck: vi.fn(async () => undefined),
      setTimer: vi.fn(() => 0),
      clearTimer,
    });
    await flush();

    credentials.twitch = "token-b";
    listener?.(change("auth-token", "twitch.tv"));
    await flush();
    credentials.twitch = "token-c";
    listener?.(change("auth-token", "twitch.tv"));
    await flush();

    expect(clearTimer).toHaveBeenCalledWith(0);
  });

  it("contains rejected invalidation and recheck callbacks", async () => {
    const env = harness({ kick: "session-a" });
    await flush();
    env.invalidate.mockRejectedValueOnce(new Error("invalidate failed"));
    env.recheck.mockRejectedValueOnce(new Error("recheck failed"));

    delete env.credentials.kick;
    expect(() => env.change(change("session_token", "kick.com", true))).not.toThrow();
    await vi.advanceTimersByTimeAsync(250);
    expect(env.recheck).toHaveBeenCalledWith("kick");
  });

  it("keeps checking after an invalidation throws synchronously", async () => {
    const env = harness({ twitch: "token-a" });
    await flush();
    env.invalidate.mockImplementationOnce(() => {
      throw new Error("invalidate threw");
    });

    env.credentials.twitch = "token-b";
    env.change(change("auth-token", ".twitch.tv"));
    await flush();
    env.credentials.twitch = "token-c";
    env.change(change("auth-token", ".twitch.tv"));
    await flush();

    expect(env.invalidate).toHaveBeenCalledTimes(2);
  });

  it("removes its listener and cancels pending rechecks on disposal", async () => {
    const env = harness({ twitch: "token-a" });
    await flush();
    env.credentials.twitch = "token-b";
    env.change(change("auth-token", "twitch.tv"));
    await flush();

    env.dispose();
    await vi.runAllTimersAsync();

    expect(env.onChanged.removeListener).toHaveBeenCalledWith(env.listener);
    expect(env.recheck).not.toHaveBeenCalled();
  });

  it("drops a read that finishes after disposal", async () => {
    const env = harness({ twitch: "token-a" });
    await flush();
    const pending = held<string | undefined>();
    env.read.mockImplementationOnce(() => pending.promise);

    env.change(change("auth-token", ".twitch.tv"));
    env.dispose();
    pending.release("token-b");
    await vi.runAllTimersAsync();

    expect(env.invalidate).not.toHaveBeenCalled();
  });
});
