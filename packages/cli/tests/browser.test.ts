import { describe, expect, it } from "vitest";
import { integrityFromRequestHeaders } from "../src/transport/browser";

describe("integrityFromRequestHeaders (Twitch integrity capture)", () => {
  it("builds a TwitchIntegrity from a captured gql request's headers", () => {
    const integrity = integrityFromRequestHeaders({
      "client-integrity": "v4.public.integrity-token",
      "x-device-id": "device-123",
      "client-session-id": "session-456",
      "content-type": "application/json",
    });
    expect(integrity?.integrity).toBe("v4.public.integrity-token");
    expect(integrity?.deviceId).toBe("device-123");
    expect(integrity?.clientSessionId).toBe("session-456");
  });

  it("returns undefined when no client-integrity header is present", () => {
    expect(integrityFromRequestHeaders({ "content-type": "application/json" })).toBeUndefined();
  });
});
