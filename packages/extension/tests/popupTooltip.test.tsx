// @vitest-environment happy-dom
// The popup's tooltip is Base UI's, which needs real pointer events.
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageWithFallback } from "../../popup-ui/src/primitives";
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

async function hover(element: Element): Promise<void> {
  await act(async () => {
    for (const type of ["pointerenter", "mouseenter", "pointermove", "mousemove"]) {
      element.dispatchEvent(
        new MouseEvent(type, { bubbles: type.endsWith("move"), clientX: 5, clientY: 5 }),
      );
    }
    await vi.advanceTimersByTimeAsync(1000);
  });
}

describe("popup tooltip", () => {
  it("shows the hint on hover from one shared tooltip, with no native title", async () => {
    vi.useFakeTimers();
    const container = mount(
      <TooltipScope>
        <Tip label="Pin to the top">
          <button type="button" data-pin>
            pin
          </button>
        </Tip>
        <Tip label="Show details">
          <button type="button" data-more>
            more
          </button>
        </Tip>
      </TooltipScope>,
    );
    const pin = container.querySelector<HTMLButtonElement>("[data-pin]")!;
    expect(pin.hasAttribute("title")).toBe(false);
    expect(pin.getAttribute("data-tooltip")).toBe("Pin to the top");

    await act(async () => {
      for (const type of ["pointerenter", "mouseenter", "pointermove", "mousemove"]) {
        pin.dispatchEvent(
          new MouseEvent(type, { bubbles: type.endsWith("move"), clientX: 5, clientY: 5 }),
        );
      }
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hint()).toBe("Pin to the top");
  });

  it("falls back to a native title outside a popup", () => {
    const container = mount(
      <Tip label="Dismiss">
        <button type="button">x</button>
      </Tip>,
    );
    expect(container.querySelector("button")?.getAttribute("title")).toBe("Dismiss");
  });

  it("leaves the child untouched without a label", () => {
    const container = mount(
      <TooltipScope>
        <Tip label={undefined}>
          <button type="button">x</button>
        </Tip>
      </TooltipScope>,
    );
    const button = container.querySelector("button")!;
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.hasAttribute("data-tooltip")).toBe(false);
  });

  it("shows a larger copy of a zoomable image on hover, from the same tooltip", async () => {
    vi.useFakeTimers();
    const container = mount(
      <TooltipScope>
        <ImageWithFallback src="https://example.test/box.png" alt="Game" fallback={null} zoom />
      </TooltipScope>,
    );
    const image = container.querySelector<HTMLImageElement>("img")!;
    expect(image.hasAttribute("data-zoom-image")).toBe(true);

    await hover(image);
    const preview = document.querySelector("[data-zoom-preview] img");
    expect(preview?.getAttribute("src")).toBe("https://example.test/box.png");
    // The thumbnail's own alt names the image; the copy is decorative.
    expect(preview?.getAttribute("alt")).toBe("");
  });

  it("leaves an image without zoom out of the tooltip", () => {
    const container = mount(
      <TooltipScope>
        <ImageWithFallback src="https://example.test/box.png" alt="Game" fallback={null} />
      </TooltipScope>,
    );
    expect(container.querySelector("img")?.hasAttribute("data-zoom-image")).toBe(false);
  });
});
