import { describe, expect, it, vi } from "vitest";
import { changeTwitchExtensionEnabled } from "../../popup-ui/src/twitchExtensions";
import type { PopupAdapter } from "../../popup-ui/src/types";
describe("extension opt-in from popup", () => {
  it("requests the exact provider grant synchronously before sending enable", async () => {
    let resolve!: (value: boolean) => void;
    const requestTwitchExtensionPermission = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const send = vi.fn(async () => ({ enabled: true }));
    const pending = changeTwitchExtensionEnabled({ requestTwitchExtensionPermission, send } as unknown as PopupAdapter, "fortnite", true);
    expect(requestTwitchExtensionPermission).toHaveBeenCalledExactlyOnceWith("fortnite"); expect(send).not.toHaveBeenCalled();
    resolve(true); expect(await pending).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: "setTwitchExtensionEnabled", provider: "fortnite", enabled: true });
  });
  it("keeps denied permissions off and disables without prompting", async () => {
    const requestTwitchExtensionPermission = vi.fn(async () => false), send = vi.fn(async () => ({ enabled: false }));
    const adapter = { requestTwitchExtensionPermission, send } as unknown as PopupAdapter;
    expect(await changeTwitchExtensionEnabled(adapter, "nopixel", true)).toBe(false); expect(send).not.toHaveBeenCalled();
    expect(await changeTwitchExtensionEnabled(adapter, "nopixel", false)).toBe(false); expect(send).toHaveBeenCalledOnce(); expect(requestTwitchExtensionPermission).toHaveBeenCalledOnce();
  });
});
