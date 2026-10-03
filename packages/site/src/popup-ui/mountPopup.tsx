// Renders the shared popup UI inside a Shadow DOM, isolated from the landing
// page's styles and backed by deterministic demo data. Used by the interactive
// demo and by the read-only excerpts that illustrate a section.
import { createRoot } from "react-dom/client";
import { Popup, createDemoPopupAdapter, screenshotVariant, type PopupView } from "@lurkloot/popup-ui";
import popupCss from "@lurkloot/popup-ui/styles.css?inline";
import rootManifest from "../../../../package.json";

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

export interface MountOptions {
  // Extra rules for the shadow stylesheet, e.g. to drop the popup's own frame.
  css?: string;
  // Open on this view instead of the drops queue.
  view?: PopupView;
}

/** Mounts the real popup into `host`'s shadow root and returns the shadow root
 * plus an unmount function. */
export function mountPopup(host: HTMLElement, options: MountOptions = {}): { shadow: ShadowRoot; unmount(): void } {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = popupCss + (options.css ? `\n${options.css}` : "");
  const mount = document.createElement("div");
  shadow.replaceChildren(style, mount);
  registerTailwindProperties(style.sheet);

  // A dedicated React root INSIDE the shadow tree: events + styles stay fully
  // contained, no portal/event-retargeting caveats.
  const root = createRoot(mount);
  const adapter = createDemoPopupAdapter({ locale: "en", version: rootManifest.version });
  root.render(
    <Popup
      adapter={adapter}
      initialState={{ preview: true, locale: "en", variant: screenshotVariant("twitch-drops"), view: options.view }}
    />,
  );
  return {
    shadow,
    // Deferred so StrictMode's dev double-invoke doesn't unmount mid-render.
    unmount: () => queueMicrotask(() => root.unmount()),
  };
}

export const FRAMELESS_CSS = "main[data-platform] { border: 0 !important; box-shadow: none !important; }";
