import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, WatchSession } from "@lurkloot/shared/models";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { DropsPanel } from "../../popup-ui/src/drops";
import type { PopupAdapter } from "../../popup-ui/src/types";
import { campaignViewFromCampaign } from "../../popup-ui/src/viewModels";

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

function mount(url?: string) {
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
  const campaign = campaignViewFromCampaign(sourceCampaign(url), 0, idleSession, false);
  const container = document.getElementById("app")!;

  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{
        t: (key) => ({
          externalGameAccountRequired: "External game account required",
          linkExternalGameAccount: "Link external game account",
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

  return { container, openLink };
}

describe("claim-time account link guidance", () => {
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
