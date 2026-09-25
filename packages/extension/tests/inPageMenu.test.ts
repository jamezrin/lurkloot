import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn(async () => undefined);
const storageGet = vi.fn(async () => ({}) as Record<string, unknown>);

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { sendMessage, getURL: vi.fn(() => "https://extension/panel.html") },
    storage: { local: { get: storageGet, set: vi.fn() }, onChanged: { addListener: vi.fn() } },
    i18n: { getMessage: vi.fn(() => "") },
  },
}));

// The panel module keeps its button and menu in module state, so each test
// mounts a fresh copy against its own document.
async function mount(platform: "twitch" | "kick"): Promise<void> {
  vi.resetModules();
  const { mountInPagePanel } = await import("../src/core/inPagePanel");
  mountInPagePanel(platform);
  await settle();
}

// Twitch's nav, reduced to what resolveAnchorFor needs to place the button.
const TWITCH_NAV = '<nav><div data-a-target="top-nav-container"><div class="top-nav__menu"><div data-a-target="user-menu-toggle"></div></div></div></nav>';

function setUpPage(href: string): void {
  const { document, window } = parseHTML(`<html><body>${TWITCH_NAV}</body></html>`);
  globalThis.document = document as unknown as Document;
  globalThis.window = window as unknown as Window & typeof globalThis;
  // The panel's click handler asks whether the event target is an Element, and
  // linkedom's classes are per-window rather than global.
  globalThis.Element = window.Element as unknown as typeof Element;
  globalThis.Node = window.Node as unknown as typeof Node;
  globalThis.location = { href } as Location;
  globalThis.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof MutationObserver;
  Object.defineProperty(globalThis.document, "fullscreenElement", { configurable: true, value: null });
  for (const element of [window.HTMLElement.prototype]) {
    Object.defineProperty(element, "getClientRects", { configurable: true, value: () => [{ width: 10, height: 10 }] });
    Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 40, left: 0, right: 200, width: 200, height: 40 }) });
    Object.defineProperty(element, "focus", { configurable: true, value: () => undefined });
  }
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function caret(): HTMLElement {
  const element = globalThis.document.getElementById("lurkloot-nav-caret");
  if (!element) throw new Error("Missing caret");
  return element as unknown as HTMLElement;
}

function menuItems(): string[] {
  const menu = globalThis.document.getElementById("lurkloot-nav-menu");
  return menu ? [...menu.querySelectorAll("[role=menuitem]")].map((item) => item.textContent ?? "") : [];
}

async function openMenu(): Promise<void> {
  caret().dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
  await settle();
}

beforeEach(() => {
  sendMessage.mockClear();
  storageGet.mockReset();
  storageGet.mockResolvedValue({
    settings: { showInPagePanel: true, platform: { twitch: { idleWatchlistChannels: [] } } },
    schedulerState: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("in-page nav menu", () => {
  it("offers to add the channel the page is about", async () => {
    setUpPage("https://www.twitch.tv/summit1g");
    await mount("twitch");

    await openMenu();

    expect(menuItems()).toEqual(["Open Lurkloot", "Add summit1g to the idle watchlist"]);
  });

  it("sends the addition as one change, not a copy of the whole list", async () => {
    setUpPage("https://www.twitch.tv/summit1g");
    await mount("twitch");
    await openMenu();

    const add = globalThis.document.querySelectorAll("#lurkloot-nav-menu [role=menuitem]")[1]!;
    add.dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
    await settle();

    // The background applies it to the list it has stored, so a change the
    // popup made since the menu opened is not undone.
    expect(sendMessage).toHaveBeenCalledWith({ type: "updateIdleWatchlist", platform: "twitch", channel: "summit1g", action: "add" });
    // The menu closes behind the action rather than leaving a stale list open.
    expect(globalThis.document.getElementById("lurkloot-nav-menu")).toBeNull();
  });

  it("offers removal once the channel is already listed", async () => {
    storageGet.mockResolvedValue({
      settings: { showInPagePanel: true, platform: { twitch: { idleWatchlistChannels: ["summit1g"] } } },
      schedulerState: {},
    });
    setUpPage("https://www.twitch.tv/summit1g");
    await mount("twitch");

    await openMenu();

    expect(menuItems()[1]).toBe("Remove summit1g from the idle watchlist");
  });

  it("offers nothing but the panel on a page that is not a channel's", async () => {
    setUpPage("https://www.twitch.tv/directory/game/Rust");
    await mount("twitch");

    await openMenu();

    expect(menuItems()).toEqual(["Open Lurkloot"]);
  });

  it("closes on Escape", async () => {
    setUpPage("https://www.twitch.tv/summit1g");
    await mount("twitch");
    await openMenu();

    const menu = globalThis.document.getElementById("lurkloot-nav-menu")!;
    const escape = new globalThis.window.Event("keydown", { bubbles: true }) as unknown as { key: string };
    escape.key = "Escape";
    menu.dispatchEvent(escape as unknown as Event);
    await settle();

    expect(globalThis.document.getElementById("lurkloot-nav-menu")).toBeNull();
  });

  it("builds one menu even when the caret is clicked twice in a row", async () => {
    setUpPage("https://www.twitch.tv/summit1g");
    await mount("twitch");

    // Both clicks land before the watchlist read resolves.
    caret().dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
    caret().dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
    await settle();

    expect(globalThis.document.querySelectorAll("#lurkloot-nav-menu")).toHaveLength(1);
    expect(menuItems()).toEqual(["Open Lurkloot", "Add summit1g to the idle watchlist"]);
  });

  it("keeps the button reported as expanded while the panel is open behind a closed menu", async () => {
    setUpPage("https://www.twitch.tv/summit1g");
    await mount("twitch");

    const button = globalThis.document.getElementById("lurkloot-nav-button")!;
    button.dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
    await settle();
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await openMenu();
    caret().dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
    await settle();

    // The menu closed; the panel did not, and one attribute speaks for both.
    expect(globalThis.document.getElementById("lurkloot-nav-menu")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  // The frame used to be 720px whatever the window, so a narrow window cut the
  // popup off; it now follows the window and the popup folds its rail to fit.
  it("fits the panel to a narrow window and follows it as it resizes", async () => {
    setUpPage("https://www.twitch.tv/summit1g");
    Object.defineProperty(globalThis.window, "innerWidth", { configurable: true, writable: true, value: 600 });
    Object.defineProperty(globalThis.window, "innerHeight", { configurable: true, writable: true, value: 900 });
    await mount("twitch");
    await openMenu();
    globalThis.document.querySelectorAll("#lurkloot-nav-menu [role=menuitem]")[0]!.dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
    await settle();
    const panel = () => globalThis.document.getElementById("lurkloot-panel") as unknown as HTMLElement;
    const frame = () => panel().querySelector("iframe") as unknown as HTMLElement;

    expect(panel().style.width).toBe("568px");
    expect(frame().style.width).toBe("568px");

    globalThis.window.innerWidth = 1400;
    globalThis.window.dispatchEvent(new globalThis.window.Event("resize"));
    expect(panel().style.width).toBe("720px");

    // Never under the popup page's own minimum, which would scroll sideways.
    globalThis.window.innerWidth = 320;
    globalThis.window.dispatchEvent(new globalThis.window.Event("resize"));
    expect(frame().style.width).toBe("400px");
  });
});
