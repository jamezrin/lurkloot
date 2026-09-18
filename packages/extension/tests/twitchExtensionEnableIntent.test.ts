import { describe, expect, it, vi } from "vitest";
import { createTwitchExtensionGrantCompletion, requestTwitchExtensionGrant } from "../src/extensions/grantCompletion";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

function setup() {
  const values: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (next: Record<string, unknown>) => { Object.assign(values, next); },
    remove: async (key: string) => { delete values[key]; },
  };
  const enable = vi.fn(async () => {});
  const contains = vi.fn(async () => true);
  const completion = createTwitchExtensionGrantCompletion({ storage, now: () => 1_000, enable, contains });
  return { values, storage, enable, completion, contains };
}
describe("provider enable completion after popup permission prompt", () => {
  it("finishes a requested grant without a popup continuation and consumes it once", async () => {
    const s = setup();
    let resolve!: (granted: boolean) => void;
    const request = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const pending = requestTwitchExtensionGrant({ storage: s.storage, request, now: () => 1_000 }, "nopixel");
    expect(request).toHaveBeenCalledOnce();
    await s.completion.added({ origins: [twitchExtensionProviders[0].backendOrigin] });
    expect(s.enable).toHaveBeenCalledExactlyOnceWith("nopixel");
    await s.completion.added({ origins: [twitchExtensionProviders[0].backendOrigin] });
    expect(s.enable).toHaveBeenCalledOnce();
    resolve(true); await pending;
  });
  it("never enables an unsolicited or denied grant", async () => {
    const s = setup(); const origins = [twitchExtensionProviders[0].backendOrigin];
    await s.completion.added({ origins }); expect(s.enable).not.toHaveBeenCalled();
    await requestTwitchExtensionGrant({ storage: s.storage, request: async () => false, now: () => 1_000 }, "nopixel");
    await s.completion.added({ origins }); expect(s.enable).not.toHaveBeenCalled();
  });
  it("expires old intents and cancels an intent before a later grant", async () => {
    const s = setup();
    await requestTwitchExtensionGrant({ storage: s.storage, request: async () => true, now: () => -200_000 }, "nopixel");
    await s.completion.added({ origins: [twitchExtensionProviders[0].backendOrigin] }); expect(s.enable).not.toHaveBeenCalled();
    await requestTwitchExtensionGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, "fortnite");
    await s.completion.cancel("fortnite");
    await s.completion.added({ origins: [twitchExtensionProviders[1].backendOrigin] }); expect(s.enable).not.toHaveBeenCalled();
  });
});

it("finishes when a delayed intent write arrives after onAdded", async () => {
  const s = setup();
  let finish!: () => void;
  s.storage.set = async next => { await new Promise<void>(done => { finish = done; }); Object.assign(s.values, next); };
  const pending = requestTwitchExtensionGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, "nopixel");
  await s.completion.added({ origins: [twitchExtensionProviders[0].backendOrigin] });
  expect(s.enable).not.toHaveBeenCalled();
  finish(); await pending;
  await s.completion.changed({ "twitchExtensionEnableIntent.nopixel": { newValue: 1_000 } });
  expect(s.enable).toHaveBeenCalledExactlyOnceWith("nopixel");
});
it("does not consume an intent write until the grant exists", async () => {
  const s = setup(); s.contains.mockResolvedValue(false);
  await requestTwitchExtensionGrant({ storage: s.storage, request: async () => true, now: () => 1_000 }, "nopixel");
  await s.completion.changed({ "twitchExtensionEnableIntent.nopixel": { newValue: 1_000 } });
  expect(s.enable).not.toHaveBeenCalled();
  s.contains.mockResolvedValue(true);
  await s.completion.added({ origins: [twitchExtensionProviders[0].backendOrigin] });
  expect(s.enable).toHaveBeenCalledOnce();
});
it("rejects a cancelled popup write that arrives late", async () => {
  const s = setup();
  await s.completion.cancelAll();
  await s.storage.set({ "twitchExtensionEnableIntent.nopixel": 999 });
  await s.completion.changed({ "twitchExtensionEnableIntent.nopixel": { newValue: 999 } });
  expect(s.enable).not.toHaveBeenCalled();
});
