// @vitest-environment happy-dom
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountProgressPoll } from "@lurkloot/shared/models";
import { AccountProgressSlot } from "../../popup-ui/src/accountProgress";
import { kickLevelPercent } from "../../popup-ui/src/kickAccountProgress";
import { StatusStrip } from "../../popup-ui/src/statusStrip";
import { I18nContext } from "../../popup-ui/src/context";

const messages: Record<string, string> = {
  kickLevelSummary: "Kick level $1 · $2% to level $3",
  kickLevelXp: "$1 / $2 XP",
  kickStreakDays: "$1-day watch streak",
};
const t = (key: string, substitutions?: string | string[]) => {
  const values = substitutions === undefined ? [] : [substitutions].flat();
  return (messages[key] ?? key).replace(/\$(\d)/g, (_, index) => values[Number(index) - 1] ?? "");
};

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
    root.render(
      <I18nContext.Provider value={{ t: t as never, dir: "ltr", locale: "en" }}>
        {node}
      </I18nContext.Provider>,
    );
  });
  return container;
}

const kickPoll = (streakDays?: number): AccountProgressPoll => ({
  lastCheckedAt: "2026-10-16T18:00:00.000Z",
  fetchedAt: "2026-10-16T18:00:00.000Z",
  progress: {
    platform: "kick",
    level: 56,
    progressXp: 7146,
    xpToNextLevel: 4636,
    ...(streakDays === undefined ? {} : { streakDays }),
  },
});

function strip(accountProgress: React.ReactNode): HTMLElement {
  return render(
    <StatusStrip
      platform="kick"
      presentation={{ state: "running", operational: true } as never}
      farmingChannel={{ name: "prod", url: "https://kick.com/prod" } as never}
      accountProgress={accountProgress}
      enabled
      pending={false}
      onToggle={() => undefined}
    />,
  );
}

describe("account progress beside the platform switch", () => {
  it("shows Kick's level, its progress and the streak", () => {
    const view = strip(<AccountProgressSlot poll={kickPoll(25)} signedIn />);
    const badge = view.querySelector('[data-account-progress="kick"]');
    expect(badge?.getAttribute("aria-label")).toBe(
      "Kick level 56 · 60% to level 57. 25-day watch streak",
    );
    expect(badge?.getAttribute("data-tooltip")).toBe(
      "Kick level 56 · 60% to level 57\n7,146 / 11,782 XP\n25-day watch streak",
    );
    expect(badge?.querySelector("text")?.textContent).toBe("56");
    expect(view.querySelector("[data-kick-level-ring]")).not.toBeNull();
    expect(view.querySelector("[data-kick-streak]")?.textContent).toBe("25");
  });

  it("leaves the streak out when there is none", () => {
    expect(
      strip(<AccountProgressSlot poll={kickPoll(0)} signedIn />).querySelector(
        "[data-kick-streak]",
      ),
    ).toBeNull();
    expect(
      strip(<AccountProgressSlot poll={kickPoll()} signedIn />).querySelector("[data-kick-streak]"),
    ).toBeNull();
  });

  it("shows nothing while signed out or before a first read", () => {
    expect(
      strip(<AccountProgressSlot poll={kickPoll(25)} signedIn={false} />).querySelector(
        "[data-account-progress]",
      ),
    ).toBeNull();
    expect(
      strip(
        <AccountProgressSlot poll={{ lastCheckedAt: "2026-10-16T18:00:00.000Z" }} signedIn />,
      ).querySelector("[data-account-progress]"),
    ).toBeNull();
    expect(
      strip(<AccountProgressSlot signedIn />).querySelector("[data-account-progress]"),
    ).toBeNull();
  });

  it("rounds the percent down, the way Kick shows it", () => {
    const progress = kickPoll().progress!;
    expect(kickLevelPercent(progress)).toBe(60);
    expect(kickLevelPercent({ ...progress, progressXp: 0, xpToNextLevel: 0 })).toBe(0);
    expect(kickLevelPercent({ ...progress, progressXp: 99, xpToNextLevel: 1 })).toBe(99);
  });
});
