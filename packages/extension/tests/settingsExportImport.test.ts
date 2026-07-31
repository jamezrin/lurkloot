import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import {
  InvalidSettingsImportError,
  SETTINGS_EXPORT_KIND,
  buildSettingsExportPayload,
  parseSettingsImportPayload,
} from "@lurkloot/shared/settingsExport";
import { CURRENT_SETTINGS_SCHEMA_VERSION, UnsupportedSettingsVersionError } from "@lurkloot/shared/settingsSchema";

describe("settings export/import", () => {
  it("round-trips a customized settings object", () => {
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true, idleWatchlistChannels: ["someone"] },
      },
      excludedCampaignIds: ["abc123"],
      languageOverride: "es",
    });

    const payload = buildSettingsExportPayload(settings);
    expect(payload.kind).toBe(SETTINGS_EXPORT_KIND);
    expect(payload.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);

    const { settings: imported, diagnostics } = parseSettingsImportPayload(JSON.parse(JSON.stringify(payload)));
    expect(imported).toEqual(settings);
    expect(diagnostics).toEqual([]);
  });

  it("never carries credential-shaped fields, even when injected into the source object", () => {
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      // These are not real ExtensionSettings fields; simulate an attacker (or a
      // stale build) putting them on the object handed to buildSettingsExportPayload.
      authToken: "secret-token",
      sessionToken: "secret-session",
      deviceId: "secret-device",
      twitchIntegrity: { clientIntegrity: "secret" },
    } as never);

    const payload = buildSettingsExportPayload(settings);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/authToken|sessionToken|deviceId|twitchIntegrity|secret-/i);
  });

  it("strips credential-shaped fields injected directly into an import file", () => {
    const payload = buildSettingsExportPayload(DEFAULT_SETTINGS);
    const tampered = {
      ...payload,
      settings: {
        ...payload.settings,
        authToken: "secret-token",
        sessionToken: "secret-session",
      },
    };

    const { settings } = parseSettingsImportPayload(tampered);
    expect(settings).not.toHaveProperty("authToken");
    expect(settings).not.toHaveProperty("sessionToken");
    expect(JSON.stringify(settings)).not.toMatch(/secret-/);
  });

  it("rejects a payload from a future schema version instead of corrupting state", () => {
    const payload = buildSettingsExportPayload(DEFAULT_SETTINGS);
    const future = { ...payload, schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION + 1 };
    expect(() => parseSettingsImportPayload(future)).toThrow(UnsupportedSettingsVersionError);
  });

  it("migrates an older-version payload forward", () => {
    const payload = {
      kind: SETTINGS_EXPORT_KIND,
      schemaVersion: 0,
      exportedAt: new Date().toISOString(),
      settings: { autoClaim: false, watchQueueFallbackOnly: true },
    };
    const { settings, diagnostics } = parseSettingsImportPayload(payload);
    expect(settings.autoClaim).toBe(false);
    expect(settings.idleWatchlistFallbackOnly).toBe(true);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("drops a non-https category imageUrl from a crafted import instead of rendering it as <img src>", () => {
    const payload = buildSettingsExportPayload(DEFAULT_SETTINGS);
    const tampered = {
      ...payload,
      settings: {
        ...payload.settings,
        platform: {
          ...payload.settings.platform,
          twitch: {
            ...payload.settings.platform.twitch,
            categories: [
              { id: "javascript:alert(1)", name: "javascript", imageUrl: "javascript:alert(1)" },
              { id: "http-beacon", name: "http beacon", imageUrl: "http://attacker.example/beacon.png" },
              { id: "safe", name: "Safe Game", imageUrl: "https://cdn.example/safe.png" },
            ],
          },
        },
      },
    };

    const { settings } = parseSettingsImportPayload(tampered);
    const categories = settings.platform.twitch.categories;
    expect(categories.find((c) => c.id === "javascript:alert(1)")?.imageUrl).toBeUndefined();
    expect(categories.find((c) => c.id === "http-beacon")?.imageUrl).toBeUndefined();
    expect(categories.find((c) => c.id === "safe")?.imageUrl).toBe("https://cdn.example/safe.png");
  });

  it("rejects a file that is not a lurkloot settings export", () => {
    expect(() => parseSettingsImportPayload({ foo: "bar" })).toThrow(InvalidSettingsImportError);
    expect(() => parseSettingsImportPayload(null)).toThrow(InvalidSettingsImportError);
    expect(() => parseSettingsImportPayload("not json")).toThrow(InvalidSettingsImportError);
    expect(() => parseSettingsImportPayload({ kind: SETTINGS_EXPORT_KIND })).toThrow(InvalidSettingsImportError);
  });
});
