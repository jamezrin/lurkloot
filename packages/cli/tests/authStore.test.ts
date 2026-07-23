import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialAvailabilityOf, describeCredentialHealth, forgetCredentials, hasKickAuth, hasTwitchAuth, loadCredentials } from "../src/authStore";

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

describe("describeCredentialHealth", () => {
  it("reports missing credentials with the shared reason code when nothing is stored or set", () => {
    const health = describeCredentialHealth(dir, {});
    expect(health.twitch).toEqual({ present: false, source: "none", status: "missing_credentials", reasonCode: "credentials_missing" });
    expect(health.kick).toEqual({ present: false, source: "none", status: "missing_credentials", reasonCode: "credentials_missing" });
  });

  it("marks stored credentials as present, sourced from the on-disk store, and awaiting a probe", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({
      twitch: { authToken: "stored-twitch" },
      kick: { sessionToken: "stored-kick" },
    }));
    const health = describeCredentialHealth(dir, {});
    expect(health.twitch).toEqual({ present: true, source: "stored", status: "checking" });
    expect(health.kick).toEqual({ present: true, source: "stored", status: "checking" });
  });

  it("attributes credentials to the environment when an SA_* override wins over the store", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ twitch: { authToken: "stored" } }));
    const health = describeCredentialHealth(dir, { SA_TWITCH_AUTH_TOKEN: "from-env" });
    expect(health.twitch).toEqual({ present: true, source: "environment", status: "checking" });
    expect(health.kick.status).toBe("missing_credentials");
  });

  it("treats an empty env override as absent rather than shadowing the store falsely", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ twitch: { authToken: "stored" } }));
    // An empty SA_* override wins the nullish merge in loadCredentials, so the
    // effective credential is empty — report missing, not a stored credential.
    const health = describeCredentialHealth(dir, { SA_TWITCH_AUTH_TOKEN: "" });
    expect(health.twitch).toEqual({ present: false, source: "none", status: "missing_credentials", reasonCode: "credentials_missing" });
  });

  it("surfaces a corrupt store as a transient lookup failure, not missing credentials", async () => {
    await writeFile(join(dir, "credentials.json"), "{ not json");
    const health = describeCredentialHealth(dir, {});
    expect(health.twitch).toEqual({ present: false, source: "none", status: "unavailable", reasonCode: "credential_lookup_failed" });
  });

  it("prefers an env credential even when the on-disk store is unreadable", async () => {
    await writeFile(join(dir, "credentials.json"), "{ not json");
    const health = describeCredentialHealth(dir, { SA_KICK_SESSION_TOKEN: "kick-env" });
    expect(health.kick).toEqual({ present: true, source: "environment", status: "checking" });
    expect(health.twitch.status).toBe("unavailable");
  });

  it("maps local health to the engine's pre-probe availability gate", () => {
    expect(credentialAvailabilityOf({ present: false, source: "none", status: "missing_credentials", reasonCode: "credentials_missing" })).toEqual({ status: "missing" });
    expect(credentialAvailabilityOf({ present: false, source: "none", status: "unavailable", reasonCode: "credential_lookup_failed" })).toEqual({ status: "unavailable" });
    expect(credentialAvailabilityOf({ present: true, source: "stored", status: "checking" })).toEqual({ status: "available" });
  });

  it("never places a credential value in the reported health", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ twitch: { authToken: "super-secret" } }));
    const serialized = JSON.stringify(describeCredentialHealth(dir, { SA_KICK_SESSION_TOKEN: "another-secret" }));
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("another-secret");
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
