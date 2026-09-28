import { describe, expect, it } from "vitest";
import { KickPageContextRecoveryTracker } from "@lurkloot/core/kick";
import {
  createTabRegistry,
  currentManagedPageContextTabs,
  recordManagedPageContextFallback,
  registerManagedPageContextTabs,
  tabClosureOrigin,
} from "@lurkloot/core/tabRegistry";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { createExtensionTabPorts } from "../src/core/tabPorts";
import { FakeBrowser } from "./helpers/fakeBrowser";

const ignore = () => undefined;

// Page-context recovery through the extension's PageContextPort (#598): the
// port holds the route evidence, applies the configured threshold and runs the
// registry's recovery rule against the browser.
async function retainedKickContext(requiredSuccesses: number, loadSettings?: () => Promise<typeof DEFAULT_SETTINGS>) {
  const browser = new FakeBrowser();
  const registry = createTabRegistry();
  const evidence = new KickPageContextRecoveryTracker();
  const settings = { ...DEFAULT_SETTINGS, kickPageContextRecoverySuccesses: requiredSuccesses };
  const ports = createExtensionTabPorts(registry, browser, loadSettings ?? (async () => settings), { kick: evidence });
  const tab = await browser.tabs.create({ url: "https://kick.com/drops/inventory" });
  registerManagedPageContextTabs(registry, {
    kick: { platform: "kick", tabId: tab.id, originUrl: "https://kick.com", origin: "https://kick.com", ownedByExtension: true },
  });
  recordManagedPageContextFallback(registry, "kick", "web.kick.com");
  return { browser, registry, evidence, ports, tabId: tab.id };
}

describe("extension page-context recovery port", () => {
  it("closes the retained Kick page context after the configured number of direct cycles", async () => {
    const { browser, registry, evidence, ports, tabId } = await retainedKickContext(2);

    evidence.recordBackgroundSuccess("web.kick.com");
    await ports.pageContexts.recover("kick", { countBackgroundSuccess: true }, ignore);
    expect(browser.has(tabId)).toBe(true);

    evidence.recordBackgroundSuccess("web.kick.com");
    expect(await ports.pageContexts.recover("kick", { countBackgroundSuccess: true }, ignore)).toBe(true);
    expect(browser.has(tabId)).toBe(false);
    expect(tabClosureOrigin(registry, tabId)).toBe("extension-recovery");
    expect(currentManagedPageContextTabs(registry).kick).toBeUndefined();
  });

  it("does not count direct successes from a cycle that did not complete", async () => {
    const { browser, evidence, ports, tabId } = await retainedKickContext(1);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      evidence.recordBackgroundSuccess("web.kick.com");
      await ports.pageContexts.recover("kick", { countBackgroundSuccess: false }, ignore);
    }

    expect(browser.has(tabId)).toBe(true);
  });

  it("keeps a cycle's evidence for the next one when recovery fails", async () => {
    let failSettings = true;
    const settings = { ...DEFAULT_SETTINGS, kickPageContextRecoverySuccesses: 1 };
    const { browser, evidence, ports, tabId } = await retainedKickContext(1, async () => {
      if (failSettings) throw new Error("settings unavailable");
      return settings;
    });

    evidence.recordBackgroundSuccess("web.kick.com");
    await expect(ports.pageContexts.recover("kick", { countBackgroundSuccess: true }, ignore)).rejects.toThrow("settings unavailable");
    expect(browser.has(tabId)).toBe(true);

    failSettings = false;
    expect(await ports.pageContexts.recover("kick", { countBackgroundSuccess: true }, ignore)).toBe(true);
    expect(browser.has(tabId)).toBe(false);
  });

  it("drops discarded evidence, and has nothing to recover for a platform without evidence", async () => {
    const { browser, evidence, ports, tabId } = await retainedKickContext(1);

    evidence.recordBackgroundSuccess("web.kick.com");
    ports.pageContexts.discardRecoveryEvidence("kick");
    expect(await ports.pageContexts.recover("kick", { countBackgroundSuccess: true }, ignore)).toBe(false);
    expect(await ports.pageContexts.recover("twitch", { countBackgroundSuccess: true }, ignore)).toBe(false);
    expect(() => ports.pageContexts.discardRecoveryEvidence("twitch")).not.toThrow();
    expect(browser.has(tabId)).toBe(true);
  });
});
