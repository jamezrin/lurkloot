import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { TwitchExtensionDrops } from "../../popup-ui/src/twitchExtensions";

describe("Twitch extension drops view", () => {
  // #727: an identity-blocked provider releases the lane, so it is usually not
  // the active source. It must still ask the user to link the account.
  it("asks to link the account while another source holds the lane", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.twitchExtensions.nopixel.enabled = true;
    const html = renderToStaticMarkup(createElement(TwitchExtensionDrops, {
      settings,
      summaries: { nopixel: { status: "unavailable", reasonCode: "identity-required", progress: [], pending: [{ key: "account-link", state: "blocked" }], updatedAt: "2026-10-09T12:00:00.000Z" } },
      activeProvider: "fortnite",
      onSetup: () => undefined,
    }));
    expect(html).toContain("extensionIdentityRequired");
    expect(html).not.toContain("extensionIdle");
  });
});
