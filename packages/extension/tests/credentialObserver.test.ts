import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialObserver, type CredentialCookieChange } from "../src/core/credentialObserver";

function harness() {
  let listener: ((change: CredentialCookieChange) => void) | undefined;
  const onChanged = {
    addListener: vi.fn((next: (change: CredentialCookieChange) => void) => {
      listener = next;
    }),
    removeListener: vi.fn(),
  };
  const invalidate = vi.fn(async () => undefined);
  const recheck = vi.fn(async () => undefined);
  const dispose = createCredentialObserver({ onChanged, invalidate, recheck, debounceMs: 250 });
  return {
    dispose,
    invalidate,
    onChanged,
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

describe("credential cookie observer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["login", change("auth-token", ".twitch.tv"), "twitch"],
    ["logout", change("session_token", "kick.com", true), "kick"],
    ["replacement", change("auth-token", "passport.twitch.tv"), "twitch"],
  ] as const)("invalidates the affected platform on %s", (_kind, event, platform) => {
    const env = harness();

    env.change(event);

    expect(env.invalidate).toHaveBeenCalledOnce();
    expect(env.invalidate).toHaveBeenCalledWith(platform);
    expect(JSON.stringify(env.invalidate.mock.calls)).not.toContain("secret");
  });

  it.each([
    change("unique_id", ".twitch.tv"),
    change("other", "kick.com"),
    change("auth-token", "example.com"),
    change("session_token", "notkick.com"),
  ])("ignores unrelated cookie change %j", async (event) => {
    const env = harness();

    env.change(event);
    await vi.runAllTimersAsync();

    expect(env.invalidate).not.toHaveBeenCalled();
    expect(env.recheck).not.toHaveBeenCalled();
  });

  it("coalesces repeated changes into one platform-only recheck", async () => {
    const env = harness();

    env.change(change("auth-token", ".twitch.tv"));
    env.change(change("auth-token", ".twitch.tv", true));
    env.change(change("auth-token", "www.twitch.tv"));

    expect(env.invalidate).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(249);
    expect(env.recheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(env.recheck).toHaveBeenCalledOnce();
    expect(env.recheck).toHaveBeenCalledWith("twitch");
  });

  it("debounces Twitch and Kick independently", async () => {
    const env = harness();

    env.change(change("auth-token", "twitch.tv"));
    env.change(change("session_token", ".kick.com"));
    await vi.advanceTimersByTimeAsync(250);

    expect(env.recheck).toHaveBeenCalledTimes(2);
    expect(env.recheck).toHaveBeenCalledWith("twitch");
    expect(env.recheck).toHaveBeenCalledWith("kick");
  });

  it("clears a valid zero-valued timer handle when coalescing", () => {
    let listener: ((event: CredentialCookieChange) => void) | undefined;
    const clearTimer = vi.fn();
    createCredentialObserver({
      onChanged: {
        addListener: (next) => {
          listener = next;
        },
        removeListener: vi.fn(),
      },
      invalidate: vi.fn(async () => undefined),
      recheck: vi.fn(async () => undefined),
      setTimer: vi.fn(() => 0),
      clearTimer,
    });

    listener?.(change("auth-token", "twitch.tv"));
    listener?.(change("auth-token", "twitch.tv"));

    expect(clearTimer).toHaveBeenCalledWith(0);
  });

  it("contains rejected invalidation and recheck callbacks", async () => {
    const env = harness();
    env.invalidate.mockRejectedValueOnce(new Error("invalidate failed"));
    env.recheck.mockRejectedValueOnce(new Error("recheck failed"));

    expect(() => env.change(change("session_token", "kick.com"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(250);
    expect(env.recheck).toHaveBeenCalledWith("kick");
  });

  it("removes its listener and cancels pending rechecks on disposal", async () => {
    const env = harness();
    env.change(change("auth-token", "twitch.tv"));

    env.dispose();
    await vi.runAllTimersAsync();

    expect(env.onChanged.removeListener).toHaveBeenCalledWith(env.listener);
    expect(env.recheck).not.toHaveBeenCalled();
  });
});
