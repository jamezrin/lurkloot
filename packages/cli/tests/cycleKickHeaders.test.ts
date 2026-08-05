import { describe, expect, it } from "vitest";
import { KICK_BEARER_NEAR_MISS_CASES, KICK_BEARER_POSITIVE_CASES } from "@lurkloot/core/kickBearerCases";
import { kickHeaders } from "../src/transport/cycle";
import type { PlatformCredentials } from "../src/authStore";

const creds: PlatformCredentials = {
  twitch: {},
  kick: { sessionToken: "sess 789" },
};

describe("kickHeaders", () => {
  it.each(KICK_BEARER_POSITIVE_CASES)("attaches the session token to %s", (_case, url) => {
    expect(kickHeaders(url, undefined, creds).authorization).toBe("Bearer sess 789");
  });

  // This transport is the one copy that reaches Kick over wss, not just https —
  // the viewer WebSocket goes through this same header builder (see
  // createCycleKickWebSocketFactory in ../src/transport/cycle.ts).
  it("attaches the session token to websockets.kick.com over wss", () => {
    expect(kickHeaders("wss://websockets.kick.com/viewer", undefined, creds).authorization)
      .toBe("Bearer sess 789");
  });

  // Every case here is shared with tabs.test.ts (needsKickSessionBearer) and
  // pageFetchJson's own test, so all three copies of the predicate are pinned to
  // the same expectations. See packages/core/src/core/kickBearerCases.ts.
  it.each(KICK_BEARER_NEAR_MISS_CASES)("never attaches the session token to a %s", (_case, url) => {
    expect(kickHeaders(url, undefined, creds).authorization).toBeUndefined();
  });

  it("does not attach a token when none is stored", () => {
    expect(kickHeaders("https://kick.com/api/v1/user", undefined, { twitch: {}, kick: {} }).authorization)
      .toBeUndefined();
  });
});
