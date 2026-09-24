// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_WATCHLIST_LIMIT } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import { IdleWatchlistPanel, channelNameFromInput } from "../../popup-ui/src/idleWatchlist";
import type { StreamerItem, TFunction } from "../../popup-ui/src/types";

const t: TFunction = (key, substitutions) => {
  const value = Array.isArray(substitutions) ? substitutions.join(", ") : substitutions;
  return value === undefined ? key : `${key}:${value}`;
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const streamer = (name: string): StreamerItem => ({ id: name, name, live: false });

function mount(streamers: StreamerItem[]) {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  const onChange = vi.fn();
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>
        <IdleWatchlistPanel platform="twitch" streamers={streamers} onChange={onChange} />
      </I18nContext.Provider>,
    );
  });
  return { container, onChange };
}

function submit(container: Element, value: string): void {
  const input = container.querySelector<HTMLInputElement>("[data-watchlist-input]")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("idle watchlist view", () => {
  it("reads a channel from a name, an @name or a channel link", () => {
    expect(channelNameFromInput(" RivalsPilot ")).toBe("rivalspilot");
    expect(channelNameFromInput("@lootforge")).toBe("lootforge");
    expect(channelNameFromInput("https://www.twitch.tv/NightRunLive?sr=a")).toBe("nightrunlive");
    expect(channelNameFromInput("kick.com/xqc")).toBe("xqc");
    expect(channelNameFromInput("https://example.com/xqc")).toBeUndefined();
    expect(channelNameFromInput("   ")).toBeUndefined();
  });

  it("adds a pasted channel link from the field at the top", () => {
    const { container, onChange } = mount([streamer("lootforge")]);

    submit(container, "https://twitch.tv/RivalsPilot");

    expect(onChange).toHaveBeenCalledWith([streamer("lootforge"), streamer("rivalspilot")]);
  });

  it("says a channel is already listed instead of clearing it silently", () => {
    const { container, onChange } = mount([streamer("lootforge")]);

    submit(container, "LootForge");

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("[data-watchlist-notice]")?.textContent).toBe("idleWatchlistDuplicate:lootforge");
    expect(container.querySelector<HTMLInputElement>("[data-watchlist-input]")?.value).toBe("LootForge");
  });

  it("closes the field and says why once the list is full", () => {
    const full = Array.from({ length: IDLE_WATCHLIST_LIMIT }, (_, index) => streamer(`channel${index}`));
    const { container } = mount(full);

    const input = container.querySelector<HTMLInputElement>("[data-watchlist-input]")!;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe(`idleWatchlistFull:${IDLE_WATCHLIST_LIMIT}`);
    expect(container.querySelector("[data-watchlist-count]")?.textContent).toBe(`${IDLE_WATCHLIST_LIMIT}/${IDLE_WATCHLIST_LIMIT}`);
  });
});
