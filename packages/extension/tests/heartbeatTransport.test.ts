import { afterEach, describe, expect, it, vi } from "vitest";
import { twitchHeartbeatFetchText, twitchHeartbeatPost } from "../src/core/twitchHeartbeatTransport";

afterEach(() => vi.unstubAllGlobals());

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
});
