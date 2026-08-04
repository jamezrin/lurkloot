import { describe, expect, it } from "vitest";
import { kickHeaders } from "../src/transport/cycle";
import type { PlatformCredentials } from "../src/authStore";

const creds: PlatformCredentials = {
  twitch: {},
  kick: { sessionToken: "sess 789" },
};

describe("kickHeaders", () => {
  it("attaches the session token to web.kick.com and websockets.kick.com", () => {
    expect(kickHeaders("https://web.kick.com/api/v1/drops/campaigns", undefined, creds).authorization)
      .toBe("Bearer sess 789");
    expect(kickHeaders("wss://websockets.kick.com/viewer", undefined, creds).authorization)
      .toBe("Bearer sess 789");
  });

  it("attaches the session token to the bare kick.com identity and followed-live endpoints", () => {
    expect(kickHeaders("https://kick.com/api/v1/user", undefined, creds).authorization)
      .toBe("Bearer sess 789");
    expect(kickHeaders("https://kick.com/api/v1/user/livestreams", undefined, creds).authorization)
      .toBe("Bearer sess 789");
  });

  it("does not attach the session token to the public kick.com channel API", () => {
    expect(kickHeaders("https://kick.com/api/v2/channels/someone", undefined, creds).authorization)
      .toBeUndefined();
  });

  // Every URL here is a near-miss for a genuinely authenticated endpoint: a
  // look-alike host or an unintended subpath. None may receive the token.
  it.each([
    ["look-alike host suffixing a Kick host", "https://web.kick.com.evil.example/api/v1/user"],
    ["subpath of the identity endpoint", "https://kick.com/api/v1/user/profile"],
  ])("never attaches the session token to a %s", (_case, url) => {
    expect(kickHeaders(url, undefined, creds).authorization).toBeUndefined();
  });

  it("does not attach a token when none is stored", () => {
    expect(kickHeaders("https://kick.com/api/v1/user", undefined, { twitch: {}, kick: {} }).authorization)
      .toBeUndefined();
  });
});
