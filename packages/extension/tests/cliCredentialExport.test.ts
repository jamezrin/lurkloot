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

  it("leaves the Kasada cookie out unless its optional host was granted", async () => {
    const getCookie = vi.fn(async (url: string) => url === "https://k.twitchcdn.net" ? "kasada-seed" : "value");

    const blob = await buildCliCredentialBlob(getCookie, async () => false);

    expect(blob.credentials.twitch).toEqual({ authToken: "value", deviceId: "value", kasadaSessionCookie: undefined });
    expect(blob.credentials.kick).toEqual({ sessionToken: "value" });
    expect(getCookie).not.toHaveBeenCalledWith("https://k.twitchcdn.net", "KP_UIDz-ssn");
  });
});
