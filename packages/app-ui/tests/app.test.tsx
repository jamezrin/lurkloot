import { act } from "react";
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
import {
  DESKTOP_UPDATE_EVENT,
  DESKTOP_UPDATE_PROPERTY,
  INSTALL_UPDATE_FRAGMENT,
} from "../src/desktopHost";
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
  it("declares the CLI host's capabilities", async () => {
    const { adapter } = adapterFor();
    expect(adapter.hostCapabilities).toBe(CLI_HOST_CAPABILITIES);
    expect(CLI_HOST_CAPABILITIES).toEqual({
      tabs: false,
      twitchExtensions: true,
      credentialExport: false,
      extensionPreferences: false,
      language: true,
      activityHistory: true,
    });
    // Nothing that only the extension can do.
    expect(adapter.exportCredentials).toBeUndefined();
    await expect(adapter.requestTwitchExtensionPermission?.("nopixel")).resolves.toBe(true);
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

    // The rail includes Twitch Extension providers and Accounts.
    expect(container.querySelector('[data-rail-group="navExtensions"]')).not.toBeNull();
    expect(container.querySelector('button[data-view="nopixel"]')).not.toBeNull();
    expect(container.querySelector('button[data-view="fortnite"]')).not.toBeNull();
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
    expect(container.querySelector('[id="settings-section-twitch.extensions"]')).not.toBeNull();
    // The language is the app's own, so its picker stays.
    expect(settings).toContain(text("settingsLanguageTitle"));

    // The CLI keeps an activity history (#1088), so Activity is the log, with
    // no diagnostics stream: the CLI keeps diagnostics in its log only.
    await click(container.querySelector('button[data-view="activity"]'));
    expect(container.querySelector("[data-activity-summary]")).toBeNull();
    expect(container.querySelector("[data-activity-view-tab]")).toBeNull();
    expect(container.textContent).not.toContain(text("exportAllDiagnostics"));
  });

  it("pages and clears the CLI's activity history over HTTP", async () => {
    const { container, client } = await mountApp();
    const sent = () =>
      client.calls.map((call) => (call.body as { type?: string } | undefined)?.type);

    await click(container.querySelector('button[data-view="activity"]'));
    await vi.waitFor(() => {
      expect(sent()).toContain("getActivity");
      expect(sent()).toContain("getActivitySessions");
    });
    // The history's sessions and rows, drawn by the popup's own Activity log.
    const sessions = () => container.querySelectorAll("[data-activity-session]");
    await vi.waitFor(() => expect(sessions().length).toBeGreaterThan(0));
    // The open session's point tally, from getActivitySessions.
    expect([...sessions()].map((session) => session.textContent).join(" ")).toContain(
      "RivalsPilot",
    );
    const clear = () =>
      [...container.querySelectorAll("button")].find((button) =>
        [text("clearActivityHistory"), text("confirmClearActivityHistory")].includes(
          button.textContent ?? "",
        ),
      );
    await click(clear());
    await click(clear());
    await vi.waitFor(() => expect(sent()).toContain("clearActivity"));
    await vi.waitFor(() => expect(sessions()).toHaveLength(0));
  });

  it("enables Fortnite from its provider view through the control plane", async () => {
    const { container, client } = await mountApp();
    await click(container.querySelector('button[data-view="fortnite"]'));
    const toggle = () => container.querySelector('[role="switch"][aria-label="Fortnite"]');
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
    await click(toggle());
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    expect(client.calls).toContainEqual({
      method: "POST",
      path: "/v1/session/messages",
      body: { type: "setTwitchExtensionEnabled", provider: "fortnite", enabled: true },
    });
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

describe("desktop app updates (#1028)", () => {
  function report(detail: unknown) {
    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_UPDATE_EVENT, { detail }));
    });
  }

  it("shows nothing until the desktop app reports an update", async () => {
    const { container } = await mountApp();
    expect(container.querySelector("[data-desktop-update]")).toBeNull();
    // A malformed report is ignored.
    report({ status: "ready" });
    report({ status: "elsewhere", version: "2.1.0" });
    expect(container.querySelector("[data-desktop-update]")).toBeNull();
  });

  it("offers the install, and asks the desktop app for it only when clicked", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { container } = await mountApp();
    report({ status: "ready", version: "2.1.0" });
    const bar = container.querySelector('[data-desktop-update="ready"]');
    expect(bar?.textContent).toContain(text("appDesktopUpdateReady").replace("$1", "2.1.0"));
    expect(open).not.toHaveBeenCalled();
    await click(container.querySelector("[data-desktop-update-install]"));
    expect(open).toHaveBeenCalledWith(
      `https://lurkloot.jamezrin.com/guide/headless/desktop#${INSTALL_UPDATE_FRAGMENT}`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("shows an update the desktop app reported before the app mounted", async () => {
    Reflect.set(window, DESKTOP_UPDATE_PROPERTY, { status: "ready", version: "2.1.0" });
    try {
      const { container } = await mountApp();
      expect(container.querySelector('[data-desktop-update="ready"]')).not.toBeNull();
    } finally {
      Reflect.deleteProperty(window, DESKTOP_UPDATE_PROPERTY);
    }
  });

  it("shows the install's progress and a failure that can be tried again", async () => {
    const { container } = await mountApp();
    report({ status: "installing", version: "2.1.0" });
    expect(container.querySelector('[data-desktop-update="installing"]')?.textContent).toContain(
      text("appDesktopUpdateInstalling").replace("$1", "2.1.0"),
    );
    expect(container.querySelector("[data-desktop-update-install]")).toBeNull();
    report({ status: "failed", version: "2.1.0" });
    expect(container.querySelector('[data-desktop-update="failed"]')?.textContent).toContain(
      text("appDesktopUpdateFailed").replace("$1", "2.1.0"),
    );
    expect(container.querySelector("[data-desktop-update-install]")).not.toBeNull();
  });
});
