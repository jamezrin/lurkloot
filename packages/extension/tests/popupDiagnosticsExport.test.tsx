import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsExport, RuntimeMessage } from "@lurkloot/shared/messages";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function waitForMessage(
  sent: RuntimeMessage[],
  predicate: (message: RuntimeMessage) => boolean,
): Promise<RuntimeMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = sent.find(predicate);
    if (message) return message;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Popup did not send the expected message");
}

async function waitForElement<T extends Element>(find: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const element = find();
    if (element) return element;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("Popup did not render the expected element");
}

async function mount(options?: {
  downloadFile?: (filename: string, contents: string, mimeType?: string) => void;
  pendingExport?: { finish?: (value: DiagnosticsExport) => void };
}): Promise<{ container: HTMLElement; sent: RuntimeMessage[]; downloadFile: ReturnType<typeof vi.fn> }> {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(Date.now());
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));

  const demo = createDemoPopupAdapter();
  const sent: RuntimeMessage[] = [];
  const downloadFile = options?.downloadFile ?? vi.fn();
  const adapter: PopupAdapter = {
    ...demo,
    downloadFile,
    getStorage: async () => ({ "popup:selectedPlatform": "twitch" }),
    send: async <T,>(message: RuntimeMessage): Promise<T> => {
      sent.push(message);
      if (message.type === "exportDiagnostics") {
        if (options?.pendingExport) {
          return await new Promise<DiagnosticsExport>((resolve) => {
            options.pendingExport!.finish = resolve;
          }) as T;
        }
        return {
          events: [{
            id: "d1",
            at: "2026-08-16T00:00:00.000Z",
            category: "diagnostic",
            level: "info",
            platform: "twitch",
            message: "full history line",
          }],
        } as T;
      }
      return demo.send<T>(message);
    },
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
  });
  await waitForCatalog();
  const openActivity = container.querySelector<HTMLButtonElement>('button[aria-label="Open activity"]');
  if (!openActivity) throw new Error("Missing activity button");
  await act(async () => openActivity.click());
  const diagnosticsTab = await waitForElement(() =>
    container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]') ?? undefined);
  await act(async () => diagnosticsTab.click());
  return { container, sent, downloadFile: downloadFile as ReturnType<typeof vi.fn> };
}

describe("popup diagnostics export", () => {
  it("requests a full diagnostics export for the selected platform and downloads a .log", async () => {
    const { container, sent, downloadFile } = await mount();
    const exportAll = await waitForElement(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Export all"));
    await act(async () => exportAll.click());
    const request = await waitForMessage(sent, (message) => message.type === "exportDiagnostics");
    expect(request).toEqual({ type: "exportDiagnostics", platform: "twitch" });
    expect(downloadFile).toHaveBeenCalledOnce();
    const [filename, contents, mimeType] = downloadFile.mock.calls[0];
    expect(filename).toMatch(/^lurkloot-diagnostics-twitch-\d{8}T\d{6}Z\.log$/);
    expect(contents).toContain("coverage: full");
    expect(contents).toContain("full history line");
    expect(mimeType).toBe("text/plain");
  });

  it("does not download a stale export after the platform changes", async () => {
    const pendingExport: { finish?: (value: DiagnosticsExport) => void } = {};
    const { container, downloadFile } = await mount({ pendingExport });
    const exportAll = await waitForElement(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Export all"));
    await act(async () => exportAll.click());
    const back = await waitForElement(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Back"]') ?? undefined);
    await act(async () => back.click());
    const kick = await waitForElement(() =>
      container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]') ?? undefined);
    await act(async () => kick.click());
    await act(async () => {
      pendingExport.finish?.({
        events: [{
          id: "late",
          at: "2026-08-16T00:00:00.000Z",
          category: "diagnostic",
          level: "info",
          message: "late",
        }],
      });
    });
    expect(downloadFile).not.toHaveBeenCalled();
  });
});
