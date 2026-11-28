// @vitest-environment happy-dom
// The toggle is a Base UI switch, which needs real mouse events.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchPauseSchedule } from "@lurkloot/shared/watchPauseSchedule";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import type { PopupAdapter } from "../../popup-ui/src/types";
import { WatchPauseScheduleSettings } from "../../popup-ui/src/watchPauseSettings";
import { automationPresentation } from "../../popup-ui/src/automationStatus";
import en from "../../locales/messages/en.json";

const messages = en as Record<string, { message: string }>;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function t(key: string, substitution?: string | string[]): string {
  const values = Array.isArray(substitution) ? substitution : substitution ? [substitution] : [];
  return values.reduce(
    (text, value, index) => text.replaceAll(`$${index + 1}`, value),
    messages[key]?.message ?? key,
  );
}

function mount(schedule: WatchPauseSchedule) {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onChange = vi.fn(async (_schedule: WatchPauseSchedule) => undefined);
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <PopupRuntimeContext.Provider value={{ adapter: {} as PopupAdapter, preview: true }}>
        <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>
          <WatchPauseScheduleSettings schedule={schedule} onChange={onChange} />
        </I18nContext.Provider>
      </PopupRuntimeContext.Provider>,
    );
  });
  return { container, onChange };
}

function setInput(input: HTMLInputElement, value: string, blur = false): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (blur) input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const ON: WatchPauseSchedule = { enabled: true, start: "22:00", end: "06:00", timeZone: "UTC" };

describe("daily watch pause settings", () => {
  it("adopts this device's zone when first switched on", () => {
    const { container, onChange } = mount({ ...ON, enabled: false });
    expect(container.querySelector("[data-watch-pause-start]")).toBeNull();
    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith({
      ...ON,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("shows the next pause and that the window crosses midnight", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-01T12:00:00Z");
    const { container } = mount(ON);
    const status = container.querySelector("[data-watch-pause-status]")!.textContent;
    expect(status).toContain(t("watchPauseOvernightHint"));
    expect(status).toContain("Next pause at");
  });

  it("shows when an active window resumes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const { container } = mount(ON);
    expect(container.querySelector("[data-watch-pause-status]")!.textContent).toContain(
      "Paused now, resumes at",
    );
  });

  it("saves a valid change and refuses equal times and unknown zones", () => {
    const { container, onChange } = mount(ON);
    const start = container.querySelector("[data-watch-pause-start]") as HTMLInputElement;
    const zone = container.querySelector("[data-watch-pause-time-zone]") as HTMLInputElement;

    setInput(start, "23:15");
    expect(onChange).toHaveBeenLastCalledWith({ ...ON, start: "23:15" });

    onChange.mockClear();
    setInput(start, "06:00");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("[data-watch-pause-status]")!.textContent).toBe(
      t("watchPauseSameTime"),
    );

    setInput(start, "22:00");
    onChange.mockClear();
    setInput(zone, "Mars/Olympus", true);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("[data-watch-pause-status]")!.textContent).toBe(
      t("watchPauseInvalidTimeZone"),
    );

    setInput(zone, "Europe/Madrid", true);
    expect(onChange).toHaveBeenLastCalledWith({ ...ON, timeZone: "Europe/Madrid" });
  });
});

describe("daily watch pause status", () => {
  it("says the platform is paused by the schedule and when it resumes", () => {
    const presentation = automationPresentation({
      platform: "kick",
      enabled: true,
      pending: false,
      authHealth: { status: "healthy" },
      session: {
        platform: "kick",
        status: "paused",
        offlineChecks: 0,
        reasonCode: "scheduled_pause",
      },
      scheduledResume: "06:00",
    });
    expect(presentation).toMatchObject({
      state: "paused_scheduled",
      badgeKey: "automationPausedSchedule",
      detailKey: "scheduledPauseResumeDetail",
      detailArgs: ["06:00"],
      operational: false,
    });
  });

  it("keeps a manual tab-close pause ahead of the schedule", () => {
    const presentation = automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: false,
      authHealth: { status: "healthy" },
      session: {
        platform: "twitch",
        status: "paused",
        offlineChecks: 0,
        reasonCode: "scheduled_pause",
      },
      manualClosePaused: true,
      scheduledResume: "06:00",
    });
    expect(presentation.state).toBe("paused_tab_closed");
  });
});
