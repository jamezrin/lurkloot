import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityPage, RuntimeMessage } from "@lurkloot/shared/messages";
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

function setSearchQuery(input: HTMLInputElement, value: string): void {
  input.value = value;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onChange?(event: { target: HTMLInputElement; currentTarget: HTMLInputElement }): void }>)[propsKey]
    : undefined;
  props?.onChange?.({ target: input, currentTarget: input });
}

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

async function mount(): Promise<{ container: HTMLElement; sent: RuntimeMessage[] }> {
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
  const adapter: PopupAdapter = {
    ...demo,
    getStorage: async () => ({ "popup:selectedPlatform": "twitch" }),
    send: async <T,>(message: RuntimeMessage): Promise<T> => {
      sent.push(message);
      if (message.type === "getActivity" && message.category === "diagnostic") {
        const page: ActivityPage = message.cursor
          ? { events: [] }
          : {
              events: [{
                id: "diagnostic-1",
                at: "2026-08-01T12:00:00.000Z",
                category: "diagnostic",
                level: "warn",
                platform: "twitch",
                message: "timeout while fetching inventory",
              }],
              nextCursor: "diagnostic-next",
            };
        return page as T;
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

  return { container, sent };
}

describe("popup diagnostic search requests", () => {
  it("trims the query in the initial diagnostic request", async () => {
    const { container, sent } = await mount();
    sent.splice(0);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error("Missing diagnostics search input");

    act(() => setSearchQuery(input, " timeout "));

    const request = await waitForMessage(sent, (message) =>
      message.type === "getActivity" && message.category === "diagnostic" && message.query != null);
    expect(request).toEqual({
      type: "getActivity",
      platform: "twitch",
      category: "diagnostic",
      query: "timeout",
      limit: 80,
    });
  });

  it("trims the query in a cursor diagnostic request", async () => {
    const { container, sent } = await mount();
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error("Missing diagnostics search input");
    act(() => setSearchQuery(input, " timeout "));
    await waitForMessage(sent, (message) =>
      message.type === "getActivity"
      && message.category === "diagnostic"
      && message.query != null
      && !message.cursor);
    sent.splice(0);

    const loadMore = await waitForElement(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Load more")
      ?? [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "loadMoreActivity"));
    await act(async () => loadMore.click());

    const request = await waitForMessage(sent, (message) =>
      message.type === "getActivity" && message.category === "diagnostic" && message.cursor != null);
    expect(request).toEqual({
      type: "getActivity",
      platform: "twitch",
      category: "diagnostic",
      query: "timeout",
      cursor: "diagnostic-next",
      limit: 80,
    });
  });
});
