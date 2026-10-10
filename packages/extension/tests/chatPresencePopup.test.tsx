// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPresenceStatus } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { StatusStrip } from "../../popup-ui/src/statusStrip";
import { TwitchExtensionView } from "../../popup-ui/src/twitchExtensions";
import { I18nContext } from "../../popup-ui/src/context";

const messages: Record<string, string> = {
  watchingLabel: "Watching",
  chatPresenceJoined: "In chat",
  chatPresenceJoining: "Joining chat…",
  chatPresenceUnavailable: "Chat unavailable",
  chatPresenceBlockedAuth: "Chat unavailable: sign in to Twitch again",
  extensionChatPresenceBlocked: "Not in chat: NoPixel watch time isn't earned until chat presence recovers",
};
const t = (key: string) => messages[key] ?? key;

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function render(node: React.ReactNode): HTMLElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = "<div id=app></div>";
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(<I18nContext.Provider value={{ t: t as never, dir: "ltr", locale: "en" }}>{node}</I18nContext.Provider>);
  });
  return container;
}

function strip(chatPresence?: ChatPresenceStatus): HTMLElement {
  return render(
    <StatusStrip
      platform="twitch"
      presentation={{ state: "running", operational: true } as never}
      farmingChannel={{ name: "prod", url: "https://www.twitch.tv/prod" } as never}
      chatPresence={chatPresence}
      enabled
      pending={false}
      onToggle={() => undefined}
    />,
  );
}

describe("chat presence in the popup", () => {
  it.each([
    [{ state: "joined", channel: "prod" }, "In chat"],
    [{ state: "joining", channel: "prod" }, "Joining chat…"],
    [{ state: "error", channel: "prod" }, "Chat unavailable"],
    [{ state: "blocked", channel: "prod", reason: "auth" }, "Chat unavailable: sign in to Twitch again"],
  ] as const)("labels the strip badge for %o", (status, label) => {
    expect(strip(status).querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  });

  it("shows no badge when presence is not wanted", () => {
    expect(strip(undefined).querySelector('[data-chat-presence]')).toBeNull();
    expect(strip({ state: "left" }).querySelector('[data-chat-presence]')).toBeNull();
  });

  it("warns on the active NoPixelV view while it is not in chat", () => {
    const settings = { ...DEFAULT_SETTINGS, twitchExtensions: { ...DEFAULT_SETTINGS.twitchExtensions, nopixel: { ...DEFAULT_SETTINGS.twitchExtensions.nopixel, enabled: true } } };
    const summary = { status: "farming", reasonCode: "watchtime", progress: [{ key: "daily-pack", earned: 3, required: 60 }], pending: [], updatedAt: new Date(0).toISOString() } as never;
    const view = (chatPresence: ChatPresenceStatus | undefined) => render(
      <TwitchExtensionView providerId="nopixel" settings={settings} summary={summary} active pending={false}
        chatPresence={chatPresence} onEnabledChange={async () => true} onOptionChange={() => undefined} />,
    );
    expect(view({ state: "error", channel: "prod" }).querySelector(`[aria-label="${messages.extensionChatPresenceBlocked}"]`)).not.toBeNull();
    expect(view({ state: "joined", channel: "prod" }).querySelector(`[aria-label="${messages.extensionChatPresenceBlocked}"]`)).toBeNull();
    // No presence status at all while NoPixelV is active is not being in chat.
    expect(view(undefined).querySelector(`[aria-label="${messages.extensionChatPresenceBlocked}"]`)).not.toBeNull();
    // A normal join (every lane rotation) is not a failure.
    expect(view({ state: "joining", channel: "prod" }).querySelector(`[aria-label="${messages.extensionChatPresenceBlocked}"]`)).toBeNull();
  });
});
