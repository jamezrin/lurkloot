import React, { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { applySettingsPatch, DEFAULT_SETTINGS, type SettingsPatch } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import { CompatibilitySettings } from "../../popup-ui/src/compatibilitySettings";

const labels: Record<string, string> = {
  compatibilityAutomatic: "Automatic",
  compatibilityTwitchProfileTitle: "Twitch compatibility profile",
  compatibilityTwitchProfileDescription: "Twitch profile description",
  compatibilityKickProfileTitle: "Kick compatibility profile",
  compatibilityKickProfileDescription: "Kick profile description",
  compatibilityEffectiveTitle: "Effective compatibility",
  compatibilityExpertShow: "Show expert compatibility controls",
  compatibilityExpertHide: "Hide expert compatibility controls",
  compatibilityTwitchHeartbeatTitle: "Twitch heartbeat transport",
  compatibilityTwitchHeartbeatDescription: "Heartbeat description",
  compatibilityTwitchInventoryTitle: "Twitch inventory query",
  compatibilityTwitchInventoryDescription: "Inventory description",
  compatibilityKickClaimTitle: "Kick claim-link handling",
  compatibilityKickClaimDescription: "Claim description",
  compatibilityLifecycleRecommended: "Recommended",
  compatibilityLifecycleLegacy: "Legacy",
  compatibilityLifecycleExperimental: "Experimental",
  compatibilityOverrideWarning: "Manual compatibility overrides are active.",
  compatibilityRestoreAutomatic: "Restore automatic compatibility",
  compatibilityOptionTwitchProfile202607: "Twitch July 2026",
  compatibilityOptionTwitchHeartbeatGqlV1: "GraphQL heartbeat v1",
  compatibilityOptionTwitchHeartbeatSpadeV1: "Spade heartbeat v1",
  compatibilityOptionTwitchHeartbeatTrowelV1: "Trowel heartbeat v1",
  compatibilityOptionTwitchInventoryV1: "Inventory query v1",
  compatibilityOptionKickProfile202607: "Kick July 2026",
  compatibilityOptionKickClaimV1: "Claim handling v1",
  compatibilityOptionKickClaimV2: "Claim handling v2",
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function mount(onChange = vi.fn()) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  function Harness() {
    const [expanded, setExpanded] = useState(false);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const handleChange = (patch: SettingsPatch) => {
      onChange(patch);
      setSettings((current) => applySettingsPatch(current, patch));
    };
    return <I18nContext.Provider value={{ t: (key) => labels[key] ?? key, dir: "ltr", locale: "en" }}>
      <CompatibilitySettings
        settings={settings.compatibility}
        registry={COMPATIBILITY_REGISTRY}
        resolution={resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" })}
        onChange={handleChange}
        expertExpanded={expanded}
        onExpertExpandedChange={setExpanded}
      />
    </I18nContext.Provider>;
  }
  act(() => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  return { container, onChange };
}

function byText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

function select(container: Element, label: string): HTMLSelectElement {
  const element = container.querySelector(`select[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing select: ${label}`);
  return element as HTMLSelectElement;
}

function choose(element: HTMLSelectElement, value: string): void {
  for (const option of element.querySelectorAll("option")) option.selected = option.getAttribute("value") === value;
  Object.defineProperty(element, "value", { configurable: true, value });
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}

describe("extension compatibility settings", () => {
  it("labels every effective capability and uses localized option titles", () => {
    const { container } = mount();
    for (const label of ["Twitch compatibility profile", "Twitch heartbeat transport", "Twitch inventory query", "Kick compatibility profile", "Kick claim-link handling"]) {
      expect(container.textContent).toContain(label);
    }
    expect(select(container, "Twitch compatibility profile").textContent).toContain("Twitch July 2026");
  });

  it("expands expert overrides, changes both platforms, and restores one atomic patch", () => {
    const { container, onChange } = mount();
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(0);
    act(() => byText(container, "Show expert compatibility controls").click());

    expect([...select(container, "Twitch inventory query").options].map((option) => option.value)).toEqual(["auto", "twitch-inventory-v1"]);

    const heartbeat = select(container, "Twitch heartbeat transport");
    expect(heartbeat.textContent).not.toContain("Trowel");
    act(() => choose(heartbeat, "twitch-heartbeat-gql-v1"));

    const claim = select(container, "Kick claim-link handling");
    act(() => choose(claim, "kick-claim-v2"));
    expect(onChange).toHaveBeenNthCalledWith(1, { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-gql-v1" } } });
    expect(onChange).toHaveBeenNthCalledWith(2, { compatibility: { kick: { claimLinkHandling: "kick-claim-v2" } } });

    act(() => byText(container, "Restore automatic compatibility").click());
    expect(onChange).toHaveBeenLastCalledWith({
      compatibility: {
        twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" },
        kick: { profile: "auto", claimLinkHandling: "auto" },
      },
    });
  });
});
