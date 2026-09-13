import { describe, expect, it } from "vitest";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeEngineSettings, mergeSettings } from "@lurkloot/shared/settings";

describe("extension-only provider settings", () => {
  it("defaults all providers and takeovers off without changing tabless defaults", () => {
    expect(mergeSettings(undefined).twitchExtensions).toEqual({ nopixel: { enabled: false, autoOpenPacks: false }, fortnite: { enabled: false, allowTakeovers: false } });
    expect(mergeSettings(undefined).tablessMode).toBe(true);
    expect(mergeEngineSettings(DEFAULT_SETTINGS)).not.toHaveProperty("twitchExtensions");
  });
  it("merges individual provider toggles without losing other preferences", () => {
    const original = applySettingsPatch(DEFAULT_SETTINGS, { twitchExtensions: { fortnite: { enabled: true, allowTakeovers: true } } });
    const patched = applySettingsPatch(original, { twitchExtensions: { nopixel: { enabled: true, autoOpenPacks: false }, fortnite: { enabled: false } } });
    expect(patched.twitchExtensions).toEqual({ nopixel: { enabled: true, autoOpenPacks: false }, fortnite: { enabled: false, allowTakeovers: true } });
  });
  it("drops unknown/credential keys and normalizes malformed values", () => {
    const settings = mergeSettings({ twitchExtensions: { nopixel: { enabled: "yes", token: "private" }, fortnite: null } } as never);
    expect(settings.twitchExtensions).toEqual(DEFAULT_SETTINGS.twitchExtensions);
  });
});
