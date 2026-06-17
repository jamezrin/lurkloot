import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCredentials, readCredentialBlob } from "../src/auth/importCredentials";
import { loadCredentials } from "../src/authStore";
import { pollForToken } from "../src/auth/twitchDeviceFlow";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lurkloot-login-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("importCredentials", () => {
  it("round-trips an extension export through the auth store", async () => {
    const blob = join(dir, "export.json");
    await writeFile(blob, JSON.stringify({ version: 1, credentials: { twitch: { authToken: "tw" }, kick: { sessionToken: "kk" } } }));
    importCredentials(dir, blob);
    const creds = loadCredentials(dir, {});
    expect(creds.twitch?.authToken).toBe("tw");
    expect(creds.kick?.sessionToken).toBe("kk");
  });

  it("accepts a bare { twitch, kick } blob too", async () => {
    const blob = join(dir, "bare.json");
    await writeFile(blob, JSON.stringify({ twitch: { authToken: "bare-tw" } }));
    expect(readCredentialBlob(blob).twitch?.authToken).toBe("bare-tw");
  });

  it("rejects a blob with no usable credential", async () => {
    const blob = join(dir, "empty.json");
    await writeFile(blob, JSON.stringify({ credentials: {} }));
    expect(() => readCredentialBlob(blob)).toThrow(/no Twitch auth token or Kick session token/);
  });
});

describe("twitch device-flow polling", () => {
  it("returns the access token once the user authorizes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ message: "authorization_pending" }) })
      .mockResolvedValueOnce({ json: async () => ({ access_token: "device-token" }) });
    vi.stubGlobal("fetch", fetchMock);
    const token = await pollForToken("dev-code", 1, 60, "client", async () => {});
    expect(token).toBe("device-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a hard authorization error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ message: "invalid device code" }) }));
    await expect(pollForToken("dev-code", 1, 60, "client", async () => {})).rejects.toThrow(/invalid device code/);
  });
});
