import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { sendMessage: vi.fn(), getURL: vi.fn() },
    storage: { local: { get: vi.fn(), set: vi.fn() }, onChanged: { addListener: vi.fn() } },
  },
}));

const { resolveAnchorFor } = await import("../src/core/inPagePanel");

// linkedom has no layout, so getClientRects cannot tell the responsive twins
// apart the way a browser does. The predicate stands in for that: a nav marked
// with one of Tailwind's hidden-at-this-breakpoint classes is the one the
// viewport is not rendering.
function renderedAtDesktopWidth(element: Element | null | undefined): boolean {
  if (!element) return false;
  const nav = element.closest("nav") ?? element;
  return !nav.className.includes("lg:hidden") || nav.className.includes("max-lg:hidden");
}

function setDocument(html: string): void {
  globalThis.document = parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
}

// Kick renders both bars at all times and hides one with a media query. The
// mobile bar comes first in document order, which is the whole bug.
const KICK_NAVS = `
  <nav class="fixed top-0 z-navbar flex h-[var(--navbar-height)] lg:hidden">
    <div id="mobile-left"></div>
    <div id="mobile-cluster"></div>
  </nav>
  <nav class="relative top-0 z-[402] flex h-(--navbar-height) max-lg:hidden">
    <div id="desktop-left"></div>
    <div id="desktop-cluster"></div>
  </nav>
`;

describe("in-page panel anchor", () => {
  beforeEach(() => {
    setDocument("");
  });

  it("skips Kick's hidden mobile nav and takes the rendered desktop one", () => {
    setDocument(KICK_NAVS);

    const resolved = resolveAnchorFor("kick", renderedAtDesktopWidth);

    expect(resolved).not.toBe("noneRendered");
    expect(resolved).not.toBe("noMatch");
    expect((resolved as { element: Element }).element.id).toBe("desktop-cluster");
    expect((resolved as { place: string }).place).toBe("prepend");
  });

  it("reports no rendered anchor when every nav is collapsed", () => {
    setDocument(KICK_NAVS);

    expect(resolveAnchorFor("kick", () => false)).toBe("noneRendered");
  });

  it("reports no match when the nav is gone entirely", () => {
    setDocument(`<div id="unrelated"></div>`);

    expect(resolveAnchorFor("kick", renderedAtDesktopWidth)).toBe("noMatch");
    expect(resolveAnchorFor("twitch", renderedAtDesktopWidth)).toBe("noMatch");
  });

  it("still places the Twitch button before the Prime crown", () => {
    setDocument(`
      <nav class="top-nav">
        <div class="top-nav__menu">
          <div class="top-nav__prime" id="prime"></div>
        </div>
      </nav>
    `);

    const resolved = resolveAnchorFor("twitch", renderedAtDesktopWidth);

    expect((resolved as { element: Element }).element.id).toBe("prime");
    expect((resolved as { place: string }).place).toBe("before");
  });

  it("falls back to Twitch's nav menu when the Prime crown is absent", () => {
    setDocument(`<nav class="top-nav"><div class="top-nav__menu" id="menu"></div></nav>`);

    const resolved = resolveAnchorFor("twitch", renderedAtDesktopWidth);

    expect((resolved as { element: Element }).element.id).toBe("menu");
    expect((resolved as { place: string }).place).toBe("append");
  });
});
