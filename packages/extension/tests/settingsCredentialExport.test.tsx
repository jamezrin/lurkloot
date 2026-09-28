import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popup, createDemoPopupAdapter, screenshotVariant } from "@lurkloot/popup-ui";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe("settings credential export", () => {
  it("does not expose the former export action even with a legacy host hook", async () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr" }));
    const container = document.getElementById("app")!;
    const demoAdapter = createDemoPopupAdapter();
    const exportCredentials = vi.fn();
    const adapter = {
      ...demoAdapter,
      getMessage: (key: string) => key === "cliExportButton" ? "Export credentials" : demoAdapter.getMessage(key),
      exportCredentials,
    };

    await act(async () => {
      root = createRoot(container);
      root.render(<Popup adapter={adapter} initialState={{ preview: true, variant: screenshotVariant("settings") }} />);
    });
    await waitForCatalog();

    expect(container.textContent).not.toContain("Export credentials");
    expect(exportCredentials).not.toHaveBeenCalled();
  });
});
