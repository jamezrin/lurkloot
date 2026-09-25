// @vitest-environment happy-dom
// Segmented and Checkbox are Base UI parts, which need real mouse events.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox, Segmented } from "../../popup-ui/src/controls";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
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

describe("Segmented", () => {
  const options = [{ value: "all", label: "All", count: 3 }, { value: "drops", label: "Drops", count: 2 }];

  it("presses the current option and reports a new pick", () => {
    const onChange = vi.fn();
    const container = mount(<Segmented label="Show" value="all" options={options} onChange={onChange} itemAttribute="data-facet" />);
    const item = (value: string) => container.querySelector<HTMLButtonElement>(`[data-facet="${value}"]`)!;

    expect(item("all").getAttribute("aria-pressed")).toBe("true");
    expect(item("drops").getAttribute("aria-pressed")).toBe("false");
    expect(item("drops").textContent).toBe("Drops2");

    act(() => item("drops").click());
    expect(onChange).toHaveBeenCalledWith("drops");
  });

  it("never un-presses the only pressed option", () => {
    const onChange = vi.fn();
    const container = mount(<Segmented label="Show" value="all" options={options} onChange={onChange} itemAttribute="data-facet" />);
    act(() => container.querySelector<HTMLButtonElement>('[data-facet="all"]')!.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Checkbox", () => {
  it("is a real checkbox that reports the next state", () => {
    const onChange = vi.fn();
    const container = mount(<Checkbox checked={false} onChange={onChange} label="Farm Rust" attributes={{ "data-game-select": "" }} />);
    const box = container.querySelector<HTMLButtonElement>("[data-game-select]")!;

    expect(box.getAttribute("role")).toBe("checkbox");
    expect(box.getAttribute("aria-checked")).toBe("false");
    act(() => box.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
