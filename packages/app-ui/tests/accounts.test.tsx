import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsView } from "../src/accounts";
import { createAuthApi } from "../src/auth";
import { resetFixture } from "../fixture/controlPlane";
import { fixtureClient } from "./helpers";
import { createDemoPopupAdapter } from "@lurkloot/popup-ui";
// Not exported from the package root: the frame provides it to host views.
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";

// Keys, with their substitutions, so the assertions do not depend on the copy.
const i18n = {
  t: (key: string, substitutions?: string | string[]) =>
    substitutions === undefined ? key : `${key}:${[substitutions].flat().join("|")}`,
  dir: "ltr" as const,
  locale: "en",
};

let root: Root | undefined;

beforeEach(() => {
  resetFixture();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountAccounts() {
  document.body.innerHTML = '<div id="root"></div>';
  const client = fixtureClient();
  const api = createAuthApi(client);
  const adapter = { ...createDemoPopupAdapter(), openLink: vi.fn() };
  const container = document.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
        <I18nContext.Provider value={i18n}>
          <AccountsView api={api} />
        </I18nContext.Provider>
      </PopupRuntimeContext.Provider>,
    );
  });
  await vi.waitFor(() =>
    expect(
      container
        .querySelector('[data-account="kick"] [data-account-status]')
        ?.getAttribute("data-account-status"),
    ).toBe("missing_credentials"),
  );
  return { container, client, adapter };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Accounts", () => {
  it("sends the pasted Twitch address once and clears it, whatever the answer", async () => {
    const { container, client } = await mountAccounts();
    const input = container.querySelector<HTMLInputElement>("[data-browser-login-address]")!;
    const submit = container.querySelector<HTMLButtonElement>("[data-browser-login-submit]")!;

    await act(async () => type(input, "https://www.twitch.tv/"));
    await act(async () => submit.click());
    await vi.waitFor(() =>
      expect(container.querySelector('[data-account-notice="error"]')).not.toBeNull(),
    );
    expect(input.value).toBe("");

    const address = "https://www.twitch.tv/#access_token=abc123def456&scope=&token_type=bearer";
    await act(async () => type(input, address));
    await act(async () => submit.click());
    await vi.waitFor(() =>
      expect(container.querySelector('[data-account-notice="ok"]')?.textContent).toContain(
        "fixture_viewer",
      ),
    );
    expect(input.value).toBe("");
    expect(
      client.calls.filter((call) => call.path === "/v1/session/auth/twitch/browser-login"),
    ).toHaveLength(2);
    // The address is never kept: not on the page, not in either storage.
    expect(container.innerHTML).not.toContain("abc123def456");
    expect(JSON.stringify({ ...localStorage })).not.toContain("abc123def456");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("abc123def456");
  });

  it("shows the Kick code, polls while it is pending and stops once it ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { container, client } = await mountAccounts();
    const kick = container.querySelector('[data-device-login="kick"]')!;

    await act(async () =>
      kick.querySelector<HTMLButtonElement>("[data-device-login-start]")!.click(),
    );
    await vi.waitFor(() =>
      expect(kick.querySelector("[data-device-login-code]")?.textContent).toBe("482913"),
    );

    const polls = () =>
      client.calls.filter(
        (call) => call.method === "GET" && call.path === "/v1/session/auth/kick/device-login",
      ).length;
    // The fixture approves on the fifteenth poll.
    for (let index = 0; index < 15; index += 1) {
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await vi.waitFor(() => expect(polls()).toBe(index + 1));
    }
    await vi.waitFor(() => expect(kick.getAttribute("data-device-login-status")).toBe("approved"));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(polls()).toBe(15);
  });

  it("cancels a pending device login", async () => {
    const { container, client } = await mountAccounts();
    const twitch = container.querySelector('[data-device-login="twitch"]')!;
    await act(async () =>
      twitch.querySelector<HTMLButtonElement>("[data-device-login-start]")!.click(),
    );
    await vi.waitFor(() =>
      expect(twitch.querySelector("[data-device-login-cancel]")).not.toBeNull(),
    );
    await act(async () =>
      twitch.querySelector<HTMLButtonElement>("[data-device-login-cancel]")!.click(),
    );
    await vi.waitFor(() =>
      expect(twitch.getAttribute("data-device-login-status")).toBe("cancelled"),
    );
    expect(client.calls).toContainEqual({
      method: "DELETE",
      path: "/v1/session/auth/twitch/device-login",
    });
  });
});
