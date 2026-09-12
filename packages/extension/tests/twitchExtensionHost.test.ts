import { describe, expect, it, vi } from "vitest";
import { createTwitchExtensionHost } from "../src/extensions/host";
import { DEFAULT_SETTINGS, applySettingsPatch } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { SettingsPatch } from "@lurkloot/shared/settings";
function setup() {
  let settings = structuredClone(DEFAULT_SETTINGS);
  const state = structuredClone(DEFAULT_STATE);
  state.authHealth.twitch = { status: "healthy" };
  state.sessions.twitch = { platform: "twitch", status: "watching", offlineChecks: 0, watchMode: "tabless", channel: { platform: "twitch", username: "buddha", url: "https://www.twitch.tv/buddha", channelId: "123" } };
  const contains = vi.fn(async () => true);
  const query = vi.fn(async () => ({ data: { user: { channel: { selfInstalledExtensions: [] } } } }));
  const stop = vi.fn();
  const source = { query, hasSession: async () => true, now: Date.now };
  const host = createTwitchExtensionHost({ source, permissions: { contains, request: async () => { throw new Error("UI must request grants"); } }, drivers: { nopixel: async () => ({ stop }) }, loadSettings: async () => settings, loadState: async () => state, savePatch: async (patch: SettingsPatch) => { settings = applySettingsPatch(settings, patch); }, diagnostic: vi.fn() });
  return { host, state, contains, query, stop, settings: () => settings, enableTwitch() { settings.platform.twitch.enabled = true; } };
}
describe("background tabless provider host", () => {
  it("does not query with default provider settings", async () => {
    const s = setup(); s.enableTwitch(); await s.host.reconcile();
    expect(s.query).not.toHaveBeenCalled(); expect(s.host.snapshot()).toEqual({});
  });
  it("verifies pregranted enable and does not depend on a watch tab", async () => {
    const s = setup(); s.enableTwitch(); expect(await s.host.setEnabled("nopixel", true)).toEqual({ enabled: true });
    expect(s.query).toHaveBeenCalledOnce();
    expect(s.state.sessions.twitch.tabId).toBeUndefined();
    expect(s.host.snapshot().nopixel?.channel).toEqual({ username: "buddha" });
  });
  it("keeps an ungranted provider disabled", async () => {
    const s = setup(); s.contains.mockResolvedValue(false);
    expect(await s.host.setEnabled("nopixel", true)).toEqual({ enabled: false });
    expect(s.settings().twitchExtensions.nopixel.enabled).toBe(false); expect(s.query).not.toHaveBeenCalled();
  });
  it("revocation disables and clears summaries", async () => {
    const s = setup(); s.enableTwitch(); await s.host.setEnabled("nopixel", true);
    s.contains.mockResolvedValue(false); await s.host.removed({ origins: ["https://nopixel.streamingtoolsmith.com/*"] });
    expect(s.settings().twitchExtensions.nopixel.enabled).toBe(false); expect(s.host.snapshot()).toEqual({});
  });
  it("does not query during platform disablement, manual pause or auth failure", async () => {
    const s = setup(); await s.host.setEnabled("nopixel", true); expect(s.query).not.toHaveBeenCalled();
    s.enableTwitch(); s.state.sessions.twitch.status = "paused"; await s.host.reconcile(); expect(s.query).not.toHaveBeenCalled();
    s.state.sessions.twitch.status = "watching"; s.state.authHealth.twitch = { status: "invalid_credentials" }; await s.host.reconcile(); expect(s.query).not.toHaveBeenCalled();
  });
  it("invalidates an in-flight reconciliation before it can restart", async () => {
    const s = setup(); s.enableTwitch();
    s.settings().twitchExtensions.nopixel.enabled = true;
    let resolve!: () => void;
    let reached!: () => void;
    const checking = new Promise<void>((done) => { reached = done; });
    s.contains.mockImplementation(async () => { reached(); await new Promise<void>((done) => { resolve = done; }); return true; });
    const pending = s.host.reconcile(); await checking;
    s.host.invalidate(); resolve(); await pending;
    expect(s.query).not.toHaveBeenCalled();
  });
  it("discovers its own tabless channel without a drop campaign", async () => {
    const s = setup(); s.enableTwitch(); s.settings().twitchExtensions.nopixel.enabled = true;
    s.state.sessions.twitch = { platform: "twitch", status: "idle", offlineChecks: 0 };
    s.query.mockResolvedValueOnce({ data: { game: { streams: { edges: [{ node: { broadcaster: { id: "123", login: "buddha" } } }] } } } } as never).mockResolvedValueOnce({ data: { users: [{ id: "123", login: "buddha", channel: { selfInstalledExtensions: [{ installation: { extension: { id: "nstuq90nghenyqwqme61jgvmtp253a" }, activationConfig: { state: "ACTIVE" } } }] } }] } } as never);
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel", tablessOnly: true, channel: { channelId: "123" } });
    expect(s.query).toHaveBeenCalledTimes(2);
    await s.host.chooseWatchTarget(s.settings(), s.state);
    expect(s.query).toHaveBeenCalledTimes(2);
  });

  it("stops acquisition immediately when manual-close authority precedes paused state", async () => {
    const s = setup(); s.enableTwitch(); s.state.manualClosePause = { twitch: { platform: "twitch", closedAt: new Date().toISOString() } };
    await s.host.setEnabled("nopixel", true);
    expect(s.query).not.toHaveBeenCalled();
  });

});
