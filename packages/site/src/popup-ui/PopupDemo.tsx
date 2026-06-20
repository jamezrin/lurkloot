// Renders the shared popup UI inside a Shadow DOM, isolated from the landing
// page's styles and backed by deterministic demo data.
import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Popup, createDemoPopupAdapter, screenshotVariant } from "@lurkloot/popup-ui";
import popupCss from "@lurkloot/popup-ui/styles.css?inline";

// Tailwind v4 backs many utilities (border-style, shadows, rings, gradients,
// transforms…) with registered @property custom properties. @property only
// registers at the document level — the browser ignores @property rules that
// live inside a Shadow DOM <style>, so those typed vars never get their initial
// values and utilities like `border` silently resolve to `none`. We register
// them globally via CSS.registerProperty (the JS equivalent of @property),
// reading the already-parsed rules off the shadow stylesheet. Registration is
// global + idempotent, so re-runs and extra instances are harmless.
function registerTailwindProperties(sheet: CSSStyleSheet | null) {
  if (!sheet || typeof CSS === "undefined" || !CSS.registerProperty || !("CSSPropertyRule" in window)) return;
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSPropertyRule)) continue;
    try {
      CSS.registerProperty({
        name: rule.name,
        syntax: rule.syntax,
        inherits: rule.inherits,
        ...(rule.initialValue ? { initialValue: rule.initialValue } : {}),
      });
    } catch {
      // Already registered (or registered by another instance) — expected.
    }
  }
}

export default function PopupDemo() {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Root | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || rootRef.current) return;

    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = popupCss;
    const mount = document.createElement("div");
    shadow.replaceChildren(style, mount);

    // @property rules in the shadow stylesheet are ignored by the browser; lift
    // their registration to the document so Tailwind's typed --tw-* vars resolve.
    registerTailwindProperties(style.sheet);

    // A dedicated React root INSIDE the shadow tree: events + styles stay fully
    // contained, no portal/event-retargeting caveats.
    const root = createRoot(mount);
    rootRef.current = root;
    const adapter = createDemoPopupAdapter({ locale: "en", version: "1.0.0" });
    root.render(
      <Popup
        adapter={adapter}
        initialState={{ preview: true, locale: "en", variant: screenshotVariant("twitch-drops") }}
      />,
    );

    return () => {
      rootRef.current = null;
      // Defer so StrictMode's dev double-invoke doesn't unmount mid-render.
      queueMicrotask(() => root.unmount());
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="sa-popup-host"
      data-lenis-prevent
      aria-label="Lurkloot popup — interactive demo"
    />
  );
}
