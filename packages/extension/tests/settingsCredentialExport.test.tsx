import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popup, createDemoPopupAdapter, screenshotVariant, type PopupAdapter } from "@lurkloot/popup-ui";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));

const labels: Record<string, string> = {
  openSettings: "Open settings",
  back: "Back",
  settingsSearchPlaceholder: "Search settings…",
  settingsShowAdvancedTitle: "Show advanced settings",
  cliExportHint: "Keep the exported session credentials private.",
  cliExportConfirm: "Anyone with this file can use your sessions.",
  cliExportButton: "Export credentials",
  cliExportCancel: "Cancel",
  cliExportConfirmButton: "Confirm export",
};

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mount() {
  const { document, window } = parseHTML("<div id=app></div>");
  const confirm = vi.fn();
  const exportCredentials = vi.fn();
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
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
    exportCredentials,
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} initialState={{ preview: true, variant: screenshotVariant("settings") }} />);
  });
  await waitForCatalog();
  return { confirm, container, exportCredentials };
}

function byText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

function byLabel(container: Element, label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button label: ${label}`);
  return button as HTMLButtonElement;
}

function openSettings(container: Element): void {
  act(() => byLabel(container, "Open settings").click());
}

describe("settings credential export", () => {
  it("requires an inline confirmation and supports explicit cancellation", async () => {
    const { confirm, container, exportCredentials } = await mount();

    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");

    act(() => byText(container, "Export credentials").click());
    expect(container.textContent).toContain("Anyone with this file can use your sessions.");
    expect(container.textContent).toContain("Cancel");
    expect(container.textContent).toContain("Confirm export");
    expect(exportCredentials).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    act(() => byText(container, "Cancel").click());
    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(exportCredentials).not.toHaveBeenCalled();

    act(() => byText(container, "Export credentials").click());
    await act(async () => byText(container, "Confirm export").click());
    expect(exportCredentials).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cancels an armed export after Back followed by immediate reopen", async () => {
    const { container, exportCredentials } = await mount();

    act(() => byText(container, "Export credentials").click());
    expect(container.textContent).toContain("Confirm export");

    act(() => byLabel(container, "Back").click());
    openSettings(container);

    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(exportCredentials).not.toHaveBeenCalled();
  });
});
