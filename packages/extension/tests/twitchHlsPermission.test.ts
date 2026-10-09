import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import type { CoreRuntimeMessage, RuntimeSnapshot, TwitchHlsGrantIntent } from "@lurkloot/shared/messages";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from "@lurkloot/shared/settings";
import { requestTwitchHlsAccess } from "../../popup-ui/src/twitchHlsPermission";
import type { PopupAdapter } from "../../popup-ui/src/types";
import {
  createTwitchHlsGrantCompletion,
  enforceTwitchHlsGrant,
  gateTwitchHlsMessages,
  promptTwitchHlsGrant,
  requestTwitchHlsGrant,
  shouldSuspendTwitchForMissingHlsHost,
  touchesTwitchHlsGate,
  TWITCH_HLS_GRANT_INTENT_KEY,
  TWITCH_HLS_HOST_ORIGIN,
} from "../src/core/twitchHlsPermission";

const enableTwitch: TwitchHlsGrantIntent = { type: "setAutomation", platform: "twitch", enabled: true };

function settings(patch: SettingsPatch = {}): ExtensionSettings {
  return applySettingsPatch(mergeSettings(DEFAULT_SETTINGS), patch);
}

const appliedSnapshot = { settings: DEFAULT_SETTINGS } as unknown as RuntimeSnapshot;

function harness() {
  const requestTwitchHlsGrant = vi.fn(async (_intent: TwitchHlsGrantIntent): Promise<RuntimeSnapshot | undefined> => appliedSnapshot);
  const adapter: Pick<PopupAdapter, "resolveCompatibility" | "requestTwitchHlsGrant"> = {
    resolveCompatibility: (selections) => resolveCompatibility(selections, { host: "extension", twitchIdentity: "web" }),
    requestTwitchHlsGrant,
  };
  return { adapter, requestTwitchHlsPermission: requestTwitchHlsGrant };
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
    requestTwitchHlsPermission.mockResolvedValueOnce(undefined);
    const grant = requestTwitchHlsAccess(adapter, settings(), settings({ platform: { twitch: { enabled: true } } }), enableTwitch);
    expect(requestTwitchHlsPermission).toHaveBeenCalledWith(enableTwitch);
    await expect(grant).resolves.toBeUndefined();
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

  it("requests the optional video CDN origin from the popup and has the background apply it", () => {
    const source = readFileSync(new URL("../entrypoints/popup/app.tsx", import.meta.url), "utf8");
    expect(source).toContain("requestTwitchHlsGrant: (intent) => requestTwitchHlsGrant(");
    expect(source).toContain("request: (details) => browser.permissions.request(details)");
    expect(source).toContain('complete: () => send<RuntimeSnapshot>({ type: "completeTwitchHlsGrant" })');
  });
});

describe("Twitch HLS grant enforcement", () => {
  function deps(current: ExtensionSettings, granted: boolean) {
    const disableTwitch = vi.fn(async () => "disabled-snapshot");
    const hasVideoCdnAccess = vi.fn(async () => granted);
    return { loadSettings: async () => current, hasVideoCdnAccess, disableTwitch };
  }

  it("turns Twitch off when it would watch with HLS and the video CDN grant is missing", async () => {
    const d = deps(settings({ platform: { twitch: { enabled: true } } }), false);
    await expect(enforceTwitchHlsGrant(d)).resolves.toBe("disabled-snapshot");
    expect(d.hasVideoCdnAccess).toHaveBeenCalledTimes(1);
    expect(d.disableTwitch).toHaveBeenCalledTimes(1);
  });

  it("leaves Twitch on when the video CDN is already granted, Twitch is off, or the heartbeat is not HLS", async () => {
    const cases = [
      settings({ platform: { twitch: { enabled: true } } }),
      settings(),
      settings({ platform: { twitch: { enabled: true } }, compatibility: { twitch: { profile: "twitch-2026-07" } } }),
      settings({ platform: { twitch: { enabled: true } }, compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-spade-v1" } } }),
    ];
    for (const [index, current] of cases.entries()) {
      const d = deps(current, index === 0);
      await expect(enforceTwitchHlsGrant(d)).resolves.toBeUndefined();
      expect(d.disableTwitch).not.toHaveBeenCalled();
    }
    expect(shouldSuspendTwitchForMissingHlsHost(settings({ platform: { twitch: { enabled: true } } }), false)).toBe(true);
  });

  it("identifies the messages that touch the Twitch switch or its heartbeat", () => {
    const touching: CoreRuntimeMessage[] = [
      { type: "setAutomation", platform: "twitch", enabled: true },
      { type: "setPlatformEnabled", platform: "twitch", enabled: false },
      { type: "saveSettings", settingsPatch: { platform: { twitch: { enabled: true } } } },
      { type: "saveSettings", settingsPatch: { compatibility: { twitch: { heartbeatTransport: "auto" } } } },
    ];
    const other: CoreRuntimeMessage[] = [
      { type: "setAutomation", platform: "kick", enabled: true },
      { type: "saveSettings", settingsPatch: { pollIntervalMinutes: 5 } },
      { type: "saveSettings", settingsPatch: { platform: { twitch: { excludedChannels: ["someone"] } } } },
      { type: "getSnapshot" },
      { type: "tickNow" },
    ];
    expect(touching.map(touchesTwitchHlsGate)).toEqual(touching.map(() => true));
    expect(other.map(touchesTwitchHlsGate)).toEqual(other.map(() => false));
  });

  describe("gated core messages", () => {
    function gate(enforced?: unknown) {
      const order: string[] = [];
      const handle = vi.fn(async (message: CoreRuntimeMessage) => {
        order.push(`handle ${message.type}`);
        return "handled-snapshot";
      });
      const cancelIntent = vi.fn(async () => { order.push("cancel"); });
      const enforce = vi.fn(async () => {
        order.push("enforce");
        return enforced;
      });
      const reportEnforcementFailure = vi.fn();
      return { order, handle, cancelIntent, enforce, reportEnforcementFailure, run: gateTwitchHlsMessages({ handle, cancelIntent, enforce, reportEnforcementFailure }) };
    }

    it("supersedes a waiting intent before a Twitch change and enforces the grant after it", async () => {
      const g = gate();
      await expect(g.run({ type: "setAutomation", platform: "twitch", enabled: false })).resolves.toBe("handled-snapshot");
      expect(g.order).toEqual(["cancel", "handle setAutomation", "enforce"]);
    });

    it("answers an import that turned Twitch on without the grant with the snapshot after Twitch is turned back off", async () => {
      const g = gate("disabled-snapshot");
      const imported: CoreRuntimeMessage = {
        type: "saveSettings",
        settingsPatch: { platform: { twitch: { enabled: true } } },
        tickAfterSave: true,
      };
      await expect(g.run(imported)).resolves.toBe("disabled-snapshot");
      expect(g.handle).toHaveBeenCalledWith(imported, undefined);
    });

    it("keeps the handled answer and reports when enforcement fails", async () => {
      const g = gate();
      g.enforce.mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(g.run({ type: "saveSettings", settingsPatch: { platform: { twitch: { enabled: true } } } })).resolves.toBe("handled-snapshot");
      expect(g.reportEnforcementFailure).toHaveBeenCalledOnce();
    });

    it("passes other messages straight through", async () => {
      const g = gate();
      await g.run({ type: "tickNow" });
      expect(g.order).toEqual(["handle tickNow"]);
    });
  });

  it("disables Twitch on extension update before farming resumes, and when the grant is revoked", () => {
    const source = readFileSync(new URL("../entrypoints/background.ts", import.meta.url), "utf8");
    const update = source.indexOf('details.reason === "update"');
    const enforce = source.indexOf("await enforceTwitchHlsGrantNow();", update);
    const resume = source.indexOf("await controller.ensureAlarm()");
    expect(update).toBeGreaterThan(-1);
    expect(enforce).toBeGreaterThan(update);
    expect(resume).toBeGreaterThan(enforce);
    expect(source).toContain("void twitchHlsGrantCompletion.added(details)");
    const removed = source.indexOf("browser.permissions.onRemoved.addListener");
    expect(source.indexOf("await enforceTwitchHlsGrantNow();", removed)).toBeGreaterThan(removed);
    expect(source).toContain('"missing-permission"');
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
    const complete = vi.fn(async (_intent: TwitchHlsGrantIntent) => undefined);
    const contains = vi.fn(async () => true);
    const completion = createTwitchHlsGrantCompletion({ storage, now: () => 1_000, contains, complete });
    return { values, storage, complete, contains, completion };
  }

  it("applies a requested enable after the popup is gone and does not apply it twice", async () => {
    const s = setup();
    let resolve: (granted: boolean) => void = () => undefined;
    const pending = promptTwitchHlsGrant({
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

  it("applies the intent once when the popup survives the prompt and asks for the result", async () => {
    const s = setup();
    const snapshot = { settings: DEFAULT_SETTINGS } as unknown as RuntimeSnapshot;
    const complete = vi.fn(async () => {
      await s.completion.flush();
      return snapshot;
    });
    const result = requestTwitchHlsGrant({
      storage: s.storage,
      request: async () => true,
      now: () => 1_000,
      complete,
    }, enableTwitch);
    // The grant event and the popup's request for the result race.
    const added = s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    await expect(result).resolves.toBe(snapshot);
    await added;
    expect(s.complete).toHaveBeenCalledExactlyOnceWith(enableTwitch);
  });

  it("applies an intent recorded while the host is already granted exactly once", async () => {
    const s = setup();
    const result = requestTwitchHlsGrant({
      storage: s.storage,
      request: async () => true,
      now: () => 1_000,
      complete: async () => {
        await s.completion.flush();
        return { settings: DEFAULT_SETTINGS } as unknown as RuntimeSnapshot;
      },
    }, enableTwitch);
    // No grant event fires for a host that was already granted; the intent
    // write's storage change and the popup's request for the result race.
    const changed = s.completion.changed({ [TWITCH_HLS_GRANT_INTENT_KEY]: { newValue: { at: 1_000, pending: enableTwitch } } });
    await result;
    await changed;
    expect(s.complete).toHaveBeenCalledExactlyOnceWith(enableTwitch);
  });

  it("resolves no snapshot and applies nothing when the prompt is declined", async () => {
    const s = setup();
    const complete = vi.fn(async () => ({ settings: DEFAULT_SETTINGS } as unknown as RuntimeSnapshot));
    await expect(requestTwitchHlsGrant({ storage: s.storage, request: async () => false, now: () => 1_000, complete }, enableTwitch)).resolves.toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    expect(s.values[TWITCH_HLS_GRANT_INTENT_KEY]).toBeUndefined();
  });

  it("does not apply an unsolicited grant, a decline, or an expired intent", async () => {
    const s = setup();
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).not.toHaveBeenCalled();
    await promptTwitchHlsGrant({ storage: s.storage, request: async () => false, now: () => 1_000 }, enableTwitch);
    expect(s.values[TWITCH_HLS_GRANT_INTENT_KEY]).toBeUndefined();
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    await promptTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => -200_000 }, enableTwitch);
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("finishes when the intent write arrives after the grant", async () => {
    const s = setup();
    let finish: () => void = () => undefined;
    s.storage.set = async (next) => { await new Promise<void>((done) => { finish = done; }); Object.assign(s.values, next); };
    const pending = promptTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, enableTwitch);
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
    await promptTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, enableTwitch);
    await s.completion.changed({ [TWITCH_HLS_GRANT_INTENT_KEY]: { newValue: { at: 1_000, pending: enableTwitch } } });
    expect(s.complete).not.toHaveBeenCalled();
    s.contains.mockResolvedValue(true);
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).toHaveBeenCalledOnce();
  });

  it("drops the intent when the video CDN host is removed or a newer Twitch change supersedes it", async () => {
    const s = setup();
    await promptTwitchHlsGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, enableTwitch);
    await s.completion.removed({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    await s.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(s.complete).not.toHaveBeenCalled();

    const later = setup();
    later.contains.mockResolvedValue(false);
    await promptTwitchHlsGrant({ storage: later.storage, request: async () => true, now: () => 1_000 }, enableTwitch);
    await later.completion.cancel();
    later.contains.mockResolvedValue(true);
    await later.completion.added({ origins: [TWITCH_HLS_HOST_ORIGIN] });
    expect(later.complete).not.toHaveBeenCalled();
  });
});
