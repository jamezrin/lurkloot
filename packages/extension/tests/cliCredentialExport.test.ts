import { describe, expect, it, vi } from "vitest";
import { buildCliCredentialBlob, KASADA_COOKIE_URL } from "../src/core/cliCredentialExport";

describe("CLI credential export", () => {
  it("reads Twitch's Kasada cookie from its exact host along with the login cookies", async () => {
    const cookies = new Map([
      ["https://www.twitch.tv|auth-token", "twitch-token"],
      ["https://www.twitch.tv|unique_id", "device-id"],
      [`${KASADA_COOKIE_URL}|KP_UIDz-ssn`, "kasada-seed"],
      ["https://kick.com|session_token", "kick-token"],
    ]);
    const getCookie = vi.fn(async (url: string, name: string) => cookies.get(`${url}|${name}`));

    await expect(buildCliCredentialBlob(getCookie)).resolves.toEqual({
      version: 1,
      credentials: {
        twitch: {
          authToken: "twitch-token",
          deviceId: "device-id",
          kasadaSessionCookie: "kasada-seed",
        },
        kick: { sessionToken: "kick-token" },
      },
    });
    expect(getCookie).toHaveBeenCalledWith(KASADA_COOKIE_URL, "KP_UIDz-ssn");
  });

  it("falls back to twitch.tv's partitioned jar for the third-party Kasada cookie", async () => {
    const getCookie = vi.fn(async (url: string, name: string, partitionedUnder?: string) =>
      url === KASADA_COOKIE_URL
        ? partitionedUnder === "https://twitch.tv"
          ? "partitioned-seed"
          : undefined
        : `${name}-value`,
    );

    const blob = await buildCliCredentialBlob(getCookie);

    expect(blob.credentials.twitch?.kasadaSessionCookie).toBe("partitioned-seed");
    expect(getCookie).toHaveBeenCalledWith(KASADA_COOKIE_URL, "KP_UIDz-ssn");
    expect(getCookie).toHaveBeenCalledWith(KASADA_COOKIE_URL, "KP_UIDz-ssn", "https://twitch.tv");
  });
});
