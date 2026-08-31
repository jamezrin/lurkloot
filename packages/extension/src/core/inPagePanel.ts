import { browser } from "wxt/browser";

// Stage 1 of the in-page panel: a toggle button, and an iframe hosting the
// panel document (entrypoints/inpagePanel) that is loaded on first click.
//
// This module must stay dependency-free. WXT builds content scripts as a single
// IIFE bundle (`formats: ["iife"]` in getLibModeConfig), which forces Rollup's
// inlineDynamicImports, so anything imported here — React, @lurkloot/popup-ui,
// Tailwind — ships on every twitch.tv and kick.com page load whether or not the
// panel is ever opened. Rendering the popup in the content script cost 1.2 MB
// per platform; keeping it behind the iframe keeps this bundle in single-digit
// kilobytes. The button is styled with hand-written CSS for the same reason.

const HOST_ID = "lurkloot-panel-host";

// The panel document renders <Popup>, whose root is h-[600px] w-[400px]. The
// frame is sized to match exactly: anything smaller reintroduces a scrollbar,
// which steals width from the 400px the popup insists on and makes it overflow
// horizontally.
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 600;

export function mountInPagePanel(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "display:flex",
    "flex-direction:column",
    "align-items:flex-end",
    "gap:8px",
  ].join(";");

  // `src` is assigned on first click, not here: a hidden iframe still fetches
  // its src, so setting it up front would load the panel on every page view and
  // give up the reason for splitting the stages at all.
  const frame = document.createElement("iframe");
  frame.title = "Lurkloot";
  frame.hidden = true;
  frame.style.cssText = [
    `width:${PANEL_WIDTH}px`,
    `height:${PANEL_HEIGHT}px`,
    "border:0",
    "border-radius:12px",
    "box-shadow:0 12px 32px rgba(0,0,0,.35)",
    "color-scheme:normal",
  ].join(";");

  // Text-only, deliberately: the popup's logo is served from the extension
  // origin, and a content script cannot reference it without making the image a
  // second web-accessible resource. Not worth widening the manifest for a pill.
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Lurkloot";
  button.setAttribute("aria-expanded", "false");
  button.style.cssText = [
    "all:unset",
    "box-sizing:border-box",
    "cursor:pointer",
    "padding:8px 14px",
    "border-radius:999px",
    "background:#9147ff",
    "color:#fff",
    "font:600 13px/1 system-ui,sans-serif",
    "box-shadow:0 4px 12px rgba(0,0,0,.3)",
  ].join(";");
  button.addEventListener("click", () => {
    if (!frame.src) frame.src = browser.runtime.getURL("/inpagePanel.html");
    frame.hidden = !frame.hidden;
    button.setAttribute("aria-expanded", String(!frame.hidden));
  });

  host.append(frame, button);
  document.body.append(host);
}
