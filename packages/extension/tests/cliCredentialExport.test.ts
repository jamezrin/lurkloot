import { describe, expect, it, vi } from "vitest";
import { buildCliCredentialBlob } from "../src/core/cliCredentialExport";

describe("CLI credential export", () => {
  it("reads Twitch's Kasada cookie from its exact host along with the login cookies", async () => {
    const cookies = new Map([
      ["https://www.twitch.tv|auth-token", "twitch-token"],
      ["https://www.twitch.tv|unique_id", "device-id"],
      ["https://k.twitchcdn.net|KP_UIDz-ssn", "kasada-seed"],
      ["https://kick.com|session_token", "kick-token"],
    ]);
    const getCookie = vi.fn(async (url: string, name: string) => cookies.get(`${url}|${name}`));

    await expect(buildCliCredentialBlob(getCookie, async () => true)).resolves.toEqual({
      version: 1,
      credentials: {
        twitch: { authToken: "twitch-token", deviceId: "device-id", kasadaSessionCookie: "kasada-seed" },
        kick: { sessionToken: "kick-token" },
      },
    });
    expect(getCookie).toHaveBeenCalledWith("https://k.twitchcdn.net", "KP_UIDz-ssn");
  });

  it("falls back to twitch.tv's partitioned jar for the third-party Kasada cookie", async () => {
    const getCookie = vi.fn(async (url: string, name: string, partitionedUnder?: string) =>
      url === "https://k.twitchcdn.net" ? (partitionedUnder === "https://twitch.tv" ? "partitioned-seed" : undefined) : `${name}-value`);

    const blob = await buildCliCredentialBlob(getCookie, async () => true);

    expect(blob.credentials.twitch?.kasadaSessionCookie).toBe("partitioned-seed");
    expect(getCookie).toHaveBeenCalledWith("https://k.twitchcdn.net", "KP_UIDz-ssn");
    expect(getCookie).toHaveBeenCalledWith("https://k.twitchcdn.net", "KP_UIDz-ssn", "https://twitch.tv");
  });

  it("leaves the Kasada cookie out unless its optional host was granted", async () => {
    const getCookie = vi.fn(async (url: string) => url === "https://k.twitchcdn.net" ? "kasada-seed" : "value");

    const blob = await buildCliCredentialBlob(getCookie, async () => false);

    expect(blob.credentials.twitch).toEqual({ authToken: "value", deviceId: "value", kasadaSessionCookie: undefined });
    expect(blob.credentials.kick).toEqual({ sessionToken: "value" });
    expect(getCookie.mock.calls.some(([url]) => url === "https://k.twitchcdn.net")).toBe(false);
  });
});
