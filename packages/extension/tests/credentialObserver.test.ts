import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialHealthObserver,
  createCredentialObserver,
  type CredentialCookieChange,
  type CredentialCookieChangeEvent,
} from "../src/core/credentialObserver";
import type { Platform } from "@lurkloot/shared/models";
import { campaign, harness as controllerHarness } from "./helpers/backgroundController";

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
  cookie: { name, domain, value: "test-session", path: "/", storeId: "0" },
  removed,
  cause: "explicit",
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

  it.each([
    ["auth-token", ".twitch.tv"],
    ["session_token", ".kick.com"],
  ])("ignores an expiry-only rewrite of %s", async (name, domain) => {
    const env = harness();

    env.change({ ...change(name, domain, true), cause: "overwrite" });
    expect(env.invalidate).not.toHaveBeenCalled();
    env.change(change(name, domain));
    await vi.advanceTimersByTimeAsync(250);

    expect(env.invalidate).not.toHaveBeenCalled();
    expect(env.recheck).not.toHaveBeenCalled();
  });

  it("invalidates once when an overwrite changes the login credential", async () => {
    const env = harness();
    const original = change("auth-token", ".twitch.tv");

    env.change({ ...original, removed: true, cause: "overwrite" });
    expect(env.invalidate).not.toHaveBeenCalled();
    env.change({ ...original, cookie: { ...original.cookie, value: "new-test-session" } });

    expect(env.invalidate).toHaveBeenCalledExactlyOnceWith("twitch");
    await vi.advanceTimersByTimeAsync(250);
    expect(env.recheck).toHaveBeenCalledExactlyOnceWith("twitch");
    expect(JSON.stringify(env.invalidate.mock.calls)).not.toContain("test-session");
  });

  it("invalidates an overwrite removal whose replacement never arrives", async () => {
    const env = harness();

    env.change({ ...change("auth-token", ".twitch.tv", true), cause: "overwrite" });
    await vi.advanceTimersByTimeAsync(249);
    expect(env.invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(env.invalidate).toHaveBeenCalledExactlyOnceWith("twitch");
    expect(env.recheck).toHaveBeenCalledExactlyOnceWith("twitch");
  });

  it("keeps an already scheduled login recheck when an unchanged rewrite arrives", async () => {
    const env = harness();
    const original = change("auth-token", ".twitch.tv");
    env.change(original);

    env.change({ ...original, removed: true, cause: "overwrite" });
    env.change(original);
    await vi.advanceTimersByTimeAsync(250);

    expect(env.invalidate).toHaveBeenCalledOnce();
    expect(env.recheck).toHaveBeenCalledExactlyOnceWith("twitch");
  });

  it.each([
    { domain: "www.twitch.tv" },
    { path: "/other" },
    { storeId: "1" },
    { partitionKey: { topLevelSite: "https://example.com" } },
  ])("does not pair an overwrite with a different cookie scope %j", async (scope) => {
    const env = harness();
    const original = change("auth-token", ".twitch.tv");

    env.change({ ...original, removed: true, cause: "overwrite" });
    env.change({ ...original, cookie: { ...original.cookie, ...scope } });

    expect(env.invalidate).toHaveBeenCalledExactlyOnceWith("twitch");
    await vi.advanceTimersByTimeAsync(250);
    expect(env.invalidate).toHaveBeenCalledTimes(2);
  });

  it("cancels pending overwrite removals on disposal", async () => {
    const env = harness();
    env.change({ ...change("auth-token", ".twitch.tv", true), cause: "overwrite" });

    env.dispose();
    await vi.runAllTimersAsync();

    expect(env.invalidate).not.toHaveBeenCalled();
    expect(env.recheck).not.toHaveBeenCalled();
  });

  it("publishes Twitch campaigns when discovery rewrites the unchanged login cookie", async () => {
    const env = controllerHarness();
    let listener: ((event: CredentialCookieChange) => void) | undefined;
    const dispose = createCredentialHealthObserver({
      addListener(next) { listener = next; },
      removeListener() { listener = undefined; },
    }, env.controller);
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async (_session, options) => {
      listener?.({ ...change("auth-token", ".twitch.tv", true), cause: "overwrite" });
      listener?.(change("auth-token", ".twitch.tv"));
      options?.signal?.throwIfAborted();
      return [campaign("twitch")];
    });

    try {
      for (let refresh = 0; refresh < 2; refresh += 1) {
        await env.controller.tick(["twitch"]);
        await vi.advanceTimersByTimeAsync(250);

        expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["twitch-campaign"]);
        expect(env.state.sessions.twitch).toMatchObject({ status: "watching", campaignId: "twitch-campaign" });
        expect(env.state.authHealth.twitch.status).toBe("healthy");
      }
    } finally {
      dispose();
    }
  });

  it("uses bounded auth-only refreshes after independently debounced credential changes", async () => {
    let listener: ((event: CredentialCookieChange) => void) | undefined;
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

    const dispose = createCredentialHealthObserver(events, controller);
    listener?.(change("auth-token", "twitch.tv"));
    listener?.(change("session_token", "kick.com"));

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
