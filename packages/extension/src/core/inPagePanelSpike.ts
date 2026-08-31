import { browser } from "wxt/browser";

// SPIKE ONLY — see docs/spikes/in-page-panel-frame-embedding.md.
//
// Stage 1 of the two-stage in-page panel: inject a small toggle button, and on
// click insert an iframe pointing at the extension's own panel page (stage 2).
//
// The design constraint this file exists to demonstrate: stage 1 must stay
// dependency-free. No React, no @lurkloot/popup-ui, no @lurkloot/core, and no
// Tailwind — WXT builds content scripts as a single IIFE bundle
// (`formats: ["iife"]`), so anything imported here ships on every twitch.tv and
// kick.com page load whether or not the user ever opens the panel. Styling is
// hand-written for the same reason.
//
// Unlike the real feature this is not gated behind a setting and has no drag,
// persistence, or managed-tab suppression; it answers the CSP question only.

const HOST_ID = "lurkloot-panel-host";

export function mountInPagePanelSpike(): void {
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
    "font:13px/1.5 system-ui,sans-serif",
  ].join(";");

  const frame = document.createElement("iframe");
  frame.src = browser.runtime.getURL("/inpagePanel.html");
  frame.title = "Lurkloot";
  frame.hidden = true;
  frame.style.cssText = [
    "width:400px",
    "height:280px",
    "border:0",
    "border-radius:12px",
    "background:#fff",
    "box-shadow:0 12px 32px rgba(0,0,0,.35)",
    "color-scheme:light",
  ].join(";");

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Lurkloot";
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
    // Keep the frame mounted after the first open so reopening is instant and
    // the panel keeps its state; only visibility toggles.
    frame.hidden = !frame.hidden;
  });

  host.append(frame, button);
  document.body.append(host);
}
