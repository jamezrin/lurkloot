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
            onPinChange={() => undefined}
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
    currentSettings.farmingEligibility.farmUnlinkedCampaigns = false;
    const { container } = mount(undefined, source, {
      skipUnfinishableRewards: currentSettings.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: currentSettings.deadlineSafetyMarginMinutes,
      settings: currentSettings,
    });

    expect(container.querySelector("[data-farming-rejection-indicator]")).not.toBeNull();
    expect(container.textContent).toContain("campaignRejectionUnlinkedDisabled");
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
          onPinChange={() => undefined}
          onToggleExclude={() => undefined}
        />
      </PopupRuntimeContext.Provider>
    </I18nContext.Provider>,
  );
}

function mountCampaignList(initialCampaigns: ReturnType<typeof campaignViewFromCampaign>[], onPinChange = vi.fn()) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window.HTMLInputElement.prototype, "select", { configurable: true, value: () => undefined });
  const container = document.getElementById("app")!;
  const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
  function render(campaigns: ReturnType<typeof campaignViewFromCampaign>[], focus?: { id: string; seq: number }) {
    root!.render(
      <I18nContext.Provider value={{ t: (key) => ({ completedCampaigns: "Completed", finished: "Finished", later: "later", search: "Search" })[key] ?? key, dir: "ltr", locale: "en" }}>
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          <DropsPanel campaigns={campaigns} gameMap={{}} focus={focus} refreshing={false} onRefreshCampaign={() => undefined} onPinChange={onPinChange} onToggleExclude={() => undefined} />
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  }
  act(() => {
    root = createRoot(container);
    render(initialCampaigns);
  });
  return {
    container,
    window,
    onPinChange,
    rerender: (focus: { id: string; seq: number }, campaigns = initialCampaigns) => act(() => render(campaigns, focus)),
  };
}

describe("completed campaign section", () => {
  it("keeps a 100% watched but unclaimed campaign in the active list", () => {
    const claimable = campaignViewFromCampaign(sourceCampaign(), 0, idleSession, false);
    const { container } = mountCampaignList([claimable]);

    const row = container.querySelector<HTMLElement>('[data-campaign-id="kick-campaign"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("100%");
    expect(row?.textContent).not.toContain("Finished");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Completed"))).toBe(false);
  });

  it("keeps finished campaigns collapsed and shows one terminal status when opened", () => {
    const settings = mergeSettings(undefined);
    const feasibility = {
      skipUnfinishableRewards: settings.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
      settings,
    };
    const finished = campaignViewFromCampaign({
      ...sourceCampaign(), id: "finished", name: "Finished campaign", status: "completed",
      rewards: [{ ...sourceCampaign().rewards[0]!, status: "claimed" }],
    }, 0, farmingSession("active"), false, feasibility);
    const active = campaignViewFromCampaign({ ...sourceCampaign(), id: "active", name: "Active campaign" }, 1, farmingSession("active"), false, feasibility);
    const { container } = mountCampaignList([finished, active]);

    expect(container.querySelector('[data-campaign-id="active"]')).not.toBeNull();
    expect(container.querySelector('[data-campaign-id="finished"]')).toBeNull();
    const completedToggle = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Completed"));
    expect(completedToggle?.getAttribute("aria-expanded")).toBe("false");

    act(() => completedToggle?.click());
    const finishedRow = container.querySelector<HTMLElement>('[data-campaign-id="finished"]');
    expect(finishedRow).not.toBeNull();
    expect(finishedRow?.textContent).toContain("Finished");
    expect(finishedRow?.textContent).not.toContain("100%");
    expect(finishedRow?.textContent).not.toContain("later");
    expect(finishedRow?.querySelector("[data-farming-rejection-indicator]")).toBeNull();
    expect(finishedRow?.querySelector("button[aria-label^='Set rank']")).toBeNull();
  });

  it("pins the campaign whose rank was typed, and nothing else", () => {
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "first", name: "First active" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "finished", name: "Finished campaign", status: "completed" }, 1, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "second", name: "Second active" }, 2, idleSession, false),
    ];
    const { container, onPinChange } = mountCampaignList(campaigns);
    const rank = container.querySelector<HTMLButtonElement>('button[aria-label="Set rank of Second active"]');
    expect(rank?.textContent).toBe("2");
    act(() => rank?.click());
    const input = findNumericRankInput(container)!;
    act(() => setInputValue(input, "1"));
    act(() => blurRankInput(input));

    // A typed rank pins exactly that campaign at that position; the finished
    // campaign and the other active one keep whatever tier they had.
    expect(onPinChange).toHaveBeenCalledOnce();
    expect(onPinChange).toHaveBeenCalledWith("second", 0);
  });

  it("reveals and opens a finished campaign when the popup focuses it", () => {
    const finished = campaignViewFromCampaign({ ...sourceCampaign(), id: "finished", name: "Finished campaign", status: "completed" }, 0, idleSession, false);
    const { container, window, rerender } = mountCampaignList([finished]);
    const scrollIntoView = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });

    rerender({ id: "finished", seq: 1 });

    const finishedRow = container.querySelector<HTMLElement>('[data-campaign-id="finished"]');
    expect(finishedRow).not.toBeNull();
    expect(finishedRow?.querySelector("button[aria-expanded='true']")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("reveals a focused campaign when it becomes finished without a new focus request", () => {
    const active = campaignViewFromCampaign({ ...sourceCampaign(), id: "focused", name: "Focused campaign" }, 0, idleSession, false);
    const finished = { ...active, lifecycle: "finished" as const };
    const focus = { id: "focused", seq: 1 };
    const { container, window, rerender } = mountCampaignList([active]);
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });

    rerender(focus, [active]);
    rerender(focus, [finished]);

    expect(container.querySelector('[data-campaign-id="focused"]')).not.toBeNull();
    const completedToggle = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Completed"));
    expect(completedToggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("finds a finished campaign while the section is collapsed", () => {
    const finished = campaignViewFromCampaign({ ...sourceCampaign(), id: "finished", name: "Finished campaign", status: "completed" }, 0, idleSession, false);
    const { container } = mountCampaignList([finished]);
    act(() => container.querySelector<HTMLButtonElement>("button[aria-label='Search']")?.click());
    const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
    act(() => setSearchQuery(input, "Finished campaign"));

    expect(container.querySelector("article")?.textContent).toContain("Finished campaign");
    expect(container.querySelector("article")?.textContent).toContain("Finished");
  });
});

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

function findNumericRankInput(container: Element): HTMLInputElement | undefined {
  // linkedom keeps React's camelCase inputMode attribute rather than lowercasing it.
  return [...container.querySelectorAll<HTMLInputElement>("input")].find((el) =>
    el.getAttribute("inputmode") === "numeric" || el.getAttribute("inputMode") === "numeric"
  );
}

function blurRankInput(input: HTMLInputElement): void {
  // Re-read props after the controlled value commit; the pre-change onBlur
  // closure still sees the old rank and would cancel the move.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onBlur?(): void }>)[propsKey]
    : undefined;
  props?.onBlur?.();
}

function keyDownRankInput(input: HTMLInputElement, key: string): void {
  const propsKey = Object.keys(input).find((keyName) => keyName.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, {
      onKeyDown?(event: { key: string; preventDefault(): void; stopPropagation(): void }): void;
    }>)[propsKey]
    : undefined;
  props?.onKeyDown?.({ key, preventDefault() {}, stopPropagation() {} });
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
    const onPinChange = vi.fn();
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
              onPinChange={onPinChange}
              onToggleExclude={() => undefined}
            />
          </PopupRuntimeContext.Provider>
        </I18nContext.Provider>,
      );
    });

    const rank = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Set rank of Second campaign");
    expect(rank).toBeDefined();
    expect(rank?.className).toContain("w-4");
    expect(rank?.className).not.toContain("w-full");
    act(() => rank?.click());
    const input = findNumericRankInput(container);
    expect(input).toBeDefined();
    act(() => {
      setInputValue(input!, "1");
    });
    act(() => {
      blurRankInput(input!);
    });

    expect(onPinChange).toHaveBeenCalledOnce();
    expect(onPinChange).toHaveBeenCalledWith("second", 0);
  });

  it("allows commit after Escape cancels a prior edit on the same row", () => {
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
    Object.defineProperty(window.HTMLInputElement.prototype, "select", { configurable: true, value: () => undefined });
    const onPinChange = vi.fn();
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
              onPinChange={onPinChange}
              onToggleExclude={() => undefined}
            />
          </PopupRuntimeContext.Provider>
        </I18nContext.Provider>,
      );
    });

    const openRank = () => {
      const rank = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Set rank of Second campaign");
      expect(rank).toBeDefined();
      act(() => rank?.click());
      return findNumericRankInput(container);
    };

    const inputAfterOpen = openRank();
    expect(inputAfterOpen).toBeDefined();
    act(() => {
      keyDownRankInput(inputAfterOpen!, "Escape");
    });
    expect(onPinChange).not.toHaveBeenCalled();

    const input = openRank();
    expect(input).toBeDefined();
    act(() => {
      setInputValue(input!, "1");
    });
    act(() => {
      blurRankInput(input!);
    });

    expect(onPinChange).toHaveBeenCalledOnce();
    expect(onPinChange).toHaveBeenCalledWith("second", 0);
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
    expect(findNumericRankInput(container)).toBeUndefined();
    const rankSpan = container.querySelector<HTMLElement>("article .w-7 span");
    expect(rankSpan?.textContent).toBe("2");
    expect(rankSpan?.className).toContain("w-4");
    expect(rankSpan?.className).not.toContain("w-full");
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
              onPinChange={() => undefined}
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
              onPinChange={() => undefined}
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
