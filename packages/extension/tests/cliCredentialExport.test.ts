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

    await expect(buildCliCredentialBlob(getCookie)).resolves.toEqual({
      version: 1,
      credentials: {
        twitch: { authToken: "twitch-token", deviceId: "device-id", kasadaSessionCookie: "kasada-seed" },
        kick: { sessionToken: "kick-token" },
      },
    });
    expect(getCookie).toHaveBeenCalledWith("https://k.twitchcdn.net", "KP_UIDz-ssn");
  });
});
