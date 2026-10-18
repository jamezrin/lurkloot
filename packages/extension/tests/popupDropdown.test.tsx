// @vitest-environment happy-dom
// Dropdown is a Base UI Select, which needs real mouse and keyboard events;
// linkedom has none.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropdown } from "../../popup-ui/src/dropdown";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function openDropdown(): { scroller: HTMLElement; trigger: HTMLElement } {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <div data-scroller="" style={{ overflowY: "auto" }}>
        <Dropdown
          label="Then by"
          value="a"
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
          onChange={() => undefined}
          attributes={{ "data-dropdown": "" }}
        />
      </div>,
    );
  });
  const trigger = container.querySelector<HTMLElement>("[data-dropdown]")!;
  act(() => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.click();
  });
  return { scroller: container.querySelector<HTMLElement>("[data-scroller]")!, trigger };
}

const isOpen = (trigger: HTMLElement) => trigger.hasAttribute("data-popup-open");

describe("Dropdown", () => {
  it("closes when the page scrolls under it", () => {
    const { scroller, trigger } = openDropdown();
    expect(isOpen(trigger)).toBe(true);
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(isOpen(trigger)).toBe(false);
  });

  it("stays open while its own list scrolls", () => {
    const { trigger } = openDropdown();
    act(() => {
      document.querySelector("[role=listbox]")!.dispatchEvent(new Event("scroll"));
    });
    expect(isOpen(trigger)).toBe(true);
  });
});
