import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { SettingsView } from "../../popup-ui/src/settings";
import type { PopupAdapter } from "../../popup-ui/src/types";

// Every message key the registry resolves for a DEFAULT_SETTINGS render without
// a compatibility registry supplied. A key missing here falls back to the raw
// key name, which makes the assertions below fail confusingly rather than
// cleanly, so keep this in sync with settingsRegistry.tsx.
const labels: Record<string, string> = {
  settingsSearchPlaceholder: "Search settings…",
  settingsSearchNoResults: "No settings match",
  settingsShowAdvancedTitle: "Show advanced settings",
  settingsSectionGeneral: "General",
  settingsSectionTwitch: "Twitch",
  settingsSectionKick: "Kick",
  settingsGroupAppearance: "Appearance & behavior",
  settingsGroupNotifications: "Notifications",
  settingsGroupDrops: "Drops",
  settingsGroupFarmingTabs: "Farming tabs",
  settingsGroupAdvanced: "Advanced",
  settingsGroupCategories: "Categories",
  settingsGroupExcludedChannels: "Excluded channels",
  settingsLanguageTitle: "Language",
  settingsLanguageDescription: "Choose the language used by the popup and extension notifications.",
  autoStartTitle: "Auto-start on launch",
  autoStartDescription: "Begin farming as soon as the extension loads.",
  pauseManualTitle: "Pause when watching manually",
  pauseManualDescription: "Stop farming while you have a stream open and are watching yourself.",
  hideTipsTitle: "Hide tips",
  hideTipsDescription: "Remove helpful tips from the main popup.",
  rewardEarnedTitle: "Reward earned",
  rewardEarnedDescription: "Notify when a drop reward is claimable.",
  noDropsLeftTitle: "No drops left",
  noDropsLeftDescription: "Notify when all active campaigns are exhausted.",
  autoClaimTitle: "Auto-claim drops",
  autoClaimDescription: "Claim earned drop rewards automatically when they become available.",
  campaignPriorityTitle: "Campaign priority",
  campaignPriorityDescription: "How campaigns are chosen to farm.",
  idleWatchlistFallbackOnlyTitle: "Only when no drops are active",
  idleWatchlistFallbackOnlyDescription: "Preserves drop priority automatically.",
  farmUnlinkedTitle: "Farm campaigns without a linked account",
  farmUnlinkedDescription: "When off, campaigns that need you to link your account are skipped.",
  farmSubscriptionTitle: "Farm campaigns that require a subscription",
  farmSubscriptionDescription: "When off, campaigns whose rewards need a channel subscription are skipped.",
  dropsListFilterTitle: "Drops list view",
  dropsListFilterDescription: "Choose which campaigns are shown in the Drops list.",
  forgetExcludedTitle: "Forget excluded campaigns",
  forgetExcludedDescription: "Clear every campaign you excluded from farming.",
  tablessTitle: "Tabless low-resource mode",
  tablessDescription: "Farm via lightweight watch signals instead of a video tab.",
  autoCloseTabsTitle: "Auto-close farming tabs",
  autoCloseTabsDescription: "Automatically close when the extension is idle.",
  muteTabsTitle: "Mute farming tabs",
  muteTabsDescription: "Keep drop and Watch Queue tabs muted while farming.",
  keepVideosUnmutedTitle: "Keep farming videos unmuted",
  keepVideosUnmutedDescription: "Keeps page video players unmuted while the browser tab is muted.",
  adFocusTitle: "Focus tab during ads",
  adFocusDescription: "Ad countdowns freeze in background tabs.",
  schedulerIntervalTitle: "Scheduler interval",
  schedulerIntervalDescription: "How often campaign and streamer status refreshes.",
  postClaimHandoffTitle: "Fast reward handoff",
  postClaimHandoffDescription: "After claiming a drop, briefly check for the next reward.",
  postClaimHandoffIntervalTitle: "Handoff check interval",
  postClaimHandoffIntervalDescription: "How long to wait between checks for the next reward.",
  postClaimHandoffMaxTitle: "Handoff time limit",
  postClaimHandoffMaxDescription: "Give up and return to the regular schedule after this long.",
  skipUnfinishableRewardsTitle: "Skip rewards that cannot be completed",
  skipUnfinishableRewardsDescription: "Do not farm impossible rewards.",
  deadlineSafetyMarginTitle: "Deadline safety margin",
  deadlineSafetyMarginDescription: "Extra minutes required before farming a reward.",
  deadlineSafetyMarginDisabledReason: "Enable deadline filtering to change the safety margin.",
  diagnosticLoggingTitle: "Include diagnostic logs",
  diagnosticLoggingDescription: "Record additional technical details.",
  tablessDisabledReason: "Disabled while tabless low-resource mode is enabled.",
  secondsSuffix: "sec",
  minutesSuffix: "min",
  off: "Off",
  tabOnly: "Tab only",
  tabAndWindow: "Tab + window",
  priorityListOnly: "Priority list only",
  endingSoonest: "Ending soonest",
  lowAvailabilityFirst: "Low availability first",
  autoClaimChannelPointsTitle: "Auto-claim channel points",
  autoClaimChannelPointsDescription: "Claim channel-point bonuses while farming this platform.",
  autoClaimChallengesTitle: "Auto-claim daily challenges",
  autoClaimChallengesDescription: "Claim Kick's daily challenge reward once its watch-time goal is met.",
  farmAllCategoriesTitle: "Farm all categories",
  farmAllCategoriesDescription: "Farm drops in every $1 category.",
  excludedChannelsTitle: "Excluded drop channels",
  excludedChannelsDescription: "Campaign farming will skip these streamers.",
  excludedChannelsEmpty: "No excluded drop channels.",
};

// KNOWN LIMITATION — depends on a React internal, verified necessary:
//
// The textbook fix for a controlled-input test not firing onChange is to call
// the native value setter (bypassing React's per-instance tracker) and then
// reset React's `_valueTracker` to the empty string before dispatching an
// "input" event, so React's ChangeEventPlugin sees the DOM value as changed.
// That was tried here first, from `window.HTMLInputElement.prototype` (not
// `input.constructor.prototype`, in case linkedom aliased them) with an
// explicit `tracker.setValue("")` reset before the dispatch. It did not work:
// confirmed with an isolated repro that React's container-level "input"
// listener *does* run (wrapping the listener function shows 2 invocations —
// capture and bubble), but the handler still never calls the app's onChange,
// even with the tracker reset. Something in linkedom's Event/target plumbing
// that ChangeEventPlugin depends on (composedPath, target resolution, or
// similar) does not line up the way it does in jsdom/real browsers, and that
// is below what's worth chasing here.
//
// So instead this reaches into the fiber's stashed props object (the
// `__reactProps$<id>` key React attaches to every host DOM node) and calls
// the current onChange prop directly with a minimal synthetic-event shape.
// This exercises the same application code the real event would have, just
// skipping React's own dispatch machinery. `__reactProps$` is an
// implementation-detail key with no stability guarantee across React
// versions. If this test starts failing after a React upgrade with an error
// like "props is undefined" or the key prefix changing, do not just chase the
// new key name — first re-verify whether the native dispatchEvent path above
// works under the new React/linkedom combination, since that would be the
// correct fix.
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
  setter?.call(input, value);
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? (input as unknown as Record<string, { onChange?(event: unknown): void }>)[propsKey] : undefined;
  props?.onChange?.({ target: input, currentTarget: input });
}

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function mountSettings(settings = DEFAULT_SETTINGS) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onSettingsChange = vi.fn(async () => undefined);
  const adapter = {
    getStorage: async () => ({}),
    setStorage: async () => undefined,
  } as unknown as PopupAdapter;
  const container = document.getElementById("app")!;

  act(() => {
    root = createRoot(container);
    root.render(
      <PopupRuntimeContext.Provider value={{ adapter, preview: true }}>
        <I18nContext.Provider value={{ t: (key: string) => labels[key] ?? key, dir: "ltr", locale: "en" }}>
          <SettingsView
            suggestions={{ twitch: [], kick: [] }}
            onSearchCategories={async () => []}
            settings={settings}
            onSettingsChange={onSettingsChange}
            exportConfirmationResetKey={0}
          />
        </I18nContext.Provider>
      </PopupRuntimeContext.Provider>,
    );
  });

  return { container, onSettingsChange };
}

describe("settings search view", () => {
  it("hides advanced groups until the advanced switch is turned on", () => {
    const { container } = mountSettings();
    expect(container.textContent).not.toContain("Scheduler interval");
    const advancedSwitch = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show advanced settings");
    act(() => advancedSwitch?.click());
    expect(container.textContent).toContain("Scheduler interval");
  });

  it("filters settings by title as the user types", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => {
      setInputValue(search, "mute");
    });
    expect(container.textContent).toContain("Mute farming tabs");
    expect(container.textContent).not.toContain("Auto-claim drops");
  });

  it("reveals a matching advanced setting without enabling the advanced switch", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => {
      setInputValue(search, "scheduler interval");
    });
    expect(container.textContent).toContain("Scheduler interval");
    const advancedSwitch = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show advanced settings");
    expect(advancedSwitch?.getAttribute("aria-checked")).toBe("false");
  });

  it("restores the full tree when the query is cleared", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => setInputValue(search, "mute"));
    act(() => setInputValue(search, ""));
    expect(container.textContent).toContain("Auto-claim drops");
  });

  it("shows an empty state when nothing matches", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => setInputValue(search, "zzzznotasetting"));
    expect(container.textContent).toContain("No settings match");
  });
});
