import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popup, createDemoPopupAdapter, screenshotVariant, type PopupAdapter } from "@lurkloot/popup-ui";
import { buildSettingsExportPayload } from "@lurkloot/shared/settingsExport";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));

const labels: Record<string, string> = {
  openSettings: "Open settings",
  back: "Back",
  settingsSearchPlaceholder: "Search settings…",
  settingsShowAdvancedTitle: "Show advanced settings",
  settingsExportHint: "Save your settings to a file.",
  settingsExportButton: "Export settings",
  settingsImportButton: "Import settings",
  settingsImportConfirm: "This replaces your current settings.",
  settingsImportCancel: "Cancel",
  settingsImportConfirmButton: "Choose file and import",
  settingsImportFailed: "That file isn't a valid Lurkloot settings export.",
};

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mount(overrides: Partial<PopupAdapter> = {}) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr" }));
  const container = document.getElementById("app")!;
  const demoAdapter = createDemoPopupAdapter();
  const adapter: PopupAdapter = {
    ...demoAdapter,
    getMessage: (key) => labels[key] ?? demoAdapter.getMessage(key),
    exportSettings: vi.fn(),
    importSettings: vi.fn(),
    ...overrides,
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} initialState={{ preview: true, variant: screenshotVariant("settings") }} />);
  });
  await waitForCatalog();
  return { container, exportSettings: adapter.exportSettings as ReturnType<typeof vi.fn>, importSettings: adapter.importSettings as ReturnType<typeof vi.fn> };
}

function byText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

describe("settings export/import", () => {
  it("exports the current settings without a confirmation step", async () => {
    const { container, exportSettings } = await mount();

    expect(container.textContent).toContain("Export settings");
    act(() => byText(container, "Export settings").click());

    expect(exportSettings).toHaveBeenCalledTimes(1);
    const payload = exportSettings.mock.calls[0][0];
    expect(payload.kind).toBe(buildSettingsExportPayload(DEFAULT_SETTINGS).kind);
    expect(payload.settings).toBeDefined();
  });

  it("requires arm-then-confirm before importing, and cancel does not call the adapter", async () => {
    const { container, importSettings } = await mount();

    expect(container.textContent).not.toContain("Choose file and import");
    act(() => byText(container, "Import settings").click());
    expect(container.textContent).toContain("This replaces your current settings.");
    expect(importSettings).not.toHaveBeenCalled();

    act(() => byText(container, "Cancel").click());
    expect(container.textContent).not.toContain("Choose file and import");
    expect(importSettings).not.toHaveBeenCalled();
  });

  it("applies an imported settings payload on confirm", async () => {
    const imported = buildSettingsExportPayload({
      ...DEFAULT_SETTINGS,
      platform: { ...DEFAULT_SETTINGS.platform, twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true } },
    });
    const { container, importSettings } = await mount({
      importSettings: vi.fn().mockResolvedValue(imported),
    });

    act(() => byText(container, "Import settings").click());
    await act(async () => byText(container, "Choose file and import").click());

    expect(importSettings).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("This replaces your current settings.");
    expect(container.textContent).not.toContain("That file isn't a valid Lurkloot settings export.");
  });

  it("shows a failure message when the selected file is not a valid export", async () => {
    const { container } = await mount({
      importSettings: vi.fn().mockResolvedValue({ not: "a settings export" }),
    });

    act(() => byText(container, "Import settings").click());
    await act(async () => byText(container, "Choose file and import").click());

    expect(container.textContent).toContain("That file isn't a valid Lurkloot settings export.");
  });

  it("does not call the adapter when the user cancels the file picker", async () => {
    const { container } = await mount({
      importSettings: vi.fn().mockResolvedValue(null),
    });

    act(() => byText(container, "Import settings").click());
    await act(async () => byText(container, "Choose file and import").click());

    expect(container.textContent).toContain("This replaces your current settings.");
    expect(container.textContent).not.toContain("That file isn't a valid Lurkloot settings export.");
  });
});
