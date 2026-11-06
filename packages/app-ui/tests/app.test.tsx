import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import en from "@lurkloot/locales/messages/en.json";
import {
  CLI_HOST_CAPABILITIES,
  createHttpPopupAdapter,
  LANGUAGE_STORAGE_KEY,
  STORAGE_PREFIX,
} from "../src/adapter";
import { App } from "../src/App";
import { loadAppCatalogs } from "../src/i18n";
import { createTokenPromptBridge } from "../src/tokenPrompt";
import { resetFixture } from "../fixture/controlPlane";
import { fixtureClient } from "./helpers";

const english = en as Record<string, { message: string }>;
const text = (key: string) => english[key]!.message;

let root: Root | undefined;

beforeEach(() => {
  resetFixture();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function adapterFor(client = fixtureClient(), onError = vi.fn()) {
  return {
    client,
    onError,
    adapter: createHttpPopupAdapter({
      client,
      version: "2.0.0",
      storage: localStorage,
      getMessage: () => "",
      uiLanguage: "en-US",
      openLink: vi.fn(),
      onError,
    }),
  };
}

describe("HTTP popup adapter", () => {
  it("declares the CLI host's capabilities", () => {
    const { adapter } = adapterFor();
    expect(adapter.hostCapabilities).toBe(CLI_HOST_CAPABILITIES);
    expect(CLI_HOST_CAPABILITIES).toEqual({
      tabs: false,
      twitchExtensions: false,
      credentialExport: false,
      extensionPreferences: false,
      language: true,
      activityHistory: false,
    });
    // Nothing that only the extension can do.
    expect(adapter.exportCredentials).toBeUndefined();
    expect(adapter.requestTwitchExtensionPermission).toBeUndefined();
    expect(adapter.resetExtension).toBeUndefined();
    expect(adapter.getPendingOnboarding).toBeUndefined();
    expect(adapter.reviewStore).toBeNull();
  });

  it("posts the message to /v1/session/messages and returns its result", async () => {
    const { adapter, client } = adapterFor();
    const snapshot = await adapter.send<RuntimeSnapshot>({ type: "getSnapshot" });
    expect(client.calls).toEqual([
      { method: "POST", path: "/v1/session/messages", body: { type: "getSnapshot" } },
    ]);
    expect(snapshot.state.campaigns.twitch.length).toBeGreaterThan(0);
  });

  it("keeps the language in localStorage, out of the CLI config, and on every snapshot", async () => {
    const { adapter, client } = adapterFor();

    const languageOnly = await adapter.send<RuntimeSnapshot>({
      type: "saveSettings",
      settingsPatch: { languageOverride: "es" },
    });
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("es");
    expect(languageOnly.settings.languageOverride).toBe("es");
    // Nothing left to save: the server is only asked for the snapshot.
    expect(client.calls.at(-1)?.body).toEqual({ type: "getSnapshot" });

    await adapter.send({
      type: "saveSettings",
      settingsPatch: { languageOverride: "fr", autoClaim: false },
    });
    expect(client.calls.at(-1)?.body).toEqual({
      type: "saveSettings",
      settingsPatch: { autoClaim: false },
    });

    const polled = await adapter.send<RuntimeSnapshot>({ type: "tickNow" });
    expect(polled.settings.languageOverride).toBe("fr");
    expect(polled.settings.autoClaim).toBe(false);
  });

  it("reports a refused change with serve's code and paths, and rejects", async () => {
    const { adapter, onError } = adapterFor();
    const message = { type: "saveSettings", settingsPatch: { muteFarmingTabs: false } } as const;
    await expect(adapter.send(message)).rejects.toMatchObject({
      code: "settings_unrepresentable",
      paths: ["muteFarmingTabs"],
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "settings_unrepresentable" }),
      message,
    );
  });

  it("keeps UI preferences under its own prefix in localStorage", async () => {
    const { adapter } = adapterFor();
    await adapter.setStorage({ selectedPlatform: "kick" });
    expect(localStorage.getItem(`${STORAGE_PREFIX}selectedPlatform`)).toBe('"kick"');
    await expect(adapter.getStorage("selectedPlatform")).resolves.toEqual({
      selectedPlatform: "kick",
    });
    await expect(adapter.getStorage("missing")).resolves.toEqual({});
  });
});

async function mountApp(client = fixtureClient()) {
  document.body.innerHTML = '<div id="root"></div>';
  const tokens = createTokenPromptBridge();
  const catalogs = await loadAppCatalogs("browser", "en-US");
  const container = document.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <App
        client={client}
        subscribeTokenRequests={tokens.subscribe}
        initialCatalogs={catalogs}
        storage={localStorage}
        uiLanguage="en-US"
      />,
    );
  });
  await vi.waitFor(() => expect(container.querySelector("main[data-frame=window]")).not.toBeNull());
  await vi.waitFor(() =>
    expect(container.querySelector('button[data-view="queue"]')).not.toBeNull(),
  );
  return { container, client };
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element missing");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

describe("app over the control plane", () => {
  it("shows no extension-only control anywhere", async () => {
    const { container } = await mountApp();

    // The rail: no Twitch Extension providers; Accounts is there.
    expect(container.querySelector('[data-rail-group="navExtensions"]')).toBeNull();
    expect(container.querySelector('button[data-view="nopixel"]')).toBeNull();
    expect(container.querySelector('button[data-view="fortnite"]')).toBeNull();
    expect(container.querySelector('button[data-host-view="accounts"]')).not.toBeNull();
    // No tips, rate or star nudges, update notice or onboarding tour.
    expect(container.textContent).not.toContain(text("rateNudgeTitle"));

    await click(container.querySelector('button[data-view="settings"]'));
    await vi.waitFor(() =>
      expect(container.querySelector('[id="settings-section-general.drops"]')).not.toBeNull(),
    );
    const settings = container.textContent ?? "";
    for (const key of [
      "tablessTitle",
      "autoCloseTabsTitle",
      "muteTabsTitle",
      "keepVideosUnmutedTitle",
      "adFocusTitle",
      "pauseManualTitle",
      "autoStartTitle",
      "hideTipsTitle",
      "inPagePanelTitle",
      "diagnosticLoggingTitle",
      "cliExportButton",
      "cliExportTitle",
    ]) {
      expect(settings, key).not.toContain(text(key));
    }
    expect(container.querySelector('[id="settings-section-general.farmingTabs"]')).toBeNull();
    expect(container.querySelector('[id="settings-section-twitch.extensions"]')).toBeNull();
    // The language is the app's own, so its picker stays.
    expect(settings).toContain(text("settingsLanguageTitle"));

    await click(container.querySelector('button[data-view="activity"]'));
    expect(container.querySelector("[data-activity-summary]")).not.toBeNull();
  });

  it("polls the snapshot over HTTP at the popup's five-second cadence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { client } = await mountApp();
    const snapshots = () =>
      client.calls.filter(
        (call) => (call.body as { type?: string } | undefined)?.type === "getSnapshot",
      ).length;
    const before = snapshots();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await vi.waitFor(() => expect(snapshots()).toBe(before + 1));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await vi.waitFor(() => expect(snapshots()).toBe(before + 2));
  });

  it("opens Accounts from the status line's Sign in action", async () => {
    const { container } = await mountApp();
    // The fixture leaves Kick signed out.
    await click(container.querySelector('[role="tab"][aria-label="Kick"]'));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-auth-action="kick"]')).not.toBeNull(),
    );
    await click(container.querySelector('[data-auth-action="kick"]'));
    await vi.waitFor(() => expect(container.querySelector("[data-accounts]")).not.toBeNull());
  });
});
