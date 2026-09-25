// @vitest-environment happy-dom
// The popup's tooltip is Base UI's, which needs real pointer events.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tip, TooltipScope } from "../../popup-ui/src/tooltip";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(node: React.ReactElement): HTMLElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = "<div id=app></div>";
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return container;
}

// The positioner is the outermost element carrying data-side.
const hint = () => document.querySelector("[data-side]")?.textContent ?? "";

describe("popup tooltip", () => {
  it("shows the hint on hover from one shared tooltip, with no native title", async () => {
    vi.useFakeTimers();
    const container = mount(
      <TooltipScope>
        <Tip label="Pin to the top"><button type="button" data-pin>pin</button></Tip>
        <Tip label="Show details"><button type="button" data-more>more</button></Tip>
      </TooltipScope>,
    );
    const pin = container.querySelector<HTMLButtonElement>("[data-pin]")!;
    expect(pin.hasAttribute("title")).toBe(false);
    expect(pin.getAttribute("data-tooltip")).toBe("Pin to the top");

    await act(async () => {
      for (const type of ["pointerenter", "mouseenter", "pointermove", "mousemove"]) {
        pin.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith("move"), clientX: 5, clientY: 5 }));
      }
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hint()).toBe("Pin to the top");
  });

  it("falls back to a native title outside a popup", () => {
    const container = mount(<Tip label="Dismiss"><button type="button">x</button></Tip>);
    expect(container.querySelector("button")?.getAttribute("title")).toBe("Dismiss");
  });

  it("leaves the child untouched without a label", () => {
    const container = mount(<TooltipScope><Tip label={undefined}><button type="button">x</button></Tip></TooltipScope>);
    const button = container.querySelector("button")!;
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.hasAttribute("data-tooltip")).toBe(false);
  });
});
