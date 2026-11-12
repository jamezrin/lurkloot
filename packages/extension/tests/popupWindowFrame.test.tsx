// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDemoPopupAdapter,
  Popup,
  POPUP_FRAME_CLASS,
  type PopupAdapter,
  type PopupHostCapabilities,
  type PopupWindowFrame,
  COMBINED_DROPS_MEDIA_QUERY,
} from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";

// The full-window frame the CLI app uses (#979), and the guarantee that the
// extension popup, which never passes one, keeps its own frame unchanged.

const CLI_CAPABILITIES: PopupHostCapabilities = {
  tabs: false,
  twitchExtensions: false,
  credentialExport: false,
  extensionPreferences: false,
  language: true,
  activityHistory: false,
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function signedOut(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      authHealth: {
        ...snapshot.state.authHealth,
        twitch: { status: "missing_credentials" },
      },
    },
  };
}

function excludeFirstTwitch(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const first = snapshot.state.campaigns.twitch[0];
  if (!first) throw new Error("demo has no twitch campaign");
  return {
    ...snapshot,
    settings: {
      ...snapshot.settings,
      platform: {
        ...snapshot.settings.platform,
        twitch: { ...snapshot.settings.platform.twitch, excludedCampaignIds: [first.id] },
      },
    },
  };
}

async function mount(options: {
  hostCapabilities?: PopupHostCapabilities;
  windowFrame?: PopupWindowFrame;
  signedOutTwitch?: boolean;
  excludeFirstTwitchCampaign?: boolean;
}): Promise<{
  container: HTMLElement;
  sent: RuntimeMessage[];
  openLink: ReturnType<typeof vi.fn>;
}> {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const demo = createDemoPopupAdapter();
  const sent: RuntimeMessage[] = [];
  const openLink = vi.fn();
  const adapter: PopupAdapter = {
    ...demo,
    getMessage: (key) => `[${key}]`,
    openLink,
    send: async <T,>(message: RuntimeMessage) => {
      sent.push(message);
      let result = await demo.send<RuntimeSnapshot>(message);
      const isSnapshot = result && typeof result === "object" && "state" in result;
      if (isSnapshot && options.signedOutTwitch) result = signedOut(result);
      if (isSnapshot && options.excludeFirstTwitchCampaign) result = excludeFirstTwitch(result);
      return result as T;
    },
    ...(options.hostCapabilities ? { hostCapabilities: options.hostCapabilities } : {}),
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} windowFrame={options.windowFrame} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, sent, openLink };
}

const ACCOUNTS: PopupWindowFrame = {
  hostViews: [
    {
      id: "accounts",
      labelKey: "navAccounts",
      icon: () => null,
      render: () => <p data-accounts-body>accounts body</p>,
    },
  ],
  signInView: "accounts",
};

function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("element missing");
  return act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
}

describe("popup frame", () => {
  it("keeps the extension popup's own frame when no window frame is passed", async () => {
    const { container } = await mount({});
    const main = container.querySelector("main")!;
    expect(main.getAttribute("class")).toBe(POPUP_FRAME_CLASS);
    expect(main.hasAttribute("data-frame")).toBe(false);
    expect(container.querySelector('[data-rail-group="host"]')).toBeNull();
  });

  it("fills the window and lists the host's views in the rail", async () => {
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: ACCOUNTS,
    });
    const main = container.querySelector("main")!;
    expect(main.getAttribute("data-frame")).toBe("window");
    expect(main.getAttribute("class")).toContain("h-dvh");
    expect(main.getAttribute("class")).not.toContain("w-[720px]");

    const accounts = container.querySelector('button[data-host-view="accounts"]');
    await click(accounts);
    expect(container.querySelector("[data-accounts-body]")).not.toBeNull();
    expect(accounts?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('button[data-view="queue"]')?.getAttribute("aria-current")).toBe(
      null,
    );

    await click(container.querySelector('button[data-view="settings"]'));
    expect(container.querySelector("[data-accounts-body]")).toBeNull();
    expect(accounts?.getAttribute("aria-current")).toBe(null);
  });

  it("opens the host's sign-in view from the status line's Sign in action", async () => {
    const { container, openLink } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: ACCOUNTS,
      signedOutTwitch: true,
    });
    await click(container.querySelector('[data-auth-action="twitch"]'));
    expect(openLink).not.toHaveBeenCalled();
    expect(container.querySelector("[data-accounts-body]")).not.toBeNull();
  });

  it("still opens the platform's sign-in page in the extension", async () => {
    const { container, openLink } = await mount({ signedOutTwitch: true });
    await click(container.querySelector('[data-auth-action="twitch"]'));
    expect(openLink).toHaveBeenCalledWith("https://www.twitch.tv/login");
  });
});

describe("activity without a history", () => {
  it("summarises the snapshot instead of asking a host without a history for one", async () => {
    const { container, sent } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: ACCOUNTS,
    });
    await click(container.querySelector('button[data-view="activity"]'));

    expect(container.querySelector("[data-activity-summary]")).not.toBeNull();
    expect(container.textContent).toContain("[activityNoHistoryTitle]");
    expect(container.querySelector('[data-activity-platform="kick"]')).not.toBeNull();
    expect(sent.map((message) => message.type)).not.toContain("getActivity");
    expect(sent.map((message) => message.type)).not.toContain("getActivitySessions");
  });

  it("still pages the extension's own history", async () => {
    const { container, sent } = await mount({});
    await click(container.querySelector('button[data-view="activity"]'));

    expect(container.querySelector("[data-activity-summary]")).toBeNull();
    expect(sent.map((message) => message.type)).toContain("getActivity");
  });
});

describe("combined drops page", () => {
  const COMBINED: PopupWindowFrame = { ...ACCOUNTS, combineDropViews: true };

  // A viewport the test can resize: only the combined-page query is asked.
  function stubViewport(initiallyWide: boolean) {
    let wide = initiallyWide;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query === COMBINED_DROPS_MEDIA_QUERY && wide;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    return (next: boolean) =>
      act(async () => {
        wide = next;
        for (const listener of listeners) listener();
        await Promise.resolve();
      });
  }

  function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
    return (
      [...container.querySelectorAll("button")].find((button) => button.textContent === text)
      ?? null
    );
  }

  const railHas = (container: HTMLElement, view: string) =>
    container.querySelector(`button[data-view="${view}"]`) !== null;

  it("keeps Completed and Games as rail entries of their own without the flag", async () => {
    stubViewport(true);
    const { container } = await mount({});
    expect(railHas(container, "completed")).toBe(true);
    expect(railHas(container, "games")).toBe(true);
    expect(container.querySelector("[data-drops-page]")).toBeNull();
  });

  it("keeps the popup's three views in a narrow window", async () => {
    stubViewport(false);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: COMBINED,
    });
    expect(railHas(container, "completed")).toBe(true);
    expect(railHas(container, "games")).toBe(true);
    expect(container.querySelector("[data-drops-page]")).toBeNull();
  });

  it("shows Games and Completed beside the queue, not in the rail, in a wide window", async () => {
    stubViewport(true);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: COMBINED,
    });
    expect(railHas(container, "queue")).toBe(true);
    expect(railHas(container, "completed")).toBe(false);
    expect(railHas(container, "games")).toBe(false);

    const page = container.querySelector("[data-drops-page]")!;
    expect(
      page.querySelector('[data-drops-section="games"] [data-tour="games-mode"]'),
    ).not.toBeNull();
    expect(
      page.querySelector('[data-drops-section="completed"] [data-tour="completed-list"]'),
    ).not.toBeNull();
    // Each card's controls sit in its own header, not the page's title row.
    expect(
      page.querySelector(
        '[data-drops-section="games"] > header [data-view-toolbar] [data-tour="games-mode"]',
      ),
    ).not.toBeNull();
    expect(
      page.querySelector(
        '[data-drops-section="completed"] > header [data-view-toolbar] [data-completed-tab]',
      ),
    ).not.toBeNull();
    const titleRow = container.querySelector("[data-view-toolbar]")!;
    expect(titleRow.closest("[data-drops-page]")).toBeNull();
    expect(titleRow.querySelector('[data-tour="games-mode"]')).toBeNull();
    // The page is titled for all three, and its one rail entry with it.
    expect(container.querySelector("h1")?.textContent).toBe("[navGroupDrops]");
    expect(container.querySelector('button[data-view="queue"]')?.getAttribute("aria-label")).toBe(
      "[navGroupDrops]",
    );
  });

  it("follows the window as it is resized", async () => {
    const resize = stubViewport(false);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: COMBINED,
    });
    await click(container.querySelector('button[data-view="games"]'));
    expect(container.querySelector('[data-tour="games-mode"]')).not.toBeNull();

    // Widened on Games: the combined page, at the Games section.
    await resize(true);
    expect(container.querySelector("[data-drops-page]")).not.toBeNull();
    expect(railHas(container, "games")).toBe(false);

    // Narrowed again: the Queue, with the three views back in the rail.
    await resize(false);
    expect(container.querySelector("[data-drops-page]")).toBeNull();
    expect(railHas(container, "games")).toBe(true);
    expect(container.querySelector('button[data-view="queue"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("opens the queue at the Games section when asked for the games view", async () => {
    stubViewport(true);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: COMBINED,
    });
    const edit = buttonByText(container, "[queueEditFavourites]");
    expect(edit).not.toBeNull();
    await click(edit);
    const games = container.querySelector('[data-drops-section="games"]');
    expect(container.querySelector("[data-drops-page]")).not.toBeNull();
    expect(document.activeElement).toBe(games);
    // Asking again, already on the page, focuses it again.
    (document.activeElement as HTMLElement).blur();
    await click(edit);
    expect(document.activeElement).toBe(games);

    await click(container.querySelector('button[data-view="settings"]'));
    expect(container.querySelector("[data-drops-page]")).toBeNull();
  });

  it("scrolls the queue and each sidebar section on its own, not the window", async () => {
    stubViewport(true);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: COMBINED,
    });
    const page = container.querySelector("[data-drops-page]")!;
    const panel = container.querySelector("#popup-platform-panel")!;
    expect(panel.hasAttribute("data-scroll-panel")).toBe(false);
    expect(panel.className).toContain("overflow-hidden");
    for (const section of ["queue", "games", "completed"]) {
      const scroller = page.querySelector(
        `[data-drops-section="${section}"] > [data-scroll-panel]:not([data-queue-tail])`,
      );
      expect(scroller?.className).toContain("overflow-y-auto");
    }
  });

  it("keeps the campaigns outside the queue below its scrolling list", async () => {
    stubViewport(true);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: COMBINED,
      excludeFirstTwitchCampaign: true,
    });
    const column = container.querySelector('[data-drops-section="queue"]')!;
    const list = column.querySelector(":scope > [data-scroll-panel]:not([data-queue-tail])")!;
    const tail = column.querySelector("[data-queue-tail]")!;
    expect(tail.hasAttribute("data-scroll-panel")).toBe(true);
    // Skipped sits in the tail, outside the queue's own scroller.
    expect(tail.querySelector('[data-queue-group="skipped"]')).not.toBeNull();
    expect(list.querySelector('[data-queue-group="skipped"]')).toBeNull();
    expect(list.querySelector('[data-tour="queue-list"]')).not.toBeNull();
  });

  it("keeps the campaigns outside the queue after it in the popup", async () => {
    const { container } = await mount({ excludeFirstTwitchCampaign: true });
    expect(container.querySelector("[data-queue-tail]")).toBeNull();
    const panel = container.querySelector("#popup-platform-panel")!;
    expect(panel.querySelector('[data-queue-group="skipped"]')).not.toBeNull();
  });
});

describe("window shell", () => {
  const SHELL: PopupWindowFrame = { ...ACCOUNTS, accountsView: "accounts" };

  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    };
  }

  function stubWide(wide: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === COMBINED_DROPS_MEDIA_QUERY && wide,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  }

  it("keeps the platform switch and status strip where the popup has them", async () => {
    const { container } = await mount({});
    expect(container.querySelector('nav [data-tour="platform-switch"]')).not.toBeNull();
    expect(container.querySelector("[data-window-header]")).toBeNull();
    expect(container.querySelector("[data-sidebar-toggle]")).toBeNull();
    expect(container.querySelector("[data-account-chip]")).toBeNull();
    expect(container.querySelector('nav [data-tour="status-strip"]')).toBeNull();
  });

  it("puts the platform switch, account and status in one header in a window", async () => {
    stubWide(true);
    const { container } = await mount({ hostCapabilities: CLI_CAPABILITIES, windowFrame: SHELL });
    const header = container.querySelector("[data-window-header]")!;
    expect(header.querySelector('[data-tour="platform-switch"]')).not.toBeNull();
    expect(header.querySelector('[data-tour="status-strip"]')).not.toBeNull();
    expect(header.querySelector('[aria-label="[refreshSchedule]"]')).not.toBeNull();
    expect(container.querySelector('nav [data-tour="platform-switch"]')).toBeNull();
    // The refresh is the header's alone.
    expect(container.querySelectorAll('[aria-label="[refreshSchedule]"]')).toHaveLength(1);

    const chip = header.querySelector('[data-account-chip="twitch"]')!;
    expect(chip.getAttribute("data-account-status")).toBe("healthy");
    expect(chip.textContent).toContain("[appAccountSignedIn]");
  });

  it("opens the host's accounts view from the account chip's menu", async () => {
    stubWide(true);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: SHELL,
      signedOutTwitch: true,
    });
    const chip = container.querySelector('[data-account-chip="twitch"]')!;
    expect(chip.getAttribute("data-account-status")).toBe("missing_credentials");
    await click(chip);
    await click(document.querySelector("[data-account-manage]"));
    expect(container.querySelector("[data-accounts-body]")).not.toBeNull();
  });

  it("leaves the account chip out without a host accounts view", async () => {
    stubWide(true);
    const { container } = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: ACCOUNTS,
    });
    expect(container.querySelector("[data-window-header]")).not.toBeNull();
    expect(container.querySelector("[data-account-chip]")).toBeNull();
  });

  it("expands the sidebar in a wide window and collapses it in a narrow one", async () => {
    stubWide(true);
    const wide = await mount({ hostCapabilities: CLI_CAPABILITIES, windowFrame: SHELL });
    expect(wide.container.querySelector("nav")?.getAttribute("data-sidebar")).toBe("expanded");
    act(() => root?.unmount());

    stubWide(false);
    const narrow = await mount({ hostCapabilities: CLI_CAPABILITIES, windowFrame: SHELL });
    const nav = narrow.container.querySelector("nav")!;
    expect(nav.getAttribute("data-sidebar")).toBe("collapsed");
    const toggle = narrow.container.querySelector("[data-sidebar-toggle]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(nav.id);
  });

  it("remembers the sidebar the user chose", async () => {
    stubWide(true);
    const storage = memoryStorage();
    const first = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: { ...SHELL, storage },
    });
    await click(first.container.querySelector("[data-sidebar-toggle]"));
    expect(first.container.querySelector("nav")?.getAttribute("data-sidebar")).toBe("collapsed");
    expect(storage.setItem).toHaveBeenCalledWith("lurkloot.window.sidebar", "collapsed");
    act(() => root?.unmount());

    // Wide as before, the stored choice wins over the window's default.
    const second = await mount({
      hostCapabilities: CLI_CAPABILITIES,
      windowFrame: { ...SHELL, storage },
    });
    expect(second.container.querySelector("nav")?.getAttribute("data-sidebar")).toBe("collapsed");
  });
});
