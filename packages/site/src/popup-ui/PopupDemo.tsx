// Renders the shared popup UI inside a Shadow DOM, isolated from the landing
// page's styles and backed by deterministic demo data.
import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Popup, createDemoPopupAdapter, screenshotVariant } from "@lurkloot/popup-ui";
import popupCss from "@lurkloot/popup-ui/styles.css?inline";

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
