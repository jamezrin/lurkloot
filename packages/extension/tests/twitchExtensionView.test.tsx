// @vitest-environment happy-dom
// The provider switch is a Base UI Switch, which needs real pointer events.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import { TwitchExtensionView } from "../../popup-ui/src/twitchExtensions";
import type { TFunction } from "../../popup-ui/src/types";

const t: TFunction = (key) => key;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function flip(onEnabledChange: (enabled: boolean) => Promise<boolean | void>): Promise<HTMLElement> {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>
        <TwitchExtensionView providerId="nopixel" settings={mergeSettings(undefined)} active={false} pending={false} onEnabledChange={onEnabledChange} onOptionChange={() => undefined} />
      </I18nContext.Provider>,
    );
  });
  await act(async () => { container.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
  return container;
}

describe("Twitch extension view", () => {
  it("says the permission is missing when the browser denies it", async () => {
    const container = await flip(async () => false);
    expect(container.querySelector("[data-extension-failure]")?.textContent).toBe("extensionPermissionRequired");
  });

  it("says the extension is unavailable when enabling fails", async () => {
    const container = await flip(async () => { throw new Error("tick failed"); });
    expect(container.querySelector("[data-extension-failure]")?.textContent).toBe("extensionUnavailable");
  });

  it("says nothing when enabling succeeds", async () => {
    const container = await flip(async () => true);
    expect(container.querySelector("[data-extension-failure]")).toBeNull();
  });
});
