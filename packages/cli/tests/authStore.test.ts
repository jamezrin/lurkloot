import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetCredentials, hasKickAuth, hasTwitchAuth, loadCredentials } from "../src/authStore";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lurkloot-auth-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("loadCredentials", () => {
  it("returns empty credentials when there is no store and no env", () => {
    const creds = loadCredentials(dir, {});
    expect(hasTwitchAuth(creds)).toBe(false);
    expect(hasKickAuth(creds)).toBe(false);
  });

  it("reads credentials.json from the auth dir", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({
      twitch: { authToken: "stored-twitch" },
      kick: { sessionToken: "stored-kick" },
    }));
    const creds = loadCredentials(dir, {});
    expect(creds.twitch?.authToken).toBe("stored-twitch");
    expect(creds.kick?.sessionToken).toBe("stored-kick");
    expect(hasTwitchAuth(creds)).toBe(true);
    expect(hasKickAuth(creds)).toBe(true);
  });

  it("lets SA_* env overrides win over the on-disk store", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ twitch: { authToken: "stored" } }));
    const creds = loadCredentials(dir, { SA_TWITCH_AUTH_TOKEN: "from-env", SA_KICK_SESSION_TOKEN: "kick-env" });
    expect(creds.twitch?.authToken).toBe("from-env");
    expect(creds.kick?.sessionToken).toBe("kick-env");
  });

  it("ignores an unreadable/invalid store", () => {
    const creds = loadCredentials(join(dir, "does-not-exist"), { SA_TWITCH_AUTH_TOKEN: "env-only" });
    expect(creds.twitch?.authToken).toBe("env-only");
  });
});

describe("forgetCredentials", () => {
  it("removes one platform and leaves the other intact", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({
      twitch: { authToken: "tw", deviceId: "dev" },
      kick: { sessionToken: "kk" },
    }));
    expect(forgetCredentials(dir, "twitch")).toBe(true);
    const creds = loadCredentials(dir, {});
    expect(hasTwitchAuth(creds)).toBe(false);
    expect(creds.twitch?.deviceId).toBeUndefined();
    expect(creds.kick?.sessionToken).toBe("kk");
  });

  it("returns false when there is nothing stored for the platform", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ kick: { sessionToken: "kk" } }));
    expect(forgetCredentials(dir, "twitch")).toBe(false);
  });

  it("returns false when there is no store at all", () => {
    expect(forgetCredentials(join(dir, "missing"), "kick")).toBe(false);
  });
});
