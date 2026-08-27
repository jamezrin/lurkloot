import { describe, expect, it, vi } from "vitest";
import { suppressPhantomResize, type ResizeTarget } from "../src/core/popupResize";

function fakeWindow(width: number, height: number) {
  let handler: ((event: Event) => void) | undefined;
  const target: ResizeTarget = {
    innerWidth: width,
    innerHeight: height,
    addEventListener: (_type, fn) => { handler = fn; },
    removeEventListener: () => { handler = undefined; },
  };
  return {
    target,
    hasListener: () => handler !== undefined,
    /** Fire a resize and report whether it was swallowed. */
    fireResize(): boolean {
      const stopImmediatePropagation = vi.fn();
      handler?.({ stopImmediatePropagation } as unknown as Event);
      return stopImmediatePropagation.mock.calls.length > 0;
    },
    resizeTo(next: { width?: number; height?: number }): void {
      if (next.width !== undefined) target.innerWidth = next.width;
      if (next.height !== undefined) target.innerHeight = next.height;
    },
  };
}

describe("suppressPhantomResize", () => {
  it("swallows a resize that did not change the size", () => {
    // The popup re-measures itself constantly and fires `resize` at an
    // unchanged size; dnd-kit would cancel the in-flight drag on it (#431).
    const win = fakeWindow(400, 600);
    suppressPhantomResize(win.target);

    expect(win.fireResize()).toBe(true);
    expect(win.fireResize()).toBe(true);
  });

  it("lets a resize through when the width changed", () => {
    const win = fakeWindow(400, 600);
    suppressPhantomResize(win.target);

    win.resizeTo({ width: 360 });
    expect(win.fireResize()).toBe(false);
  });

  it("lets a resize through when the height changed", () => {
    const win = fakeWindow(400, 600);
    suppressPhantomResize(win.target);

    win.resizeTo({ height: 540 });
    expect(win.fireResize()).toBe(false);
  });

  it("swallows repeats after a real resize settles at the new size", () => {
    const win = fakeWindow(400, 600);
    suppressPhantomResize(win.target);

    win.resizeTo({ width: 360, height: 540 });
    expect(win.fireResize()).toBe(false);
    expect(win.fireResize()).toBe(true);
  });

  it("stops listening after teardown", () => {
    const win = fakeWindow(400, 600);
    const stop = suppressPhantomResize(win.target);

    expect(win.hasListener()).toBe(true);
    stop();
    expect(win.hasListener()).toBe(false);
  });
});
