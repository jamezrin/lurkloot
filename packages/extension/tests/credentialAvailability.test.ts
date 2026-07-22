import { describe, expect, it, vi } from "vitest";
import { createCredentialAvailabilityProvider } from "../src/core/credentialAvailability";

describe("credential availability", () => {
  it.each([
    ["twitch", "https://www.twitch.tv", "auth-token"],
    ["kick", "https://kick.com", "session_token"],
  ] as const)("reports %s credentials without returning their value", async (platform, url, name) => {
    const get = vi.fn(async () => ({ value: "credential-secret" }));
    const check = createCredentialAvailabilityProvider({ get });

    const result = await check(platform);

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith({ url, name });
    expect(result).toEqual({ status: "available" });
    expect(JSON.stringify(result)).not.toContain("credential-secret");
  });

  it.each([null, { value: "" }, {}])("reports a missing required cookie for %j", async (cookie) => {
    const check = createCredentialAvailabilityProvider({ get: vi.fn(async () => cookie) });

    await expect(check("twitch")).resolves.toEqual({ status: "missing" });
  });

  it("reports lookup failure without exposing the rejected error", async () => {
    const check = createCredentialAvailabilityProvider({
      get: vi.fn(async () => {
        throw new Error("credential-secret");
      }),
    });

    const result = await check("kick");

    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("credential-secret");
  });

  it("does not use Twitch unique_id as proof of login", async () => {
    const get = vi.fn(async () => null);
    const check = createCredentialAvailabilityProvider({ get });

    await expect(check("twitch")).resolves.toEqual({ status: "missing" });
    expect(get).toHaveBeenCalledWith({ url: "https://www.twitch.tv", name: "auth-token" });
    expect(get).not.toHaveBeenCalledWith(expect.objectContaining({ name: "unique_id" }));
  });
});
