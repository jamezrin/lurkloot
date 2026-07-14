import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import {
  AUTOMATIC_COMPATIBILITY_PATCH,
  CompatibilitySettings,
} from "../../popup-ui/src/compatibilitySettings";

const labels: Record<string, string> = {
  compatibilityAutomatic: "Automatic",
  compatibilityTwitchProfileTitle: "Twitch compatibility profile",
  compatibilityKickProfileTitle: "Kick compatibility profile",
  compatibilityEffectiveTitle: "Effective compatibility",
  compatibilityExpertShow: "Show expert compatibility controls",
  compatibilityExpertHide: "Hide expert compatibility controls",
  compatibilityTwitchHeartbeatTitle: "Twitch heartbeat transport",
  compatibilityTwitchInventoryTitle: "Twitch inventory query",
  compatibilityKickClaimTitle: "Kick claim-link handling",
  compatibilityLifecycleRecommended: "Recommended",
  compatibilityLifecycleLegacy: "Legacy",
  compatibilityLifecycleExperimental: "Experimental",
  compatibilityOverrideWarning: "Manual compatibility overrides are active.",
  compatibilityRestoreAutomatic: "Restore automatic compatibility",
};

function render(settings = DEFAULT_SETTINGS, expertExpanded = false): string {
  return renderToStaticMarkup(createElement(
    I18nContext.Provider,
    { value: { t: (key: string) => labels[key] ?? key, dir: "ltr", locale: "en" } },
    createElement(CompatibilitySettings, {
      settings: settings.compatibility,
      registry: COMPATIBILITY_REGISTRY,
      resolution: resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      onChange: vi.fn(),
      expertExpanded,
      onExpertExpandedChange: vi.fn(),
    }),
  ));
}

describe("extension compatibility settings", () => {
  it("shows automatic profiles, effective versions, and lifecycle badges", () => {
    const html = render();
    expect(html).toContain('aria-label="Twitch compatibility profile"');
    expect(html).toContain('<option value="auto" selected="">Automatic</option>');
    expect(html).toContain("twitch-2026-07");
    expect(html).toContain("twitch-heartbeat-spade-v1");
    expect(html).toContain("Recommended");
  });

  it("keeps expert controls collapsed and filters host-inapplicable options", () => {
    expect(render()).not.toContain("Twitch heartbeat transport</");
    const html = render(DEFAULT_SETTINGS, true);
    expect(html).toContain("Twitch heartbeat transport");
    expect(html).not.toContain("twitch-heartbeat-trowel-v1");
    expect(html).toContain("Legacy");
    expect(html).toContain("Experimental");
  });

  it("warns for overrides and exposes an atomic automatic reset", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, profile: "twitch-2026-07" },
      },
    };
    const html = render(settings);
    expect(html).toContain("Manual compatibility overrides are active.");
    expect(html).toContain("Restore automatic compatibility");
    expect(AUTOMATIC_COMPATIBILITY_PATCH).toEqual({
      compatibility: {
        twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" },
        kick: { profile: "auto", claimLinkHandling: "auto" },
      },
    });
  });
});
