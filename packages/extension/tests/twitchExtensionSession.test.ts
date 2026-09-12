import { describe, expect, it, vi } from "vitest";
import { withTwitchExtensionSession } from "../src/extensions/session";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

const provider = twitchExtensionProviders[0];
const now = 1_800_000_000_000;
function jwt(claims: Record<string, unknown> = {}) {
  return `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ channel_id: "123", exp: now / 1000 + 3600, role: "viewer", opaque_user_id: "Uviewer", user_id: "456", ...claims })).replace(/=/g, "")}.signature`;
}
function setup(token = jwt(), state = "ACTIVE", id = `${provider.extensionId}:1.1.2`) {
  const run = vi.fn(async (_session: { jwt: string; channelId: string; version: string; identityLinked: boolean }) => {});
  const query = vi.fn(async (_query: string, _variables: Record<string, string>) => ({ data: { user: { channel: { selfInstalledExtensions: [{ installation: { extension: { id, version: "1.1.2" }, activationConfig: { state } }, token: { jwt: token } }] } } } }));
  return { run, query, deps: { query, hasSession: async () => true, now: () => now } };
}

describe("tabless Twitch Extension session source", () => {
  it("obtains a channel-bound session from GQL without a page or iframe", async () => {
    const s = setup();
    expect(await withTwitchExtensionSession(s.deps, provider, "123", s.run)).toBe("ready");
    expect(s.query).toHaveBeenCalledWith(expect.stringContaining("selfInstalledExtensions"), { channelID: "123" }, undefined);
    expect(s.run).toHaveBeenCalledExactlyOnceWith({ jwt: jwt(), expiresAt: now + 3_600_000, signal: undefined, channelId: "123", version: "1.1.2", identityLinked: true });
  });
  it("does not query Twitch or call a provider without a logged-in session", async () => {
    const s = setup();
    expect(await withTwitchExtensionSession({ ...s.deps, hasSession: async () => false }, provider, "123", s.run)).toBe("auth-required");
    expect(s.query).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });
  it.each([
    [jwt({ channel_id: "another" }), "compatibility-error"],
    [jwt({ exp: now / 1000 }), "expired"],
    [jwt({ exp: now / 1000 + 30 }), "expired"],
    [jwt({ role: "external" }), "compatibility-error"],
    [jwt({ exp: "future" }), "compatibility-error"],
    [jwt({ opaque_user_id: "Aanonymous", user_id: undefined }), "auth-required"],
    ["not-a-jwt", "compatibility-error"],
  ])("rejects invalid or unusable credentials without returning them", async (token, expected) => {
    const s = setup(token);
    expect(await withTwitchExtensionSession(s.deps, provider, "123", s.run)).toBe(expected);
    expect(s.run).not.toHaveBeenCalled();
  });
  it.each([["INACTIVE", `${provider.extensionId}:1.1.2`], ["ACTIVE", "foreign:1.1.2"]])("ignores inactive or foreign installations", async (state, id) => {
    const s = setup(jwt(), state, id);
    expect(await withTwitchExtensionSession(s.deps, provider, "123", s.run)).toBe("unavailable");
    expect(s.run).not.toHaveBeenCalled();
  });
  it("scrubs transport and provider exceptions and ignores provider return values", async () => {
    const s = setup();
    expect(await withTwitchExtensionSession({ ...s.deps, query: async () => { throw new Error(jwt()); } }, provider, "123", s.run)).toBe("transport-error");
    expect(await withTwitchExtensionSession(s.deps, provider, "123", async () => { throw new Error(jwt()); })).toBe("provider-error");
    expect(await withTwitchExtensionSession(s.deps, provider, "123", async () => jwt())).toBe("ready");
  });
});


describe("Twitch Extension account-link state", () => {
  it("allows a provider to report an unlinked viewer without treating it as a transport failure", async () => {
    const s = setup(jwt({ user_id: undefined }));
    expect(await withTwitchExtensionSession(s.deps, provider, "123", s.run)).toBe("ready");
    expect(s.run).toHaveBeenCalledWith(expect.objectContaining({ identityLinked: false }));
  });
});


describe("Twitch Extension GQL compatibility", () => {
  it("drops error envelopes and malformed installation lists without calling the driver", async () => {
    const s = setup();
    expect(await withTwitchExtensionSession({ ...s.deps, query: async () => ({ errors: [{ message: jwt() }] }) }, provider, "123", s.run)).toBe("transport-error");
    expect(await withTwitchExtensionSession({ ...s.deps, query: async () => ({ data: { user: { channel: { selfInstalledExtensions: "malformed" } } } }) }, provider, "123", s.run)).toBe("compatibility-error");
    expect(s.run).not.toHaveBeenCalled();
  });
});

describe("Twitch Extension session cancellation", () => {
  it("does not acquire credentials after cancellation", async () => {
    const s = setup();
    const abort = new AbortController();
    abort.abort();
    expect(await withTwitchExtensionSession(s.deps, provider, "123", s.run, abort.signal)).toBe("cancelled");
    expect(s.query).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });
  it("discards a late GQL response when the selected channel stops", async () => {
    const s = setup();
    const abort = new AbortController();
    const query = async () => { abort.abort(); return s.query("", {}); };
    expect(await withTwitchExtensionSession({ ...s.deps, query }, provider, "123", s.run, abort.signal)).toBe("cancelled");
    expect(s.run).not.toHaveBeenCalled();
  });
  it("passes expiry and cancellation only to the privileged driver", async () => {
    const s = setup();
    const abort = new AbortController();
    const run = vi.fn(async () => { abort.abort(); });
    expect(await withTwitchExtensionSession(s.deps, provider, "123", run, abort.signal)).toBe("cancelled");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: now + 3_600_000, signal: abort.signal }));
  });
});
