import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from "@lurkloot/shared/settings";
import { requestTwitchHlsAccess } from "../../popup-ui/src/twitchHlsPermission";
import type { PopupAdapter } from "../../popup-ui/src/types";
import { createTwitchHlsGrantCompletion, requestTwitchHlsGrant, shouldSuspendTwitchForMissingHlsHost, suspendTwitchUntilHlsHostGranted, TWITCH_HLS_GRANT_INTENT_KEY, TWITCH_HLS_HOST_ORIGIN } from "../src/core/twitchHlsPermission";
import type { TwitchHlsGrantIntent } from "../../popup-ui/src/types";

const enableTwitch: TwitchHlsGrantIntent = { type: "setAutomation", platform: "twitch", enabled: true };

function settings(patch: SettingsPatch = {}): ExtensionSettings {
  return applySettingsPatch(mergeSettings(DEFAULT_SETTINGS), patch);
}

function harness() {
  const requestTwitchHlsPermission = vi.fn(async () => true);
  const adapter: Pick<PopupAdapter, "resolveCompatibility" | "requestTwitchHlsPermission"> = {
    resolveCompatibility: (selections) => resolveCompatibility(selections, { host: "extension", twitchIdentity: "web" }),
    requestTwitchHlsPermission,
  };
  return { adapter, requestTwitchHlsPermission };
}

describe("Twitch HLS host permission", () => {
  it("keeps HLS as the default automatic web heartbeat", () => {
    const { adapter } = harness();
    expect(adapter.resolveCompatibility!(DEFAULT_SETTINGS.compatibility).compatibility.twitch).toMatchObject({
      profile: "twitch-2026-10",
      heartbeat: "twitch-heartbeat-hls-v1",
    });
  });

  it("asks when Twitch is turned on with the default heartbeat and reports a decline", async () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    requestTwitchHlsPermission.mockResolvedValueOnce(false);
    const grant = requestTwitchHlsAccess(adapter, settings(), settings({ platform: { twitch: { enabled: true } } }), enableTwitch);
    expect(requestTwitchHlsPermission).toHaveBeenCalledWith(enableTwitch);
    await expect(grant).resolves.toBe(false);
  });

  it("does not gate Twitch when the selected profile would not use HLS", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    const july = { compatibility: { twitch: { profile: "twitch-2026-07" as const } } };
    expect(requestTwitchHlsAccess(adapter, settings(july), settings({ ...july, platform: { twitch: { enabled: true } } }), enableTwitch)).toBeUndefined();
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
  });

  it("asks when an explicit HLS heartbeat is turned on, including over the July profile", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    const heartbeat = { compatibility: { twitch: { profile: "twitch-2026-07" as const, heartbeatTransport: "twitch-heartbeat-hls-v1" as const } } };
    requestTwitchHlsAccess(adapter, settings(heartbeat), settings({ ...heartbeat, platform: { twitch: { enabled: true } } }), enableTwitch);
    expect(requestTwitchHlsPermission).toHaveBeenCalledTimes(1);
  });

  it("does not ask when Twitch is turned on with Spade selected", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    const heartbeat = { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-spade-v1" as const } } };
    requestTwitchHlsAccess(adapter, settings(heartbeat), settings({ ...heartbeat, platform: { twitch: { enabled: true } } }), enableTwitch);
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
  });

  it("does not ask when Twitch is turned on with the July 2026 profile", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    const profile = { compatibility: { twitch: { profile: "twitch-2026-07" as const } } };
    requestTwitchHlsAccess(adapter, settings(profile), settings({ ...profile, platform: { twitch: { enabled: true } } }), enableTwitch);
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
  });

  it("asks when the heartbeat changes to HLS while Twitch is already on", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    const saveHeartbeat: TwitchHlsGrantIntent = {
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "auto" } } },
    };
    requestTwitchHlsAccess(
      adapter,
      settings({ platform: { twitch: { enabled: true } }, compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-spade-v1" } } }),
      settings({ platform: { twitch: { enabled: true } }, compatibility: { twitch: { heartbeatTransport: "auto" } } }),
      saveHeartbeat,
    );
    expect(requestTwitchHlsPermission).toHaveBeenCalledWith(saveHeartbeat);
    expect(requestTwitchHlsPermission).toHaveBeenCalledTimes(1);
  });

  it("does not ask again while Twitch stays on with HLS", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    requestTwitchHlsAccess(
      adapter,
      settings({ platform: { twitch: { enabled: true } } }),
      settings({ platform: { twitch: { enabled: true } }, compatibility: { twitch: { inventoryQueryVersion: "twitch-inventory-v1" } } }),
      enableTwitch,
    );
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
  });

  it("does not ask when selecting HLS while Twitch is off", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    requestTwitchHlsAccess(
      adapter,
      settings({ compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-spade-v1" } } }),
      settings({ compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-hls-v1" } } }),
      enableTwitch,
    );
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
  });

  it("does not ask when Kick is turned on or Twitch is turned off", () => {
    const { adapter, requestTwitchHlsPermission } = harness();
    requestTwitchHlsAccess(adapter, settings(), settings({ platform: { kick: { enabled: true } } }), enableTwitch);
    requestTwitchHlsAccess(adapter, settings({ platform: { twitch: { enabled: true } } }), settings(), enableTwitch);
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
  });

  it("skips the prompt when the host cannot request permissions", () => {
    const adapter = {
      resolveCompatibility: (selections: ExtensionSettings["compatibility"]) => resolveCompatibility(selections, { host: "extension" as const, twitchIdentity: "web" as const }),
    };
    expect(() => requestTwitchHlsAccess(adapter, settings(), settings({ platform: { twitch: { enabled: true } } }), enableTwitch)).not.toThrow();
  });

  it("requests the optional video CDN origin from the popup", () => {
    const source = readFileSync(new URL("../entrypoints/popup/app.tsx", import.meta.url), "utf8");
    expect(source).toContain("requestTwitchHlsPermission: (intent) => requestTwitchHlsGrant(");
    expect(source).toContain("request: (details) => browser.permissions.request(details)");
  });

  it("turns Twitch off on an update when HLS is selected and the video CDN grant is missing", async () => {
    const disableTwitch = vi.fn(async () => undefined);
    const hasVideoCdnAccess = vi.fn(async () => false);
    await suspendTwitchUntilHlsHostGranted({
      loadSettings: async () => settings({ platform: { twitch: { enabled: true } } }),
      hasVideoCdnAccess,
      disableTwitch,
    });
    expect(hasVideoCdnAccess).toHaveBeenCalledTimes(1);
    expect(disableTwitch).toHaveBeenCalledTimes(1);
  });

  it("leaves Twitch on when the video CDN is already granted, Twitch is off, or the heartbeat is not HLS", async () => {
    const cases = [
      settings({ platform: { twitch: { enabled: true } } }),
      settings(),
      settings({ platform: { twitch: { enabled: true } }, compatibility: { twitch: { profile: "twitch-2026-07" } } }),
      settings({ platform: { twitch: { enabled: true } }, compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-spade-v1" } } }),
    ];
    for (const [index, current] of cases.entries()) {
      const disableTwitch = vi.fn(async () => undefined);
      await suspendTwitchUntilHlsHostGranted({
        loadSettings: async () => current,
        hasVideoCdnAccess: async () => index === 0,
        disableTwitch,
      });
      expect(disableTwitch).not.toHaveBeenCalled();
    }
    expect(shouldSuspendTwitchForMissingHlsHost(settings({ platform: { twitch: { enabled: true } } }), false)).toBe(true);
  });

  it("disables Twitch on extension update before farming resumes", () => {
    const source = readFileSync(new URL("../entrypoints/background.ts", import.meta.url), "utf8");
    const update = source.indexOf('details.reason === "update"');
    const suspend = source.indexOf("await suspendTwitchUntilHlsHostGranted(");
    const resume = source.indexOf("await controller.ensureAlarm()");
    expect(update).toBeGreaterThan(-1);
    expect(suspend).toBeGreaterThan(update);
    expect(resume).toBeGreaterThan(suspend);
    expect(source).toContain("void twitchHlsGrantCompletion.added(details)");
  });
});

describe("Twitch HLS grant completion", () => {
  function setup() {
    const values: Record<string, unknown> = {};
    const storage = {
      get: async (key: string) => ({ [key]: values[key] }),
      set: async (next: Record<string, unknown>) => { Object.assign(values, next); },
      remove: async (key: string) => { delete values[key]; },
    };
    const complete = vi.fn(async () => undefined);
    const contains = vi.fn(async () => true);
    const completion = createTwitchHlsGrantCompletion({ storage, now: () => 1_000, contains, complete });
    return { values, storage, complete, contains, completion };
  }

  it("applies a requested enable after the popup is gone and does not apply it twice", async () => {
    const s = setup();
    let resolve: (granted: boolean) => void = () => undefined;
    const pending = requestTwitchHlsGrant({
      storage: s.storage,
      request: () => new Promise<boolean>((done) => { resolve = done; }),
      now: () => 1_000,
    }, enableTwitch);
    expect(s.values[TWITCH_HLS_GRANT_INTENT_KEY]).toMatchObject({ at: 1_000, pending: enableTwitch });
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).toHaveBeenCalledExactlyOnceWith(enableTwitch);
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).toHaveBeenCalledOnce();
    resolve(true);
    await expect(pending).resolves.toBe(true);
  });

  it("does not apply an unsolicited grant, a decline, or an expired intent", async () => {
    const s = setup();
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).not.toHaveBeenCalled();
    await requestTwitchHlsGrant({ storage: s.storage, request: async () => false, now: () => 1_000 }, enableTwitch);
    expect(s.values[TWITCH_HLS_GRANT_INTENT_KEY]).toBeUndefined();
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    await requestTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => -200_000 }, enableTwitch);
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("finishes when the intent write arrives after the grant", async () => {
    const s = setup();
    let finish: () => void = () => undefined;
    s.storage.set = async (next) => { await new Promise<void>((done) => { finish = done; }); Object.assign(s.values, next); };
    const pending = requestTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, enableTwitch);
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).not.toHaveBeenCalled();
    finish();
    await pending;
    await s.completion.changed({ [TWITCH_HLS_GRANT_INTENT_KEY]: { newValue: { at: 1_000, pending: enableTwitch } } });
    expect(s.complete).toHaveBeenCalledExactlyOnceWith(enableTwitch);
  });

  it("waits for the host grant before applying an intent write", async () => {
    const s = setup();
    s.contains.mockResolvedValue(false);
    await requestTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, enableTwitch);
    await s.completion.changed({ [TWITCH_HLS_GRANT_INTENT_KEY]: { newValue: { at: 1_000, pending: enableTwitch } } });
    expect(s.complete).not.toHaveBeenCalled();
    s.contains.mockResolvedValue(true);
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).toHaveBeenCalledOnce();
  });

  it("drops the intent when the video CDN host is removed", async () => {
    const s = setup();
    await requestTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, enableTwitch);
    await s.completion.removed({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).not.toHaveBeenCalled();
  });
});
