import { parseHTML } from "linkedom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, unknown>();

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://test${path}`,
      sendMessage: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (storage.has(key)) out[key] = storage.get(key);
          return out;
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
  },
}));

const { mountInPagePanel } = await import("../src/core/inPagePanel");
const { IN_PAGE_PANEL_DOM_KEY } = await import("../src/core/inPagePanelDom");

beforeAll(() => {
  const view = parseHTML("<!DOCTYPE html><html><body></body></html>");
  Object.assign(globalThis, {
    window: view,
    document: view.document,
    MutationObserver: view.MutationObserver,
    HTMLElement: view.HTMLElement,
    HTMLButtonElement: view.HTMLButtonElement,
    HTMLDivElement: view.HTMLDivElement,
    HTMLIFrameElement: view.HTMLIFrameElement,
  });
});

describe("in-page panel chrome", () => {
  beforeEach(() => {
    storage.clear();
    document.body.innerHTML = `<header class="top-nav__menu"><div class="top-nav__prime"></div></header>`;
    storage.set("settings", { showInPagePanel: true });
    storage.set("schedulerState", { managedWatchTabs: {}, managedPageContextTabs: {} });
  });

  it("injects an icon-only button with opaque ids and no lurkloot DOM ids", async () => {
    mountInPagePanel("twitch");
    // mount kicks async reconcile — wait a turn
    await vi.waitFor(() => {
      expect(document.querySelector("button")).not.toBeNull();
    });

    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent?.replace(/\s+/g, "").toLowerCase()).not.toContain("lurkloot");
    expect(button!.querySelector("svg")).not.toBeNull();
    expect(button!.id.toLowerCase()).not.toContain("lurkloot");
    expect(document.getElementById("lurkloot-nav-button")).toBeNull();

    const tokens = storage.get(IN_PAGE_PANEL_DOM_KEY) as { buttonId: string; panelId: string };
    expect(tokens.buttonId).toBe(button!.id);
    expect(button!.getAttribute("title")?.toLowerCase()).toContain("lurkloot");
  });

  it("reuses the same opaque button id across remount reconcile", async () => {
    mountInPagePanel("twitch");
    await vi.waitFor(() => expect(document.querySelector("button")).not.toBeNull());
    const firstId = document.querySelector("button")!.id;

    document.querySelector("button")!.remove();
    // storage.onChanged is not auto-fired by our mock; call mount path by writing settings
    // Re-importing is unnecessary — trigger reconcile via storage listener if captured,
    // otherwise remount is enough when tokens already exist.
    mountInPagePanel("twitch");
    await vi.waitFor(() => expect(document.querySelector("button")).not.toBeNull());
    expect(document.querySelector("button")!.id).toBe(firstId);
  });
});
