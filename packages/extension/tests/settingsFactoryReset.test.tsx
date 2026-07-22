import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popup, createDemoPopupAdapter, screenshotVariant, type PopupAdapter } from "@lurkloot/popup-ui";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";

const labels: Record<string, string> = {
  openSettings: "Open settings",
  back: "Back",
  settingsSearchPlaceholder: "Search settings…",
  settingsShowAdvancedTitle: "Show advanced settings",
  factoryResetTitle: "Reset Lurkloot",
  factoryResetHint: "Erase all Lurkloot data. Your accounts stay signed in.",
  factoryResetButton: "Reset Lurkloot",
  factoryResetConfirm: "This permanently erases all Lurkloot data.",
  factoryResetCancel: "Cancel",
  factoryResetConfirmButton: "Reset everything",
  factoryResetProgress: "Resetting…",
  factoryResetFailed: "Lurkloot couldn't reset completely. Try again.",
  factoryResetRetry: "Try reset again",
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mount(resetExtension?: () => Promise<RuntimeSnapshot>) {
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
    resetExtension,
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} initialState={{ preview: true, variant: screenshotVariant("settings") }} />);
    await Promise.resolve();
  });
  return { container };
}

function byText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

describe("settings factory reset", () => {
  it("is hidden when the host does not expose reset capability", async () => {
    const { container } = await mount();

    expect(container.textContent).not.toContain("Reset Lurkloot");
  });

  it("requires confirmation and blocks duplicate reset requests", async () => {
    let finish!: (snapshot: RuntimeSnapshot) => void;
    const resetExtension = vi.fn(() => new Promise<RuntimeSnapshot>((resolve) => { finish = resolve; }));
    const { container } = await mount(resetExtension);

    act(() => byText(container, "Reset Lurkloot").click());
    expect(resetExtension).not.toHaveBeenCalled();

    await act(async () => {
      byText(container, "Reset everything").click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Resetting…");
    act(() => byText(container, "Resetting…").click());
    expect(resetExtension).toHaveBeenCalledOnce();

    await act(async () => finish(await createDemoPopupAdapter().send({ type: "getSnapshot" })));
    expect(container.querySelector('button[aria-label="Open settings"]')).not.toBeNull();
  });

  it("shows a retryable alert when reset fails", async () => {
    const freshSnapshot = await createDemoPopupAdapter().send<RuntimeSnapshot>({ type: "getSnapshot" });
    const resetExtension = vi.fn()
      .mockRejectedValueOnce(new Error("reset failed"))
      .mockResolvedValueOnce({ ...freshSnapshot, settings: DEFAULT_SETTINGS });
    const { container } = await mount(resetExtension);

    act(() => byText(container, "Reset Lurkloot").click());
    await act(async () => byText(container, "Reset everything").click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't reset");
    await act(async () => byText(container, "Try reset again").click());
    expect(resetExtension).toHaveBeenCalledTimes(2);
    expect(container.querySelector('button[aria-label="Open settings"]')).not.toBeNull();
  });
});
