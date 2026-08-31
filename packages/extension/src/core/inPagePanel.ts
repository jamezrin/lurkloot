import { browser } from "wxt/browser";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";

// Stage 1 of the in-page panel: a toggle button, and an iframe hosting the
// panel document (entrypoints/inpagePanel) that is loaded on first click.
//
// This module must stay dependency-free. WXT builds content scripts as a single
// IIFE bundle (`formats: ["iife"]` in getLibModeConfig), which forces Rollup's
// inlineDynamicImports, so anything imported here — React, @lurkloot/popup-ui,
// Tailwind — ships on every twitch.tv and kick.com page load whether or not the
// panel is ever opened. Rendering the popup in the content script cost 1.2 MB
// per platform; behind the iframe this bundle stays in single-digit kilobytes.
// The button is styled with hand-written CSS for the same reason.

const HOST_ID = "lurkloot-panel-host";
const SETTINGS_KEY = "settings";
const STATE_KEY = "schedulerState";
const UI_STATE_KEY = "inPagePanelUi";

// The panel document renders <Popup>, whose root is h-[600px] w-[400px]. The
// frame is sized to match exactly: anything smaller reintroduces a scrollbar,
// which steals width from the 400px the popup insists on and makes it overflow
// horizontally.
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 600;
const EDGE_MARGIN = 16;
// Pointer travel past which a press counts as a drag rather than a click, so
// the button can be both draggable and clickable without a separate handle.
const DRAG_THRESHOLD = 4;

interface PanelUiState {
  left?: number;
  top?: number;
  open?: boolean;
}

let host: HTMLDivElement | undefined;
let ownTabId: number | undefined;

export function mountInPagePanel(): void {
  void start();
}

async function start(): Promise<void> {
  // Asked once. A content script cannot read its own tab id, and the id is
  // stable for the document's lifetime, so everything downstream re-evaluates
  // from persisted state rather than re-asking.
  ownTabId = await browser.runtime.sendMessage({ type: "getTabId" }).catch(() => undefined) as number | undefined;

  await reconcile();

  // Both inputs live in storage.local, so watching it covers the settings
  // toggle and the scheduler claiming this tab, with no polling and no second
  // round-trip.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (SETTINGS_KEY in changes || STATE_KEY in changes) void reconcile();
  });

  // Twitch and Kick both put the player into the Fullscreen API. A floating
  // panel over fullscreen video is intrusive, and on Twitch it is drawn above
  // the player controls.
  document.addEventListener("fullscreenchange", applyVisibility);
}

async function reconcile(): Promise<void> {
  const stored = await browser.storage.local.get([SETTINGS_KEY, STATE_KEY]);
  const settings = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  const state = stored[STATE_KEY] as Partial<SchedulerState> | undefined;

  if (settings?.showInPagePanel !== true || isManagedTab(state)) {
    unmount();
    return;
  }
  await ensureMounted();
}

// The extension opens its own muted twitch.tv/kick.com tabs to farm in, and
// content scripts run there like anywhere else. Showing the panel inside one
// would be noise at best, and it would invite the user to interact with a tab
// the scheduler owns and may close.
function isManagedTab(state: Partial<SchedulerState> | undefined): boolean {
  if (ownTabId === undefined || !state) return false;
  const managed = [
    ...Object.values(state.managedWatchTabs ?? {}),
    ...Object.values(state.managedPageContextTabs ?? {}),
  ];
  return managed.some((tab) => tab?.tabId === ownTabId);
}

function unmount(): void {
  host?.remove();
  host = undefined;
}

async function ensureMounted(): Promise<void> {
  if (host?.isConnected) return;

  const ui = (await browser.storage.local.get(UI_STATE_KEY))[UI_STATE_KEY] as PanelUiState | undefined;

  host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "display:flex",
    "flex-direction:column",
    "align-items:flex-end",
    "gap:8px",
  ].join(";");

  // `src` is assigned on first open, not here: a hidden iframe still fetches
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
    "cursor:grab",
    "padding:8px 14px",
    "border-radius:999px",
    "background:#9147ff",
    "color:#fff",
    "font:600 13px/1 system-ui,sans-serif",
    "box-shadow:0 4px 12px rgba(0,0,0,.3)",
  ].join(";");

  host.append(frame, button);
  document.body.append(host);

  position(ui?.left, ui?.top);
  if (ui?.open) openPanel(frame, button);

  button.addEventListener("click", () => {
    if (frame.hidden) openPanel(frame, button);
    else closePanel(frame, button);
    void saveUi({ open: !frame.hidden });
  });

  makeDraggable(host, button, frame);
  applyVisibility();
}

function openPanel(frame: HTMLIFrameElement, button: HTMLButtonElement): void {
  if (!frame.src) frame.src = browser.runtime.getURL("/inpagePanel.html");
  frame.hidden = false;
  button.setAttribute("aria-expanded", "true");
  clampIntoViewport();
}

function closePanel(frame: HTMLIFrameElement, button: HTMLButtonElement): void {
  frame.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function applyVisibility(): void {
  if (host) host.style.display = document.fullscreenElement ? "none" : "flex";
}

function position(left: number | undefined, top: number | undefined): void {
  if (!host) return;
  host.style.left = left === undefined ? "" : `${left}px`;
  host.style.top = top === undefined ? "" : `${top}px`;
  // Falls back to the bottom-right corner until the user moves it.
  host.style.right = left === undefined ? `${EDGE_MARGIN}px` : "";
  host.style.bottom = top === undefined ? `${EDGE_MARGIN}px` : "";
  if (left !== undefined) clampIntoViewport();
}

// A stored position can land off-screen after a resize, a monitor change, or
// simply because opening the panel makes the host 600px taller.
function clampIntoViewport(): void {
  if (!host || host.style.left === "") return;
  const rect = host.getBoundingClientRect();
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN);
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN);
  host.style.left = `${Math.min(Math.max(EDGE_MARGIN, rect.left), maxLeft)}px`;
  host.style.top = `${Math.min(Math.max(EDGE_MARGIN, rect.top), maxTop)}px`;
}

// Dragging is bound to the button rather than a separate title bar. Pointer
// events inside the iframe never reach this document, so a handle drawn over
// the panel would need postMessage; the button is already outside the frame and
// always visible, open or closed.
function makeDraggable(hostEl: HTMLDivElement, button: HTMLButtonElement, frame: HTMLIFrameElement): void {
  let origin: { x: number; y: number; left: number; top: number } | undefined;
  let dragging = false;

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = hostEl.getBoundingClientRect();
    origin = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    button.setPointerCapture(event.pointerId);
  });

  button.addEventListener("pointermove", (event) => {
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    if (!dragging) {
      dragging = true;
      button.style.cursor = "grabbing";
      // While dragging, the iframe must not swallow the pointer stream the
      // moment the cursor crosses over it.
      frame.style.pointerEvents = "none";
    }
    hostEl.style.right = "";
    hostEl.style.bottom = "";
    hostEl.style.left = `${origin.left + dx}px`;
    hostEl.style.top = `${origin.top + dy}px`;
  });

  const end = (event: PointerEvent) => {
    if (!origin) return;
    origin = undefined;
    button.releasePointerCapture(event.pointerId);
    if (!dragging) return;
    dragging = false;
    button.style.cursor = "grab";
    frame.style.pointerEvents = "";
    clampIntoViewport();
    void saveUi({ left: parseFloat(hostEl.style.left), top: parseFloat(hostEl.style.top) });
    // Suppress the click this pointer sequence is about to fire, so finishing a
    // drag does not also toggle the panel.
    button.addEventListener("click", (click) => click.stopImmediatePropagation(), { capture: true, once: true });
  };
  button.addEventListener("pointerup", end);
  button.addEventListener("pointercancel", end);

  window.addEventListener("resize", clampIntoViewport);
}

async function saveUi(patch: PanelUiState): Promise<void> {
  const current = (await browser.storage.local.get(UI_STATE_KEY))[UI_STATE_KEY] as PanelUiState | undefined;
  await browser.storage.local.set({ [UI_STATE_KEY]: { ...current, ...patch } });
}
