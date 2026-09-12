import { describe, expect, it, vi } from "vitest";
import { createProviderPermissions } from "../src/extensions/permissions";
import { type ProviderScript, type Mv2ProviderScript, createProviderRegistration } from "../src/extensions/registration";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

const provider = twitchExtensionProviders[0];
function setup(granted = false, enabled = false, mv2 = false) {
  let grant = granted;
  const enabledIds = new Set(enabled ? [provider.id] : []);
  const unregister = vi.fn(async () => {});
  const register = vi.fn(async (_script: Mv2ProviderScript) => ({ unregister }));
  const registerContentScripts = vi.fn(async (_scripts: ProviderScript[]) => {});
  const unregisterContentScripts = vi.fn(async () => {});
  const request = vi.fn(async () => grant);
  const contains = vi.fn(async () => grant);
  const registration = createProviderRegistration(mv2
    ? { contentScripts: { register } }
    : { scripting: { registerContentScripts, unregisterContentScripts } });
  const clear = vi.fn(async () => {});
  const setEnabled = vi.fn(async (id: typeof provider.id, value: boolean) => { if (value) enabledIds.add(id); else enabledIds.delete(id); });
  const permissions = createProviderPermissions({
    permissions: { request, contains }, registration,
    enabled: async (id) => enabledIds.has(id),
    setEnabled,
    clearTransientState: clear,
  });
  return { permissions, registration, enabledIds, request, contains, register, unregister,
    registerContentScripts, unregisterContentScripts, clear, setEnabled, setGrant(value: boolean) { grant = value; } };
}

describe("Twitch Extension optional permissions", () => {
  it("requests only the provider frame, preserving disabled state on denial", async () => {
    const s = setup();
    expect(await s.permissions.enable(provider.id)).toBe(false);
    expect(s.request).toHaveBeenCalledExactlyOnceWith({ origins: [provider.origin] });
    expect(s.enabledIds.size).toBe(0);
    expect(s.registerContentScripts).not.toHaveBeenCalled();
  });
  it("registers the isolated and MAIN scripts only after a verified grant", async () => {
    const s = setup(true);
    expect(await s.permissions.enable(provider.id)).toBe(true);
    expect(s.enabledIds.has(provider.id)).toBe(true);
    const scripts = s.registerContentScripts.mock.calls[0][0];
    expect(scripts.map((script) => script.world)).toEqual(["ISOLATED", "MAIN"]);
    expect(scripts.every((script) => script.matches.length === 1 && script.matches[0] === provider.origin && script.allFrames)).toBe(true);
    await s.permissions.reconcile();
    expect(s.registerContentScripts).toHaveBeenCalledTimes(1);
  });
  it("registers both worlds through Firefox MV2 and retains their handles", async () => {
    const s = setup(true, false, true);
    await s.permissions.enable(provider.id);
    expect(s.register.mock.calls.map(([script]) => script.world)).toEqual(["ISOLATED", "MAIN"]);
    await s.permissions.removed({ origins: [provider.origin] });
    expect(s.unregister).toHaveBeenCalledTimes(2);
    expect(s.enabledIds.size).toBe(0);
    expect(s.clear).toHaveBeenCalledExactlyOnceWith(provider.id);
  });
  it("revocation unregisters and releases transient state only for the affected provider", async () => {
    const s = setup(true);
    await s.permissions.enable(provider.id);
    await s.permissions.removed({ origins: [twitchExtensionProviders[1].origin] });
    expect(s.enabledIds.has(provider.id)).toBe(true);
    await s.permissions.removed({ origins: [provider.origin] });
    expect(s.enabledIds.size).toBe(0);
    expect(s.unregisterContentScripts).toHaveBeenCalledWith({ ids: expect.arrayContaining([`lurkloot-${provider.id}-relay`, `lurkloot-${provider.id}-driver`]) });
    expect(s.clear).toHaveBeenCalledExactlyOnceWith(provider.id);
  });
  it("disables a persisted enable flag if the grant disappeared between sessions", async () => {
    const s = setup(false, true);
    await s.permissions.reconcile();
    expect(s.enabledIds.size).toBe(0);
    expect(s.registerContentScripts).not.toHaveBeenCalled();
    expect(s.request).not.toHaveBeenCalled();
    expect(s.clear).toHaveBeenCalledWith(provider.id);
  });
  it("registers nothing with every provider disabled, even if grants remain", async () => {
    const s = setup(true);
    await s.permissions.reconcile();
    expect(s.registerContentScripts).not.toHaveBeenCalled();
    expect(s.register).not.toHaveBeenCalled();
  });
  it("rolls back a partially registered Firefox pair", async () => {
    const s = setup(true, false, true);
    s.register.mockRejectedValueOnce(new Error("registration failed"));
    await expect(s.permissions.enable(provider.id)).rejects.toThrow("registration failed");
    expect(s.enabledIds.size).toBe(0);
    s.register.mockResolvedValueOnce({ unregister: s.unregister });
    s.register.mockRejectedValueOnce(new Error("MAIN failed"));
    await expect(s.permissions.enable(provider.id)).rejects.toThrow("MAIN failed");
    expect(s.unregister).toHaveBeenCalledTimes(1);
  });
  it("serializes enabling and revocation so a stale enable cannot win", async () => {
    const s = setup(true);
    const enabling = s.permissions.enable(provider.id);
    const removing = s.permissions.removed({ origins: [provider.origin] });
    await Promise.all([enabling, removing]);
    expect(s.enabledIds.size).toBe(0);
    expect(s.clear).toHaveBeenCalledWith(provider.id);
  });
});


describe("Twitch Extension teardown failures", () => {
  it("unregisters scripts and clears transient state even if disabling cannot be persisted", async () => {
    const s = setup(true);
    await s.permissions.enable(provider.id);
    s.unregisterContentScripts.mockClear();
    s.setEnabled.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(s.permissions.disable(provider.id)).rejects.toThrow("storage unavailable");
    expect(s.unregisterContentScripts).toHaveBeenCalledTimes(1);
    expect(s.clear).toHaveBeenCalledWith(provider.id);
  });
  it("retains partial Firefox handles when the first cleanup fails, allowing a retry", async () => {
    const s = setup(true, false, true);
    s.register.mockResolvedValueOnce({ unregister: s.unregister });
    s.register.mockRejectedValueOnce(new Error("MAIN failed"));
    s.unregister.mockRejectedValueOnce(new Error("temporary unregister failure"));
    await expect(s.permissions.enable(provider.id)).rejects.toThrow("MAIN failed");
    expect(s.unregister).toHaveBeenCalledTimes(2);
    expect(s.enabledIds.size).toBe(0);
  });
});
