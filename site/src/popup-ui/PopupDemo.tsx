// Renders the REAL extension popup (entrypoints/popup/app.tsx) inside a Shadow
// DOM, with the extension's compiled CSS injected — so it looks and behaves
// exactly like the extension, isolated from the landing page's styles, running
// on mock data (no extension/background). Hydrated as an Astro island.
import "./browser-mock"; // sets the demo global + aliases `wxt/browser` — must run first
import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Popup } from "@ext/entrypoints/popup/app";
import popupCss from "./popup.generated.css?inline";

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

    // A dedicated React root INSIDE the shadow tree: events + styles stay fully
    // contained, no portal/event-retargeting caveats.
    const root = createRoot(mount);
    rootRef.current = root;
    root.render(<Popup />);

    return () => {
      rootRef.current = null;
      // Defer so StrictMode's dev double-invoke doesn't unmount mid-render.
      queueMicrotask(() => root.unmount());
    };
  }, []);

  return <div ref={hostRef} className="sa-popup-host" aria-label="Stream Autopilot popup — interactive demo" />;
}
