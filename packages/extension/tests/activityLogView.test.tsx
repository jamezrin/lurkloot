import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { PopupAdapter } from "../../popup-ui/src/types";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { ActivityLog } from "../../popup-ui/src/activity";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const REWARD_ACTIVITY: Extract<ActivityHistoryRecord, { code: "reward_claimed" }> = {
  id: "activity-1",
  at: "2026-07-25T12:00:00.000Z",
  category: "activity",
  code: "reward_claimed",
  level: "info",
  platform: "kick",
  data: {
    campaignId: "campaign-1",
    campaignName: "Summer Campaign",
    campaignUrl: "https://www.example.test/campaigns/summer",
    rewardId: "reward-1",
    rewardName: "Golden Hat",
    rewardImageUrl: "https://cdn.example.test/reward.png",
    method: "automatic",
  },
};

const ACTIVITY = [REWARD_ACTIVITY];

const DIAGNOSTICS: ActivityHistoryRecord[] = [{
  id: "diagnostic-1",
  at: "2026-07-25T12:00:01.000Z",
  category: "diagnostic",
  level: "error",
  platform: "kick",
  message: "Kick fetch kick.com failed with HTTP 503",
}];

function mount(options: {
  showDiagnostics: boolean;
  diagnosticLogging?: boolean;
  writeClipboard?: (text: string) => Promise<boolean>;
  omitClipboard?: boolean;
  activityEvents?: ActivityHistoryRecord[];
  diagnosticEvents?: ActivityHistoryRecord[];
}) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onShowDiagnosticsChange = vi.fn();
  const writeClipboard = options.writeClipboard ?? vi.fn(async () => true);
  const openLink = vi.fn();
  const adapter = { openLink } as unknown as PopupAdapter;
  const container = document.getElementById("app")!;

  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{
        t: (key, substitutions) => ({
          activityFarmingStarted: "Started farming a reward",
          activityRewardClaimed: "Claimed Golden Hat from Summer Campaign",
          activityPageContextOpened: "Opened managed page context for kick.com",
          platformActivity: "Kick activity",
          platformDiagnostics: "Kick diagnostics",
          activityViewTab: "Activity",
          diagnosticsViewTab: "Diagnostics",
          noActivity: "No activity recorded yet.",
          noDiagnostics: "No diagnostics recorded yet.",
          copyActivityLog: "Copy log",
          copyActivityLogCopied: `Copied ${String(substitutions)} events`,
          copyActivityLogFailed: "Could not copy the log. Try again.",
        })[key] ?? `${key}${substitutions ? "" : ""}`,
        dir: "ltr",
        locale: "en",
      }}>
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          <ActivityLog
            activityEvents={options.activityEvents ?? ACTIVITY}
            diagnosticEvents={options.diagnosticEvents ?? DIAGNOSTICS}
            platform="kick"
            diagnosticLogging={options.diagnosticLogging ?? true}
            showDiagnostics={options.showDiagnostics}
            hasMore={false}
            clearArmed={false}
            clearFailed={false}
            loadingMore={false}
            clearing={false}
            version="1.9.0"
            locale="en"
            onShowDiagnosticsChange={onShowDiagnosticsChange}
            onLoadMore={() => undefined}
            onClear={() => undefined}
            writeClipboard={options.omitClipboard ? undefined : writeClipboard}
          />
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  });

  return { container, onShowDiagnosticsChange, writeClipboard, openLink };
}

const copyButton = (container: Element) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Copy log") || button.textContent?.includes("Copied"));

describe("activity log view", () => {
  it("shows only activity entries while the activity view is selected", () => {
    const { container } = mount({ showDiagnostics: false });

    expect(container.textContent).toContain("Claimed Golden Hat from Summer Campaign");
    expect(container.textContent).not.toContain("HTTP 503");
    expect(container.textContent).toContain("Kick activity");
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);
  });

  it("shows only diagnostics while the diagnostics view is selected", () => {
    const { container } = mount({ showDiagnostics: true });

    expect(container.textContent).toContain("HTTP 503");
    expect(container.textContent).not.toContain("Claimed Golden Hat from Summer Campaign");
    expect(container.textContent).toContain("Kick diagnostics");
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);
    expect(container.querySelector("[data-activity-card]")).toBeNull();
  });

  it("keeps authentication transitions out of the user-facing activity stream", () => {
    const events: ActivityHistoryRecord[] = [{
      id: "auth-1",
      at: "2026-07-25T12:00:01.000Z",
      category: "activity",
      code: "auth_health_changed",
      level: "info",
      platform: "kick",
      data: { from: "checking", to: "healthy" },
    }, ...ACTIVITY];
    const { container } = mount({ showDiagnostics: false, activityEvents: events });

    expect(container.querySelector('[data-activity-card="auth_health_changed"]')).toBeNull();
    expect(container.textContent).not.toContain("authentication changed");
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);
  });

  it("marks the selected view on the switch and requests the other one on click", () => {
    const { container, onShowDiagnosticsChange } = mount({ showDiagnostics: false });
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    expect(tabs.map((tab) => tab.textContent)).toEqual(["Activity", "Diagnostics"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);

    act(() => tabs[1]?.click());
    expect(onShowDiagnosticsChange).toHaveBeenCalledWith(true);
  });

  it("counts errors in the view being shown", () => {
    // The only error record is a diagnostic, so the activity view has nothing to
    // badge and the diagnostics view badges one.
    const activityView = mount({ showDiagnostics: false });
    expect(activityView.container.querySelector('[role="status"]')).toBeNull();
    act(() => root?.unmount());

    const diagnosticsView = mount({ showDiagnostics: true });
    expect(diagnosticsView.container.querySelector('[role="status"]')?.textContent).toBe("1");
  });

  it("hides the switch entirely when diagnostic logging is off", () => {
    const { container } = mount({ showDiagnostics: false, diagnosticLogging: false });

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it("uses the diagnostics empty state in the diagnostics view", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.getElementById("app")!;

    act(() => {
      root = createRoot(container);
      root.render(
        <I18nContext.Provider value={{
          t: (key) => ({ noDiagnostics: "No diagnostics recorded yet." })[key] ?? key,
          dir: "ltr",
          locale: "en",
        }}>
          <ActivityLog
            activityEvents={ACTIVITY}
            diagnosticEvents={[]}
            platform="kick"
            diagnosticLogging
            showDiagnostics
            hasMore={false}
            clearArmed={false}
            clearFailed={false}
            loadingMore={false}
            clearing={false}
            version="1.9.0"
            locale="en"
            onShowDiagnosticsChange={() => undefined}
            onLoadMore={() => undefined}
            onClear={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });

    expect(container.textContent).toContain("No diagnostics recorded yet.");
  });

  it("copies the visible view as plain text and confirms the count", async () => {
    const { container, writeClipboard } = mount({ showDiagnostics: true });

    await act(async () => { copyButton(container)?.click(); });

    expect(writeClipboard).toHaveBeenCalledTimes(1);
    const text = (writeClipboard as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain("Lurkloot diagnostics log");
    expect(text).toContain("version: 1.9.0");
    expect(text).toContain("2026-07-25T12:00:01.000Z [error] Kick fetch kick.com failed with HTTP 503");
    expect(text).not.toContain("<");
    expect(copyButton(container)?.textContent).toContain("Copied 1 events");
  });

  it("copies the activity view with localized event text when that view is shown", async () => {
    const { container, writeClipboard } = mount({ showDiagnostics: false });

    await act(async () => { copyButton(container)?.click(); });

    const text = (writeClipboard as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain("Lurkloot activity log");
    expect(text).toContain("Claimed Golden Hat from Summer Campaign");
    expect(text).not.toContain("HTTP 503");
  });

  it("reports a failed clipboard write instead of confirming", async () => {
    const { container } = mount({ showDiagnostics: false, writeClipboard: vi.fn(async () => false) });

    await act(async () => { copyButton(container)?.click(); });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not copy the log. Try again.");
    expect(copyButton(container)?.textContent).toContain("Copy log");
  });

  it("hides the copy control for hosts without a clipboard", () => {
    const { container } = mount({ showDiagnostics: false, omitClipboard: true });

    expect(copyButton(container)).toBeUndefined();
  });

  it("renders a reward card with its image, method chip, and labelled campaign action", () => {
    const { container, openLink } = mount({ showDiagnostics: false });

    expect(container.querySelector("ul")?.className).not.toContain("divide-y");
    expect(container.querySelector('img[alt="Golden Hat"]')?.getAttribute("src"))
      .toBe("https://cdn.example.test/reward.png");
    expect(container.querySelector('[data-activity-card="reward_claimed"]')).not.toBeNull();
    expect(container.querySelector('[data-activity-chip="automatic"]')).not.toBeNull();

    const action = container.querySelector<HTMLButtonElement>('button[aria-label*="Summer Campaign"]');
    expect(action).not.toBeNull();
    act(() => action?.click());
    expect(openLink).toHaveBeenCalledWith("https://www.example.test/campaigns/summer");
  });

  it("does not open a campaign action with a non-HTTPS URL", () => {
    const unsafeActivity: ActivityHistoryRecord[] = [{
      ...ACTIVITY[0],
      data: { ...ACTIVITY[0].data, campaignUrl: "http://www.example.test/campaigns/summer" },
    }];
    const { container, openLink } = mount({ showDiagnostics: false, activityEvents: unsafeActivity });

    const action = container.querySelector<HTMLButtonElement>('button[aria-label*="Summer Campaign"]');
    expect(action).not.toBeNull();
    act(() => action?.click());

    expect(openLink).not.toHaveBeenCalled();
  });

  it("renders a generated reward fallback tile when no reward image is available", () => {
    const withoutImage: ActivityHistoryRecord[] = [{
      ...ACTIVITY[0],
      data: { ...ACTIVITY[0].data, rewardImageUrl: undefined },
    }];
    const { container } = mount({ showDiagnostics: false, activityEvents: withoutImage });

    expect(container.querySelector('img[alt="Golden Hat"]')).toBeNull();
    expect(container.querySelector('[data-activity-reward-fallback]')?.textContent).toBe("G");
  });

  it("renders operational events as marked cards with their localized summary", () => {
    const operationalActivity: ActivityHistoryRecord[] = [{
      id: "page-context-1",
      at: "2026-07-25T12:00:00.000Z",
      category: "activity",
      code: "page_context_opened",
      level: "info",
      platform: "kick",
      data: { host: "kick.com", reason: "background_rejected" },
    }];
    const { container } = mount({ showDiagnostics: false, activityEvents: operationalActivity });

    expect(container.querySelector('[data-activity-card="page_context_opened"]')).not.toBeNull();
    expect(container.textContent).toContain("Opened managed page context for kick.com");
  });
});
