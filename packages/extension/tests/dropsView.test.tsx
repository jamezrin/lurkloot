import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { DropsPanel, initialExpandedIds } from "../../popup-ui/src/drops";
import type { PopupAdapter } from "../../popup-ui/src/types";
import { campaignViewFromCampaign } from "../../popup-ui/src/viewModels";
import { createDemoPopupAdapter } from "../../popup-ui/src/demo";

const idleSession: WatchSession = {
  platform: "kick",
  offlineChecks: 0,
  status: "idle",
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function sourceCampaign(url?: string): DropCampaign {
  return {
    id: "kick-campaign",
    platform: "kick",
    name: "Kick campaign",
    status: "active",
    rewards: [{
      id: "claimable-reward",
      name: "Claimable reward",
      requiredMinutes: 60,
      watchedMinutes: 60,
      status: "claimable",
      claimGuidance: url ? { kind: "link_required", url } : undefined,
    }],
  };
}

function mount(url?: string, source = sourceCampaign(url), viewOptions?: Parameters<typeof campaignViewFromCampaign>[4]) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const openLink = vi.fn();
  const adapter = { openLink } as unknown as PopupAdapter;
  const campaign = campaignViewFromCampaign(source, 0, idleSession, false, viewOptions);
  const container = document.getElementById("app")!;

  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{
        t: (key) => ({
          externalGameAccountRequired: "External game account required",
          linkExternalGameAccount: "Link external game account",
          search: "Search",
        })[key] ?? key,
        dir: "ltr",
        locale: "en",
      }}>
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          <DropsPanel
            campaigns={[campaign]}
            gameMap={{}}
            refreshing={false}
            onRefreshCampaign={() => undefined}
            onReorder={() => undefined}
            onToggleExclude={() => undefined}
          />
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  });

  // Cards open collapsed unless a campaign is farming, so expand the card under
  // test before asserting on its body.
  const toggle = container.querySelector<HTMLButtonElement>("article button[aria-expanded]");
  act(() => toggle?.click());

  return { container, openLink };
}

describe("drops search controls", () => {
  it("uses an action label for the campaign search button", () => {
    const { container } = mount();

    const searchButton = container.querySelector<HTMLButtonElement>("button[aria-label='Search']");
    expect(searchButton).not.toBeNull();
  });
});

describe("campaign farming rejection presentation", () => {
  it("shows a collapsed warning and an expanded explanation for a rejected campaign", () => {
    const source: DropCampaign = {
      ...sourceCampaign(),
      platform: "twitch",
      accountLinked: false,
      rewards: [{
        id: "watch",
        name: "Watch reward",
        requiredMinutes: 60,
        watchedMinutes: 0,
        status: "locked",
        requirement: "watch",
        isWatchBased: true,
      }],
    };
    const currentSettings = mergeSettings(undefined);
    const { container } = mount(undefined, source, {
      skipUnfinishableRewards: currentSettings.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: currentSettings.deadlineSafetyMarginMinutes,
      settings: currentSettings,
    });

    expect(container.querySelector("[data-farming-rejection-indicator]")).not.toBeNull();
    expect(container.textContent).toContain("campaignRejectionTwitchLinkRequired");
  });
});

function farmingSession(campaignId: string): WatchSession {
  return {
    platform: "kick",
    offlineChecks: 0,
    status: "watching",
    campaignId,
    channel: { platform: "kick", username: "somechannel", url: "https://kick.com/somechannel" },
  };
}

function renderDropsPanel(campaigns: ReturnType<typeof campaignViewFromCampaign>[], focus?: { id: string; seq: number }) {
  const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
  root!.render(
    <I18nContext.Provider value={{ t: (key) => ({ search: "Search" })[key] ?? key, dir: "ltr", locale: "en" }}>
      <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
        <DropsPanel
          campaigns={campaigns}
          gameMap={{}}
          focus={focus}
          refreshing={false}
          onRefreshCampaign={() => undefined}
          onReorder={() => undefined}
          onToggleExclude={() => undefined}
        />
      </PopupRuntimeContext.Provider>
    </I18nContext.Provider>,
  );
}

function setSearchQuery(input: HTMLInputElement, value: string): void {
  input.value = value;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onChange?(event: { target: HTMLInputElement; currentTarget: HTMLInputElement }): void }>)[propsKey]
    : undefined;
  props?.onChange?.({ target: input, currentTarget: input });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onChange?(event: { target: HTMLInputElement; currentTarget: HTMLInputElement }): void; onBlur?(): void }>)[propsKey]
    : undefined;
  props?.onChange?.({ target: input, currentTarget: input });
}

describe("campaign rank input", () => {
  it("reorders via the typed rank on blur", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // linkedom's HTMLInputElement has no select(); RankInput calls it on edit.
    Object.defineProperty(window.HTMLInputElement.prototype, "select", { configurable: true, value: () => undefined });
    const onReorder = vi.fn();
    const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "first", name: "First campaign" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "second", name: "Second campaign" }, 1, idleSession, false),
    ];
    const container = document.getElementById("app")!;

    act(() => {
      root = createRoot(container);
      root.render(
        <I18nContext.Provider value={{ t: (key) => ({ search: "Search" })[key] ?? key, dir: "ltr", locale: "en" }}>
          <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
            <DropsPanel
              campaigns={campaigns}
              gameMap={{}}
              refreshing={false}
              onRefreshCampaign={() => undefined}
              onReorder={onReorder}
              onToggleExclude={() => undefined}
            />
          </PopupRuntimeContext.Provider>
        </I18nContext.Provider>,
      );
    });

    const rank = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Set rank of Second campaign");
    expect(rank).not.toBeNull();
    act(() => rank?.click());
    // linkedom keeps React's camelCase inputMode attribute rather than lowercasing it.
    const input = [...container.querySelectorAll<HTMLInputElement>("input")].find((el) =>
      el.getAttribute("inputmode") === "numeric" || el.getAttribute("inputMode") === "numeric"
    )!;
    expect(input).not.toBeNull();
    act(() => {
      setInputValue(input, "1");
    });
    act(() => {
      // Re-read props after the controlled value commit; the pre-change onBlur
      // closure still sees the old rank and would cancel the move.
      const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
      const props = propsKey
        ? (input as unknown as Record<string, { onBlur?(): void }>)[propsKey]
        : undefined;
      props?.onBlur?.();
    });

    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder.mock.calls[0]?.[0].map((campaign: { id: string }) => campaign.id)).toEqual(["second", "first"]);
  });

  it("does not expose a rank editor while searching", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.getElementById("app")!;
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "first", name: "First campaign" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "second", name: "Second campaign" }, 1, idleSession, false),
    ];

    act(() => {
      root = createRoot(container);
      renderDropsPanel(campaigns);
    });

    act(() => container.querySelector<HTMLButtonElement>("button[aria-label='Search']")?.click());
    const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
    act(() => setSearchQuery(input, "Second"));

    expect([...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Set rank of Second campaign")).toBeUndefined();
    expect(container.querySelector("input[inputmode='numeric']")).toBeNull();
    expect(container.querySelector<HTMLElement>("article .w-7 span")?.textContent).toBe("2");
  });
});

describe("initial drops expansion", () => {
  it("expands nothing when no campaign is farming", () => {
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "a" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "b" }, 1, idleSession, false),
    ];

    expect(initialExpandedIds(campaigns)).toEqual({});
  });

  it("expands only the farming campaign, even when it is not first", () => {
    const session = farmingSession("b");
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "a" }, 0, session, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "b" }, 1, session, false),
    ];

    expect(campaigns[1]?.farmingChannel).toBeTruthy();
    expect(initialExpandedIds(campaigns)).toEqual({ b: true });
  });

  it("expands no card on mount, then expands a campaign that starts farming later", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
    const container = document.getElementById("app")!;

    function render(session: WatchSession) {
      const campaign = campaignViewFromCampaign(sourceCampaign(), 0, session, false);
      root!.render(
        <I18nContext.Provider value={{ t: (key) => key, dir: "ltr", locale: "en" }}>
          <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
            <DropsPanel
              campaigns={[campaign]}
              gameMap={{}}
              refreshing={false}
              onRefreshCampaign={() => undefined}
              onReorder={() => undefined}
              onToggleExclude={() => undefined}
            />
          </PopupRuntimeContext.Provider>
        </I18nContext.Provider>,
      );
    }

    act(() => {
      root = createRoot(container);
      render(idleSession);
    });

    const expandedStates = () => Array.from(container.querySelectorAll("article button[aria-expanded]")).map((toggle) => toggle.getAttribute("aria-expanded"));

    expect(expandedStates()).toEqual(["false"]);

    act(() => render(farmingSession("kick-campaign")));

    expect(expandedStates()).toEqual(["true"]);
  });

  // The collapsed row's category/pill line takes pointer events back so an
  // overflowing pill row can be scrolled, which opts it out of the full-area
  // toggle behind the card content. It has to expand the card itself.
  it("expands the card when the collapsed row's pill line is clicked", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
    const container = document.getElementById("app")!;

    act(() => {
      root = createRoot(container);
      root.render(
        <I18nContext.Provider value={{ t: (key) => key, dir: "ltr", locale: "en" }}>
          <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
            <DropsPanel
              campaigns={[campaignViewFromCampaign(sourceCampaign(), 0, idleSession, false)]}
              gameMap={{}}
              refreshing={false}
              onRefreshCampaign={() => undefined}
              onReorder={() => undefined}
              onToggleExclude={() => undefined}
            />
          </PopupRuntimeContext.Provider>
        </I18nContext.Provider>,
      );
    });

    const toggle = container.querySelector("article button[aria-expanded]");
    const pillLine = container.querySelector<HTMLElement>("article .no-scrollbar");
    expect(pillLine).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    // linkedom does not expose a MouseEvent constructor, so initialize the
    // click fields the handler reads on its Event implementation instead.
    const click = new window.Event("click", { bubbles: true });
    Object.defineProperties(click, {
      clientX: { value: 0 },
      detail: { value: 1 },
    });
    act(() => pillLine?.dispatchEvent(click));

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("scrolls a focused campaign after clearing a filtered search", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const scrollIntoView = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView });
    const container = document.getElementById("app")!;
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "first", name: "First campaign" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "second", name: "Second campaign" }, 1, idleSession, false),
    ];

    act(() => {
      root = createRoot(container);
      renderDropsPanel(campaigns);
    });

    act(() => container.querySelector<HTMLButtonElement>("button[aria-label='Search']")?.click());
    const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
    act(() => setSearchQuery(input, "First"));
    expect(container.textContent).not.toContain("Second campaign");

    act(() => renderDropsPanel(campaigns, { id: "second", seq: 1 }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("keeps the original priority number in filtered results", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.getElementById("app")!;
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "first", name: "First campaign" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "second", name: "Second campaign" }, 1, idleSession, false),
    ];

    act(() => {
      root = createRoot(container);
      renderDropsPanel(campaigns);
    });

    act(() => container.querySelector<HTMLButtonElement>("button[aria-label='Search']")?.click());
    const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
    act(() => setSearchQuery(input, "Second"));

    const priority = container.querySelector<HTMLElement>("article .w-7 span");
    expect(priority?.textContent).toBe("2");
  });
});

describe("claim-time account link guidance", () => {
  it("validates HTTPS again at the demo popup host boundary", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const adapter = createDemoPopupAdapter();

    adapter.openLink("javascript:alert(1)");
    adapter.openLink("http://accounts.example/link");
    adapter.openLink("https://accounts.example/link");

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://accounts.example/link", "_blank", "noopener,noreferrer");
  });

  it("shows localized guidance and opens its safe link only after a user click", () => {
    const { container, openLink } = mount("https://accounts.example/link");

    expect(container.textContent).toContain("External game account required");
    expect(container.textContent).toContain("Link external game account");
    expect(openLink).not.toHaveBeenCalled();

    const link = container.querySelector<HTMLButtonElement>("[data-claim-link]");
    expect(link).not.toBeNull();
    act(() => link?.click());
    expect(openLink).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith("https://accounts.example/link");
  });

  it.each([undefined, "javascript:alert(1)", "http://accounts.example/link"]) (
    "renders no link for missing or unsafe guidance: %s",
    (url) => {
      const { container, openLink } = mount(url);

      expect(container.querySelector("[data-claim-link]")).toBeNull();
      expect(openLink).not.toHaveBeenCalled();
    },
  );
});
