import { parseHTML } from "linkedom";

// Popup tests render React into a linkedom document and stub only `window` and
// `document`. The Base UI components the popup uses (via floating-ui) also test
// nodes against the global DOM constructors — `value instanceof HTMLElement` —
// which Node does not define. Expose linkedom's classes as those globals; its
// classes are shared across documents, so instanceof holds for every test's
// own parseHTML() tree. Anything a test stubs itself still wins.
const { window } = parseHTML("<html></html>");
const constructors = ["Node", "Element", "HTMLElement", "SVGElement", "HTMLInputElement", "HTMLButtonElement", "DocumentFragment", "ShadowRoot"] as const;
for (const name of constructors) {
  const value = (window as unknown as Record<string, unknown>)[name];
  if (value && !(name in globalThis)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
