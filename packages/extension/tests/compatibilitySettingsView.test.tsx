import React, { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { applySettingsPatch, DEFAULT_SETTINGS, type SettingsPatch } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import { PlatformCompatibilitySettings } from "../../popup-ui/src/compatibilitySettings";
import type { Platform } from "@lurkloot/shared/models";

const labels: Record<string, string> = {
  compatibilityAutomatic: "Automatic",
  compatibilityTwitchProfileTitle: "Twitch compatibility profile",
  compatibilityTwitchProfileDescription: "Twitch profile description",
  compatibilityKickProfileTitle: "Kick compatibility profile",
  compatibilityKickProfileDescription: "Kick profile description",
  compatibilitySectionTitle: "Compatibility",
  compatibilitySectionDescription: "Compatibility description",
  compatibilityComponentProfile: "Profile",
  compatibilityComponentHeartbeat: "Heartbeat transport",
  compatibilityComponentInventory: "Inventory query",
  compatibilityComponentClaim: "Claim handling",
  compatibilityFromProfile: "From profile",
  compatibilityOverridden: "Overridden",
  compatibilityReplacedBy: "Replaced by $1",
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

function mount(onChange = vi.fn(), platform: Platform = "twitch") {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  function Harness() {
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const handleChange = (patch: SettingsPatch) => {
      onChange(patch);
      setSettings((current) => applySettingsPatch(current, patch));
    };
    // Mirrors translateFromCatalogs so $1 placeholders resolve like they do in
    // the real popup.
    const translate = (key: string, substitutions?: string | string[]) => {
      const template = labels[key] ?? key;
      const values = Array.isArray(substitutions) ? substitutions : substitutions == null ? [] : [substitutions];
      return values.reduce((text, value, index) => text.replaceAll(`$${index + 1}`, value), template);
    };
    return <I18nContext.Provider value={{ t: translate, dir: "ltr", locale: "en" }}>
      <PlatformCompatibilitySettings
        platform={platform}
        settings={settings.compatibility}
        registry={COMPATIBILITY_REGISTRY}
        resolution={resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" })}
        onChange={handleChange}
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
  it("shows the twitch capabilities and what each one resolved to", () => {
    const { container } = mount(undefined, "twitch");
    for (const label of ["Profile", "Heartbeat transport", "Inventory query"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).not.toContain("Claim handling");
    // The resolved id sits on the row itself rather than in a separate summary
    // block, so "Automatic" always states what it actually picked.
    for (const id of ["twitch-2026-07", "twitch-heartbeat-spade-v1", "twitch-inventory-v1"]) {
      expect(container.textContent).toContain(id);
    }
    // Full capability names stay as accessible names for the controls.
    expect(select(container, "Twitch compatibility profile").textContent).toContain("Twitch July 2026");
  });

  it("shows the kick capabilities and what each one resolved to", () => {
    const { container } = mount(undefined, "kick");
    for (const label of ["Profile", "Claim handling"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).not.toContain("Heartbeat transport");
    expect(container.textContent).not.toContain("Inventory query");
    for (const id of ["kick-2026-07", "kick-claim-v2"]) {
      expect(container.textContent).toContain(id);
    }
    expect(select(container, "Kick compatibility profile").textContent).toContain("Kick July 2026");
  });

  it("renders only the requested platform's rows", () => {
    const { container } = mount(undefined, "twitch");
    const text = container.textContent ?? "";
    expect(text).toContain("Heartbeat transport");
    expect(text).not.toContain("Claim handling");
  });

  it("carries lifecycle into the option labels so the tradeoff is visible when choosing", () => {
    const { container } = mount(undefined, "twitch");
    const heartbeat = select(container, "Twitch heartbeat transport");
    const optionLabels = [...heartbeat.options].map((option) => option.textContent);
    expect(optionLabels).toContain("Automatic");
    expect(optionLabels).toContain("Spade heartbeat v1 · Recommended");
    expect(optionLabels).toContain("GraphQL heartbeat v1 · Legacy");
  });

  it("attributes inherited values to the profile and flags explicit overrides", () => {
    const { container } = mount(undefined, "twitch");
    expect(container.textContent).toContain("From profile");
    expect(container.textContent).not.toContain("Overridden");

    act(() => choose(select(container, "Twitch heartbeat transport"), "twitch-heartbeat-gql-v1"));

    expect(container.textContent).toContain("Overridden");
    // A legacy pick names its successor instead of silently going stale.
    expect(container.textContent).toContain("Replaced by Spade heartbeat v1");
  });

  it("overrides twitch settings without a disclosure step, and restores just that platform", () => {
    const { container, onChange } = mount(undefined, "twitch");
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(0);

    expect([...select(container, "Twitch inventory query").options].map((option) => option.value)).toEqual(["auto", "twitch-inventory-v1"]);

    const heartbeat = select(container, "Twitch heartbeat transport");
    expect(heartbeat.textContent).not.toContain("Trowel");
    act(() => choose(heartbeat, "twitch-heartbeat-gql-v1"));
    expect(onChange).toHaveBeenNthCalledWith(1, { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-gql-v1" } } });

    act(() => byText(container, "Restore automatic compatibility").click());
    expect(onChange).toHaveBeenLastCalledWith({
      compatibility: { twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" } },
    });
  });

  it("overrides kick settings without a disclosure step, and restores just that platform", () => {
    const { container, onChange } = mount(undefined, "kick");

    const claim = select(container, "Kick claim-link handling");
    act(() => choose(claim, "kick-claim-v2"));
    expect(onChange).toHaveBeenNthCalledWith(1, { compatibility: { kick: { claimLinkHandling: "kick-claim-v2" } } });

    act(() => byText(container, "Restore automatic compatibility").click());
    expect(onChange).toHaveBeenLastCalledWith({
      compatibility: { kick: { profile: "auto", claimLinkHandling: "auto" } },
    });
  });
});
