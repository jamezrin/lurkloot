import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_REQUEST_TIMEOUT_MS } from "@lurkloot/core/twitch/heartbeat";
import { twitchHeartbeatFetchText, twitchHeartbeatPost } from "../src/core/twitchHeartbeatTransport";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A request that never settles is what a DNS-blackholed host actually produces:
// it stalls on connect instead of failing. These run inside the platform state
// lock (runPlatformWatchHeartbeat holds it across watcher.tick), so "eventually
// rejects" is the property that keeps a blocked domain from head-blocking every
// tick queued behind it.
function stubHangingFetch(): void {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<never>(() => {})));
}

describe("Twitch heartbeat extension transport", () => {
  it("identifies destination-fetch failures without leaking URL details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("GET https://assets.twitch.tv/config/settings.secret.js?token=credential-value failed");
    }));
    const url = "https://assets.twitch.tv/config/settings.secret.js?token=do-not-log";

    const error = await twitchHeartbeatFetchText(url).catch((caught: unknown) => caught);

    expect(error).toEqual(new Error("Twitch Spade destination fetch failed for assets.twitch.tv: network request failed"));
    expect(String(error)).not.toMatch(/settings\.secret|do-not-log|credential-value/);
  });

  it("identifies heartbeat POST failures without leaking URL details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("POST https://spade.twitch.tv/track?token=credential-value failed");
    }));
    const url = "https://spade.twitch.tv/track?token=do-not-log";

    const error = await twitchHeartbeatPost(url, { method: "POST" }).catch((caught: unknown) => caught);

    expect(error).toEqual(new Error("Twitch Spade heartbeat POST failed for spade.twitch.tv: network request failed"));
    expect(String(error)).not.toMatch(/track|do-not-log|credential-value/);
  });

  it("reports non-success destination responses with hostname and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 403 })));

    await expect(twitchHeartbeatFetchText("https://assets.twitch.tv/config/settings.js"))
      .rejects.toThrow("Twitch Spade destination fetch failed for assets.twitch.tv: HTTP 403");
  });

  it("gives up on a stalled destination fetch instead of hanging", async () => {
    vi.useFakeTimers();
    stubHangingFetch();
    const pending = twitchHeartbeatFetchText("https://assets.twitch.tv/config/settings.js?token=do-not-log")
      .catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_REQUEST_TIMEOUT_MS);

    const error = await pending;
    expect(error).toEqual(new Error(
      `Twitch Spade destination fetch failed for assets.twitch.tv: Twitch heartbeat request timed out after ${HEARTBEAT_REQUEST_TIMEOUT_MS}ms`,
    ));
    expect(String(error)).not.toMatch(/do-not-log|settings\.js/);
  });

  it("gives up on a response whose body never arrives", async () => {
    vi.useFakeTimers();
    // Headers land, the body stalls. The timeout has to span the whole request,
    // not just the fetch: the timer is cleared the moment withHeartbeatTimeout
    // returns, so a body read outside it is unbounded again.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>(() => {}),
    })));
    const pending = twitchHeartbeatFetchText("https://assets.twitch.tv/config/settings.js")
      .catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_REQUEST_TIMEOUT_MS);

    expect(String(await pending)).toBe(
      `Error: Twitch Spade destination fetch failed for assets.twitch.tv: Twitch heartbeat request timed out after ${HEARTBEAT_REQUEST_TIMEOUT_MS}ms`,
    );
  });

  it("gives up on a stalled heartbeat POST and names the timeout as the cause", async () => {
    vi.useFakeTimers();
    stubHangingFetch();
    const pending = twitchHeartbeatPost("https://spade.twitch.tv/track?token=do-not-log", { method: "POST" })
      .catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_REQUEST_TIMEOUT_MS);

    const error = await pending;
    // The hostname plus "timed out" is what tells an AdGuard user their DNS
    // filter is the cause; a generic network error would not.
    expect(error).toEqual(new Error(
      `Twitch Spade heartbeat POST failed for spade.twitch.tv: Twitch heartbeat request timed out after ${HEARTBEAT_REQUEST_TIMEOUT_MS}ms`,
    ));
    expect(String(error)).not.toMatch(/track|do-not-log/);
  });

  it("does not report a caller-cancelled heartbeat as a timeout", async () => {
    stubHangingFetch();
    const caller = new AbortController();
    const pending = twitchHeartbeatPost("https://spade.twitch.tv/track", {
      method: "POST",
      signal: caller.signal,
    }).catch((caught: unknown) => caught);

    caller.abort(new Error("Twitch stopped"));

    // Stopping a platform must not be reported as the host timing out, or a
    // deliberate shutdown reads in diagnostics as a blocked spade.twitch.tv.
    const error = await pending;
    expect(String(error)).not.toMatch(/timed out/);
    expect(String(error)).toBe("Error: Twitch Spade heartbeat POST failed for spade.twitch.tv: network request failed");
  });
});
