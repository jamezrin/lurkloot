import { beforeEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({
  runtime: {
    getManifest: vi.fn(() => ({ version: "1.8.0" })),
    sendMessage: vi.fn(),
    connect: vi.fn(),
  },
  storage: { local: { get: vi.fn(), set: vi.fn() } },
  i18n: { getMessage: vi.fn((key: string) => key), getUILanguage: vi.fn(() => "en") },
  tabs: { create: vi.fn() },
  permissions: { contains: vi.fn(), request: vi.fn() },
}));

vi.mock("wxt/browser", () => ({ browser }));

import { createExtensionPopupAdapter } from "../entrypoints/popup/app";

describe("extension popup platform host access", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["twitch", "https://*.twitch.tv/*"],
    ["kick", "https://*.kick.com/*"],
  ] as const)("checks only the %s wildcard", async (platform, origin) => {
    browser.permissions.contains.mockResolvedValue(true);

    await expect(createExtensionPopupAdapter().getPlatformHostAccess?.(platform)).resolves.toBe(true);

    expect(browser.permissions.contains).toHaveBeenCalledWith({ origins: [origin] });
  });

  it.each([
    ["twitch", "https://*.twitch.tv/*"],
    ["kick", "https://*.kick.com/*"],
  ] as const)("requests only the %s wildcard", async (platform, origin) => {
    browser.permissions.request.mockResolvedValue(false);

    await expect(createExtensionPopupAdapter().requestPlatformHostAccess?.(platform)).resolves.toBe(false);

    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: [origin] });
  });
});
