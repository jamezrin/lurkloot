import { describe, expect, it, vi } from "vitest";
import type { TwitchExtensionDriverFactory } from "../src/extensions/runtime";
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
  const query = vi.fn(async (_query: string, _variables: Record<string, unknown>) => ({ data: { user: { channel: { selfInstalledExtensions: [] } } } }));
  const stop = vi.fn();
  const source = { query, hasSession: async () => true, now: vi.fn(() => Date.now()) };
  const drivers: { nopixel: TwitchExtensionDriverFactory } = { nopixel: async () => ({ stop }) };
  const diagnostic = vi.fn();
  const host = createTwitchExtensionHost({ source, permissions: { contains, request: async () => { throw new Error("UI must request grants"); } }, drivers, loadSettings: async () => settings, loadState: async () => state, savePatch: async (patch: SettingsPatch) => { settings = applySettingsPatch(settings, patch); }, diagnostic, publish: vi.fn() });
  return { host, state, contains, query, stop, diagnostic, source, drivers, settings: () => settings, enableTwitch() { settings.platform.twitch.enabled = true; } };
}
describe("background tabless provider host", () => {
  // #587: every caller shares one discovery per provider, but under its own
  // signal. One tick cancelling must not reject another tick waiting on it.
  describe("shared channel discovery", () => {
    const directory = { data: { game: { streams: { edges: [{ node: { broadcaster: { id: "123", login: "buddha" } } }] } } } };
    const installations = { data: { users: [{ id: "123", login: "buddha", channel: { selfInstalledExtensions: [{ installation: { extension: { id: "nstuq90nghenyqwqme61jgvmtp253a" }, activationConfig: { state: "ACTIVE" } } }] } }] } };
    function discovering() {
      const s = setup(); s.enableTwitch();
      s.settings().twitchExtensions.nopixel.enabled = true;
      let release!: (value: unknown) => void;
      const signals: Array<AbortSignal | undefined> = [];
      s.query.mockImplementation((async (query: string, _variables: Record<string, unknown>, signal?: AbortSignal) => {
        signals.push(signal);
        if (query.includes("ExtensionDirectory")) return await new Promise((resolve) => { release = resolve; });
        return installations;
      }) as never);
      return { s, signals, release: () => release(directory) };
    }

    it("rejects only the caller that cancelled, and still answers the others", async () => {
      const { s, release } = discovering();
      const cancelled = new AbortController();
      const first = s.host.chooseWatchTarget(s.settings(), s.state, cancelled.signal);
      const second = s.host.chooseWatchTarget(s.settings(), s.state, new AbortController().signal);
      await vi.waitFor(() => expect(s.query).toHaveBeenCalledOnce());

      cancelled.abort(new Error("tick cancelled"));
      await expect(first).rejects.toThrow("tick cancelled");
      release();

      await expect(second).resolves.toMatchObject({ id: "nopixel", channel: { username: "buddha" } });
      expect(s.query).toHaveBeenCalledTimes(2);
    });

    it("stops the discovery once its last caller leaves, and starts a fresh one next time", async () => {
      const { s, signals, release } = discovering();
      const cancelled = new AbortController();
      const only = s.host.chooseWatchTarget(s.settings(), s.state, cancelled.signal);
      await vi.waitFor(() => expect(s.query).toHaveBeenCalledOnce());

      cancelled.abort(new Error("tick cancelled"));
      await expect(only).rejects.toThrow("tick cancelled");
      expect(signals[0]?.aborted).toBe(true);
      release();

      const next = s.host.chooseWatchTarget(s.settings(), s.state);
      await vi.waitFor(() => expect(s.query).toHaveBeenCalledTimes(2));
      release();
      await expect(next).resolves.toMatchObject({ id: "nopixel", channel: { username: "buddha" } });
    });
  });

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
  it("records bounded unavailable outcomes once per channel without raw responses", async () => {
    const s = setup(); s.enableTwitch();
    await s.host.setEnabled("nopixel", true);
    await s.host.reconcile();
    expect(s.diagnostic).toHaveBeenCalledExactlyOnceWith("Twitch extension nopixel unavailable on buddha: channel-ineligible");
    s.state.sessions.twitch.channel = { ...s.state.sessions.twitch.channel!, username: "ssaab", channelId: "456", url: "https://www.twitch.tv/ssaab" };
    await s.host.reconcile();
    expect(s.diagnostic).toHaveBeenLastCalledWith("Twitch extension nopixel unavailable on ssaab: channel-ineligible");
  });
  it("preserves completion while ordinary drops resume and allows a bounded reprobe", async () => {
    const s = setup(); s.enableTwitch();
    const now = Date.now(); s.source.now.mockReturnValue(now);
    const jwt = `e30.${btoa(JSON.stringify({ channel_id: "123", exp: Math.floor(now / 1000) + 3600, role: "viewer", opaque_user_id: "Utest", user_id: "42" }))}.signature`;
    s.query.mockResolvedValue({ data: { user: { channel: { selfInstalledExtensions: [{ installation: { extension: { id: "nstuq90nghenyqwqme61jgvmtp253a", version: "1.1.2" }, activationConfig: { state: "ACTIVE" } }, token: { jwt } }] } } } } as never);
    s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [{ key: "daily-pack", earned: 60, required: 60 }], pending: [] }); return { stop: s.stop }; };
    await s.host.setEnabled("nopixel", true);
    s.state.sessions.twitch.channel = { platform: "twitch", username: "babylings", url: "https://www.twitch.tv/babylings", channelId: "456" };
    // Background cancels active authority before reconciling a normal channel
    // transition; this must preserve only completed public outcomes/cooldowns.
    s.host.invalidate({ preserveCompleted: true });
    await s.host.reconcile();
    expect(s.query).toHaveBeenCalledOnce(); expect(s.stop).toHaveBeenCalledOnce();
    expect(s.host.snapshot().nopixel).toMatchObject({ status: "complete", channel: { username: "buddha" }, progress: [{ earned: 60, required: 60 }] });
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toBeUndefined();
    s.source.now.mockReturnValue(now + 30 * 60_000 + 1);
    s.query.mockResolvedValueOnce({ data: { game: { streams: { edges: [{ node: { broadcaster: { id: "123", login: "buddha" } } }] } } } } as never).mockResolvedValueOnce({ data: { users: [{ id: "123", login: "buddha", channel: { selfInstalledExtensions: [{ installation: { extension: { id: "nstuq90nghenyqwqme61jgvmtp253a" }, activationConfig: { state: "ACTIVE" } } }] } }] } } as never);
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel", channel: { username: "buddha" } });
    s.state.sessions.twitch.channel = { platform: "twitch", username: "buddha", channelId: "123", url: "https://www.twitch.tv/buddha" };
    s.state.sessions.twitch.supplementalWatch = { id: "nopixel", tablessOnly: true };
    await s.host.reconcile();
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toBeUndefined();
  });
  it("rotates completed NoPixelV probes to another giveaway channel after cooldown", async () => {
    const s = setup(); s.enableTwitch();
    const now = Date.now(); s.source.now.mockReturnValue(now);
    const jwt = `e30.${btoa(JSON.stringify({ channel_id: "123", exp: Math.floor(now / 1000) + 3600, role: "viewer", opaque_user_id: "Utest", user_id: "42" }))}.signature`;
    const installation = { installation: { extension: { id: "nstuq90nghenyqwqme61jgvmtp253a", version: "1.1.2" }, activationConfig: { state: "ACTIVE" } } };
    s.query.mockResolvedValueOnce({ data: { user: { channel: { selfInstalledExtensions: [{ ...installation, token: { jwt } }] } } } } as never);
    s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [{ key: "daily-pack", earned: 60, required: 60 }], pending: [{ key: "giveaway", state: "blocked" }] }); return { stop: s.stop }; };
    await s.host.setEnabled("nopixel", true);
    s.host.invalidate({ preserveCompleted: true });
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toBeUndefined();
    s.source.now.mockReturnValue(now + 30 * 60_000 + 1);
    s.query.mockResolvedValueOnce({ data: { game: { streams: { edges: ["buddha", "ssaab"].map((login, index) => ({ node: { broadcaster: { id: String(123 + index), login } } })) } } } } as never)
      .mockResolvedValueOnce({ data: { users: ["buddha", "ssaab"].map((login, index) => ({ id: String(123 + index), login, channel: { selfInstalledExtensions: [installation] } })) } } as never);
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ channel: { username: "ssaab" } });
    // Repeated selection before a new outcome remains stable and uses the cache.
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ channel: { username: "ssaab" } });
    expect(s.query).toHaveBeenCalledTimes(3);
    s.host.invalidate();
    expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ channel: { username: "buddha" } });
    expect(s.query).toHaveBeenCalledTimes(3);
  });
  it("drains an in-flight enable before reset disablement completes", async () => {
    const s = setup();
    let finish!: (granted: boolean) => void;
    s.contains.mockImplementationOnce(() => new Promise<boolean>(done => { finish = done; }));
    const enabling = s.host.setEnabled("nopixel", true);
    await vi.waitFor(() => expect(s.contains).toHaveBeenCalledOnce());
    const disabling = s.host.setEnabled("nopixel", false);
    finish(true);
    await Promise.all([enabling, disabling]);
    expect(s.settings().twitchExtensions.nopixel.enabled).toBe(false);
    expect(s.query).not.toHaveBeenCalled();
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

  // #596: the lane pauses for the user's viewing through the shared
  // manual-watch query, the same rule farming uses.
  describe("manual watch", () => {
    function discoverable() {
      const s = setup(); s.enableTwitch(); s.settings().twitchExtensions.nopixel.enabled = true;
      s.settings().pauseOnManualWatch = true;
      s.state.sessions.twitch = { platform: "twitch", status: "idle", offlineChecks: 0 };
      s.query.mockResolvedValueOnce({ data: { game: { streams: { edges: [{ node: { broadcaster: { id: "123", login: "buddha" } } }] } } } } as never).mockResolvedValueOnce({ data: { users: [{ id: "123", login: "buddha", channel: { selfInstalledExtensions: [{ installation: { extension: { id: "nstuq90nghenyqwqme61jgvmtp253a" }, activationConfig: { state: "ACTIVE" } } }] } }] } } as never);
      return s;
    }

    it("chooses no channel while the user is watching Twitch", async () => {
      const s = discoverable();
      s.state.manualWatch = { twitch: { platform: "twitch", tabId: 9, active: true, checkedAt: new Date(s.source.now()).toISOString() } };
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toBeUndefined();
      expect(s.query).not.toHaveBeenCalled();
    });

    // A clock rollback can leave a stamp in the future. Farming already counts
    // it as stale, so the lane no longer pauses on it either (behavior change).
    it("does not pause for a manual watch stamped in the future", async () => {
      const s = discoverable();
      s.state.manualWatch = { twitch: { platform: "twitch", tabId: 9, active: true, checkedAt: new Date(s.source.now() + 60_000).toISOString() } };
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel", channel: { channelId: "123" } });
    });
  });

  it("stops acquisition immediately when manual-close authority precedes paused state", async () => {
    const s = setup(); s.enableTwitch(); s.state.manualClosePause = { twitch: { platform: "twitch", closedAt: new Date().toISOString() } };
    await s.host.setEnabled("nopixel", true);
    expect(s.query).not.toHaveBeenCalled();
  });

  describe("provider selection stability", () => {
    const noPixelInstall = { installation: { extension: { id: "nstuq90nghenyqwqme61jgvmtp253a", version: "1.1.2" }, activationConfig: { state: "ACTIVE" } } };
    const fortniteInstall = { installation: { extension: { id: "x2nfeda4neuzvsp2zdqfln9nwxc7tp", version: "1.0.0" }, activationConfig: { state: "ACTIVE" } } };
    function withDirectory(s: ReturnType<typeof setup>, now: number) {
      const jwt = `e30.${btoa(JSON.stringify({ channel_id: "123", exp: Math.floor(now / 1000) + 3600, role: "viewer", opaque_user_id: "Utest", user_id: "42" }))}.signature`;
      const streams: Record<string, { id: string; login: string; install: typeof noPixelInstall }> = {
        "32982": { id: "123", login: "buddha", install: noPixelInstall },
        "33214": { id: "789", login: "happyhappygal", install: fortniteInstall },
      };
      s.query.mockImplementation((async (_query: string, variables: Record<string, unknown>) => {
        if (typeof variables.channelID === "string") return { data: { user: { channel: { selfInstalledExtensions: [{ ...noPixelInstall, token: { jwt } }] } } } };
        if (typeof variables.gameID === "string") {
          const stream = streams[variables.gameID];
          return { data: { game: { streams: { edges: [{ node: { broadcaster: { id: stream.id, login: stream.login } } }] } } } };
        }
        const logins = variables.logins as string[];
        return { data: { users: Object.values(streams).filter((stream) => logins.includes(stream.login)).map((stream) => ({ id: stream.id, login: stream.login, channel: { selfInstalledExtensions: [stream.install] } })) } };
      }) as never);
      (s.drivers as Record<string, TwitchExtensionDriverFactory>).fortnite = async () => ({ stop: s.stop });
      s.settings().twitchExtensions.fortnite.enabled = true;
    }

    it.each([10 * 60_000 + 1, 30 * 60_000 + 1, 24 * 60 * 60_000])("bounds completed provider deferral to %i milliseconds", async (elapsed) => {
      const s = setup(); s.enableTwitch();
      const now = Date.UTC(2026, 8, 14, 23, 50); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [{ key: "daily-pack", earned: 60, required: 60 }], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      s.host.invalidate({ preserveCompleted: true });
      s.state.sessions.twitch = { platform: "twitch", status: "watching", offlineChecks: 0, watchMode: "tabless", supplementalWatch: { id: "fortnite", tablessOnly: true }, channel: { platform: "twitch", username: "happyhappygal", url: "https://www.twitch.tv/happyhappygal", channelId: "789", live: true } };
      s.source.now.mockReturnValue(now + elapsed);
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel" });
    });

    it("consumes due reprobe priority after an unavailable outcome", async () => {
      const s = setup(); s.enableTwitch();
      const now = Date.UTC(2026, 8, 14, 12); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [{ key: "daily-pack", earned: 60, required: 60 }], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      s.host.invalidate({ preserveCompleted: true });
      s.source.now.mockReturnValue(now + 30 * 60_000 + 1);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "unavailable", reasonCode: "channel-not-connected", progress: [], pending: [] }); return { stop: s.stop }; };
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "nopixel")).toMatchObject({ id: "nopixel" });
      s.state.sessions.twitch.supplementalWatch = { id: "nopixel", tablessOnly: true };
      await s.host.reconcile();
      expect(s.host.snapshot().nopixel?.status).toBe("unavailable");
      s.state.sessions.twitch = { platform: "twitch", status: "watching", offlineChecks: 0, watchMode: "tabless", supplementalWatch: { id: "fortnite", tablessOnly: true }, channel: { platform: "twitch", username: "happyhappygal", url: "https://www.twitch.tv/happyhappygal", channelId: "789", live: true } };
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "fortnite" });
    });

    it.each([
      { label: "thirty-minute completion deadline", now: Date.UTC(2026, 8, 14, 12), intermediate: [5, 10, 29], due: 30 },
      { label: "NoPixel UTC day reset", now: Date.UTC(2026, 8, 14, 23, 50), intermediate: [5, 9], due: 10 },
    ])("preserves the original $label through incidental lower-source reconciliations", async ({ now, intermediate, due }) => {
      const s = setup(); s.enableTwitch();
      s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      const directoryQuery = s.query.getMockImplementation()!;
      s.query.mockImplementation(((query: string, variables: Record<string, unknown>) => variables.channelID === "456"
        ? Promise.resolve({ data: { user: { channel: { selfInstalledExtensions: [] } } } })
        : directoryQuery(query, variables)) as never);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [{ key: "daily-pack", earned: 60, required: 60 }], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      s.host.invalidate({ preserveCompleted: true });
      s.state.sessions.twitch = { platform: "twitch", status: "watching", offlineChecks: 0, watchMode: "tabless", channel: { platform: "twitch", username: "babylings", channelId: "456", url: "https://www.twitch.tv/babylings", live: true } };
      for (const minutes of intermediate) {
        s.source.now.mockReturnValue(now + minutes * 60_000 + 1);
        await s.host.reconcile();
        expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "nopixel")).toBeUndefined();
      }
      s.source.now.mockReturnValue(now + due * 60_000 + 1);
      // Even after expiry, an incidental lower channel cannot consume the
      // configured-position turn that belongs to the scheduler.
      await s.host.reconcile();
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "nopixel")).toMatchObject({ id: "nopixel", channel: { username: "buddha" } });
    });

    it.each(["disable", "revocation", "account"] as const)("forgets prior channel-failure cooldowns after %s changes authority", async change => {
      const s = setup(); s.enableTwitch();
      const now = Date.UTC(2026, 8, 14, 12); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "unavailable", reasonCode: "channel-not-connected", progress: [], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      s.host.invalidate();
      s.state.sessions.twitch = { platform: "twitch", status: "idle", offlineChecks: 0 };
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "nopixel")).toBeUndefined();
      if (change === "account") s.host.invalidate({ forgetCompletion: true });
      else {
        if (change === "disable") await s.host.setEnabled("nopixel", false);
        else await s.host.removed({ origins: ["https://nopixel.streamingtoolsmith.com/*"] });
        await s.host.setEnabled("nopixel", true);
      }
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "nopixel")).toMatchObject({ id: "nopixel", channel: { username: "buddha" } });
    });

    it("lets a higher-priority eligible provider preempt an earning provider", async () => {
      const s = setup(); s.enableTwitch();
      const now = Date.now(); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.settings().twitchExtensions.nopixel.enabled = true;
      s.state.sessions.twitch = { platform: "twitch", status: "watching", offlineChecks: 0, watchMode: "tabless", supplementalWatch: { id: "fortnite", tablessOnly: true }, channel: { platform: "twitch", username: "happyhappygal", url: "https://www.twitch.tv/happyhappygal", channelId: "789", live: true } };
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel", channel: { username: "buddha" } });
      s.settings().platform.twitch.watchSourcePriority = ["fortnite", "nopixel", "drops", "idle_watchlist"];
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "fortnite", channel: { username: "happyhappygal" } });
    });

    it("routes a requested source without falling through to another provider", async () => {
      const s = setup(); s.enableTwitch();
      withDirectory(s, Date.now());
      s.settings().twitchExtensions.nopixel.enabled = true;
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "fortnite")).toMatchObject({ id: "fortnite" });
      s.settings().twitchExtensions.fortnite.enabled = false;
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "fortnite")).toBeUndefined();
    });

    it("defers complete sources even when no lower provider holds a session", async () => {
      const s = setup(); s.enableTwitch();
      const now = Date.UTC(2026, 8, 14, 12); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      s.host.invalidate({ preserveCompleted: true });
      s.state.sessions.twitch.status = "idle";
      s.settings().twitchExtensions.fortnite.enabled = false;
      s.source.now.mockReturnValue(now + 10 * 60_000);
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toBeUndefined();
      s.source.now.mockReturnValue(now + 30 * 60_000 + 1);
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel" });
    });

    // Current behavior, not intended (#584): completion and cooldowns live only
    // in the host's memory, so a service-worker restart forgets them and the
    // provider is probed again. #594 either persists them or bounds the re-probe.
    it("forgets completion when a new host starts over the same settings and state", async () => {
      const s = setup(); s.enableTwitch();
      const now = Date.UTC(2026, 8, 14, 12); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      s.host.invalidate({ preserveCompleted: true });
      s.state.sessions.twitch.status = "idle";
      s.settings().twitchExtensions.fortnite.enabled = false;
      s.source.now.mockReturnValue(now + 10 * 60_000);
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toBeUndefined();

      const restarted = createTwitchExtensionHost({
        source: s.source,
        permissions: { contains: s.contains, request: async () => { throw new Error("UI must request grants"); } },
        drivers: s.drivers,
        loadSettings: async () => s.settings(),
        loadState: async () => s.state,
        savePatch: async () => undefined,
        diagnostic: s.diagnostic,
        publish: vi.fn(),
      });
      expect(await restarted.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel" });
    });

    it("allows a NoPixel daily reset across midnight inside the short completion cooldown", async () => {
      const s = setup(); s.enableTwitch();
      const now = Date.UTC(2026, 8, 14, 23, 59); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      s.source.now.mockReturnValue(Date.UTC(2026, 8, 15, 0, 0, 1));
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel" });
    });

    it("retries an unavailable provider after its channel cooldown expires", async () => {
      const s = setup(); s.enableTwitch();
      const now = Date.UTC(2026, 8, 14, 12); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "unavailable", reasonCode: "channel-not-connected", progress: [], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "nopixel")).toBeUndefined();
      s.source.now.mockReturnValue(now + 5 * 60_000 + 1);
      expect(await s.host.chooseWatchTarget(s.settings(), s.state, undefined, "nopixel")).toMatchObject({ id: "nopixel" });
    });

    it("remembers completion across Twitch toggles so a finished provider does not win the next tick", async () => {
      const s = setup(); s.enableTwitch();
      const now = Date.now(); s.source.now.mockReturnValue(now);
      withDirectory(s, now);
      s.drivers.nopixel = async (_session, emit) => { emit({ status: "complete", reasonCode: "rewards-complete", progress: [{ key: "daily-pack", earned: 60, required: 60 }], pending: [] }); return { stop: s.stop }; };
      await s.host.setEnabled("nopixel", true);
      // Disabling and re-enabling Twitch invalidates without preserving summaries.
      s.host.invalidate();
      s.state.sessions.twitch = { platform: "twitch", status: "idle", offlineChecks: 0 };
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "fortnite", channel: { username: "happyhappygal" } });
      // A credential change may be a different account: completion is re-learned.
      s.host.invalidate({ forgetCompletion: true });
      expect(await s.host.chooseWatchTarget(s.settings(), s.state)).toMatchObject({ id: "nopixel", channel: { username: "buddha" } });
    });
  });
});
