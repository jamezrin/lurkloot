import { describe, expect, it, vi } from "vitest";
import { createProviderPermissions } from "../src/extensions/permissions";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

const provider = twitchExtensionProviders[0];
function setup(grant = true) {
  const enabled = new Set<string>();
  const request = vi.fn(async () => grant);
  const contains = vi.fn(async () => grant);
  const start = vi.fn(async () => {});
  const stop = vi.fn();
  const clear = vi.fn(async () => {});
  const setEnabled = vi.fn(async (id: string, value: boolean) => { if (value) enabled.add(id); else enabled.delete(id); });
  const permissions = createProviderPermissions({
    permissions: { request, contains }, runtime: { start, stop },
    enabled: async (id) => enabled.has(id), setEnabled, clearTransientState: clear,
  });
  return { permissions, enabled, request, contains, start, stop, clear, setEnabled };
}
describe("tabless provider backend permissions", () => {
  it("requests the backend synchronously and denial leaves the provider off", async () => {
    const s = setup(false);
    const pending = s.permissions.enable(provider.id);
    expect(s.request).toHaveBeenCalledExactlyOnceWith({ origins: [provider.backendOrigin] });
    expect(await pending).toBe(false);
    expect(s.start).not.toHaveBeenCalled();
    expect(s.enabled.size).toBe(0);
  });
  it("starts only after verifying a granted backend", async () => {
    const s = setup();
    expect(await s.permissions.enable(provider.id)).toBe(true);
    expect(s.contains).toHaveBeenCalledWith({ origins: [provider.backendOrigin] });
    expect(s.start).toHaveBeenCalledExactlyOnceWith(provider);
    expect(s.enabled.has(provider.id)).toBe(true);
  });
  it("does not start after a grant disappears", async () => {
    const s = setup();
    s.contains.mockResolvedValue(false);
    expect(await s.permissions.enable(provider.id)).toBe(false);
    expect(s.start).not.toHaveBeenCalled();
  });
  it("revocation stops resources immediately and disables only its provider", async () => {
    const s = setup();
    await s.permissions.enable(provider.id);
    s.stop.mockClear();
    const removing = s.permissions.removed({ origins: [provider.backendOrigin] });
    expect(s.stop).toHaveBeenCalledWith(provider);
    await removing;
    expect(s.enabled.has(provider.id)).toBe(false);
    expect(s.clear).toHaveBeenCalledExactlyOnceWith(provider.id);
    expect(s.stop.mock.calls.every(([value]) => value.id === provider.id)).toBe(true);
  });
  it("starts nothing with every provider disabled", async () => {
    const s = setup();
    await s.permissions.reconcile();
    expect(s.start).not.toHaveBeenCalled();
  });
  it("disables stored settings when the startup grant vanished", async () => {
    const s = setup(false);
    s.enabled.add(provider.id);
    await s.permissions.reconcile();
    expect(s.enabled.has(provider.id)).toBe(false);
    expect(s.start).not.toHaveBeenCalled();
  });
  it("cleans up even when disabling cannot be persisted", async () => {
    const s = setup();
    s.setEnabled.mockRejectedValue(new Error("storage unavailable"));
    await expect(s.permissions.disable(provider.id)).rejects.toThrow("storage unavailable");
    expect(s.stop).toHaveBeenCalledWith(provider);
    expect(s.clear).toHaveBeenCalledWith(provider.id);
  });
  it("rolls back failed runtime initialization", async () => {
    const s = setup();
    s.start.mockRejectedValue(new Error("initialization failed"));
    await expect(s.permissions.enable(provider.id)).rejects.toThrow("initialization failed");
    expect(s.enabled.has(provider.id)).toBe(false);
    expect(s.stop).toHaveBeenCalledWith(provider);
    expect(s.clear).toHaveBeenCalledWith(provider.id);
  });
});


it("a delayed grant cannot restart a provider after disable", async () => {
  const s = setup();
  let resolve!: (value: boolean) => void;
  s.request.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
  const enabling = s.permissions.enable(provider.id);
  const disabling = s.permissions.disable(provider.id);
  resolve(true);
  expect(await enabling).toBe(false);
  await disabling;
  expect(s.start).not.toHaveBeenCalled();
  expect(s.enabled.size).toBe(0);
});


it.each(["enable", "reconcile"] as const)("%s cannot restart after revocation during grant verification", async (operation) => {
  const s = setup();
  s.enabled.add(provider.id);
  let resolve!: (value: boolean) => void;
  let reached!: () => void;
  const checking = new Promise<void>((done) => { reached = done; });
  s.contains.mockImplementation(() => { reached(); return new Promise<boolean>((done) => { resolve = done; }); });
  const pending = operation === "enable" ? s.permissions.enable(provider.id) : s.permissions.reconcile();
  await checking;
  const removing = s.permissions.removed({ origins: [provider.backendOrigin] });
  resolve(true);
  await pending;
  await removing;
  expect(s.start).not.toHaveBeenCalled();
  expect(s.enabled.has(provider.id)).toBe(false);
});
