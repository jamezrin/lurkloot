import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CriticalFailurePanel } from "@lurkloot/popup-ui";
import type { CriticalFailureReason } from "@lurkloot/shared/criticalHealth";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const REPORT = "# Lurkloot critical failure report\n\nREPORT BODY";

async function mountPanel(overrides?: {
  reason?: CriticalFailureReason;
  writeClipboard?: (text: string) => Promise<boolean>;
}) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const props = {
    platform: "kick" as const,
    reason: overrides?.reason ?? ("page_context_churn" as CriticalFailureReason),
    buildReport: vi.fn(() => REPORT),
    onDismiss: vi.fn(),
    openLink: vi.fn(),
    writeClipboard: overrides?.writeClipboard ?? vi.fn(async () => true),
  };

  const container = document.getElementById("app") as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root!.render(<CriticalFailurePanel {...props} />);
  });

  const buttons = (): HTMLButtonElement[] =>
    [...container.querySelectorAll("button")] as unknown as HTMLButtonElement[];

  return { props, container, buttons };
}

describe("critical failure panel", () => {
  it("copies the report and opens a prefilled issue", async () => {
    const { props, buttons } = await mountPanel();

    await act(async () => {
      buttons()[0].click();
    });

    expect(props.writeClipboard).toHaveBeenCalledWith(REPORT);
    expect(props.openLink).toHaveBeenCalledTimes(1);
    const opened = props.openLink.mock.calls[0][0] as string;
    expect(opened).toContain("https://github.com/jamezrin/lurkloot/issues/new");
    expect(opened).toContain("title=");
    expect(decodeURIComponent(opened)).toContain("page_context_churn");
  });

  it("shows the report for manual copying and does not open an issue when the clipboard fails", async () => {
    const { props, container, buttons } = await mountPanel({ writeClipboard: vi.fn(async () => false) });
    expect(container.querySelector("textarea")).toBeNull();

    await act(async () => {
      buttons()[0].click();
    });

    // The fallback textarea appears only when the copy failed, giving the user
    // something to select by hand.
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(props.buildReport).toHaveBeenCalled();
    // Sending someone to a blank issue form with an empty clipboard is worse
    // than showing them the text to copy by hand.
    expect(props.openLink).not.toHaveBeenCalled();
  });

  it("dismisses on request without building a report", async () => {
    const { props, buttons } = await mountPanel();

    await act(async () => {
      buttons()[1].click();
    });

    expect(props.onDismiss).toHaveBeenCalledTimes(1);
    expect(props.buildReport).not.toHaveBeenCalled();
  });

  it("explains the stalled-progress case differently from the tab-churn case", async () => {
    const churn = await mountPanel();
    const churnText = churn.container.textContent ?? "";
    act(() => root?.unmount());
    root = undefined;

    const stalled = await mountPanel({ reason: "no_progress" });
    const stalledText = stalled.container.textContent ?? "";

    expect(churnText).not.toBe(stalledText);
  });
});
