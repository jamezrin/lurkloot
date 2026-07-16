import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { SettingsView } from "../../popup-ui/src/settings";
import type { PopupAdapter } from "../../popup-ui/src/types";

const labels: Record<string, string> = {
  cliExportTitle: "Headless CLI",
  cliExportDescription: "Use this browser session with the CLI.",
  cliExportHint: "Keep the exported session credentials private.",
  cliExportConfirm: "Anyone with this file can use your sessions.",
  cliExportButton: "Export credentials",
  cliExportCancel: "Cancel",
  cliExportConfirmButton: "Confirm export",
};

let root: Root | undefined;

const adapter: PopupAdapter = {
  version: "test",
  send: async () => undefined as never,
  getStorage: async () => ({}),
  setStorage: async () => undefined,
  getMessage: (key) => key,
  getUiLanguage: () => "en",
  openLink: () => undefined,
};

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function renderSettings(onExportCredentials: () => void): void {
  act(() => {
    root?.render(
      <PopupRuntimeContext.Provider value={{ adapter, preview: true }}>
        <I18nContext.Provider value={{ t: (key) => labels[key] ?? key, dir: "ltr", locale: "en" }}>
          <SettingsView
            suggestions={{ twitch: [], kick: [] }}
            onSearchCategories={async () => []}
            settings={DEFAULT_SETTINGS}
            onSettingsChange={async () => undefined}
            onExportCredentials={onExportCredentials}
          />
        </I18nContext.Provider>
      </PopupRuntimeContext.Provider>,
    );
  });
}

function mount(onExportCredentials = vi.fn()) {
  const { document, window } = parseHTML("<div id=app></div>");
  const confirm = vi.fn();
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  root = createRoot(container);
  renderSettings(onExportCredentials);
  return { confirm, container, onExportCredentials };
}

function byText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

function openCliSection(container: Element): void {
  act(() => byText(container, "Headless CLI").click());
}

describe("settings credential export", () => {
  it("requires an inline confirmation and supports explicit cancellation", () => {
    const { confirm, container, onExportCredentials } = mount();
    openCliSection(container);

    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");

    act(() => byText(container, "Export credentials").click());
    expect(container.textContent).toContain("Anyone with this file can use your sessions.");
    expect(container.textContent).toContain("Cancel");
    expect(container.textContent).toContain("Confirm export");
    expect(onExportCredentials).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    act(() => byText(container, "Cancel").click());
    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(onExportCredentials).not.toHaveBeenCalled();

    act(() => byText(container, "Export credentials").click());
    act(() => byText(container, "Confirm export").click());
    expect(onExportCredentials).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cancels an armed export when Settings unmounts", () => {
    const { container, onExportCredentials } = mount();
    openCliSection(container);

    act(() => byText(container, "Export credentials").click());
    expect(container.textContent).toContain("Confirm export");

    act(() => root?.render(<div>Outside settings</div>));
    renderSettings(onExportCredentials);
    openCliSection(container);

    expect(container.textContent).toContain("Export credentials");
    expect(container.textContent).not.toContain("Confirm export");
    expect(onExportCredentials).not.toHaveBeenCalled();
  });
});
