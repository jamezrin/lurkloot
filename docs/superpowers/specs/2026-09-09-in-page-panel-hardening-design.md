# In-page panel hardening (approach A)

Date: 2026-09-09  
Status: approved for implementation planning  
Target: `develop` ahead of 1.13.0  
Default: `showInPagePanel` stays **true**

## Problem

The in-page panel ships default-on for discoverability (people who do not pin the extension). The current implementation leaves stable, greppable fingerprints on every Twitch/Kick page:

- Fixed DOM ids: `lurkloot-nav-button`, `lurkloot-panel`
- Visible “Lurkloot” wordmark in the nav button and panel title bar
- WAR resource named `inpagePanel.html`
- Page `console.warn('[Lurkloot] …')` when the nav anchor is missing

A dumb client-side scan can match those strings. Broader extension/farming signals (content scripts, MAIN-world keep-alive, host permissions, install id) are out of scope for this pass.

## Goals

- Keep the panel **default-on**
- Remove stable DOM/WAR/console product fingerprints that a static page scan can match
- Keep discoverability: icon-only chrome is still obvious as a control; tooltip/aria may still say Lurkloot
- Small, testable change that does not touch farming reliability

## Non-goals

- Flipping `showInPagePanel` to default-off
- Shadow DOM or per-navigation id randomization
- Changing MAIN-world keep-alive, playback telemetry, or other farming content-script behavior
- Hiding extension install, Firefox fixed id, or `host_permissions`
- Making farming API traffic stealthy

## Approach

**A — Opaque per-install tokens + quiet chrome** (chosen).

### 1. Per-install opaque DOM tokens

On first panel mount/reconcile, ensure a record in `storage.local` (e.g. key `inPagePanelDom`):

| Field | Meaning |
|-------|---------|
| `buttonId` | Opaque id for the nav button element |
| `panelId` | Opaque id for the floating panel root |

Rules:

- Generate with `crypto.getRandomValues` (hex or base36), length ~12–16
- Must not contain literals like `lurkloot`, `panel`, or `nav`
- Persist across reloads; regenerate only if missing or corrupt
- Module lookups use these stored ids exclusively (no scattered hard-coded id strings)

### 2. Icon-only visible chrome

- Nav button: monochrome SVG icon only — remove the visible `<span>Lurkloot</span>` wordmark
- Panel title bar: no visible “Lurkloot” text (generic/empty chrome label, or icon-only)
- `title` / accessible name may still say “Open Lurkloot” (or equivalent) so hover and screen readers stay clear
- Popup document inside the iframe remains the real Lurkloot popup once opened (trusted extension page; not page-DOM branding)

### 3. WAR rename

In `packages/extension/wxt.config.ts` and the panel entrypoint wiring:

- Rename packaged panel document from `inpagePanel.html` to a **static opaque** filename in the repo (e.g. `p.html` or similar short opaque name)
- WAR paths cannot be per-install; opacity here is “not an obvious product string,” not per-user secrecy
- Keep `matches` scoped to `https://*.twitch.tv/*` and `https://*.kick.com/*` on Chromium
- Preserve the existing comment: never `<all_urls>`; note Firefox MV2 still flattens WAR without `matches`
- Update `browser.runtime.getURL(...)` in `inPagePanel.ts` (and any WXT entry path) to the new filename

### 4. Console quieting

- Replace `console.warn('[Lurkloot] …')` with a generic warn-once message that does not include the product name
- Still useful for someone debugging a missing nav button; just not a branded fingerprint

## Files likely touched

- `packages/extension/src/core/inPagePanel.ts` — tokens, icon-only chrome, getURL, console
- `packages/extension/wxt.config.ts` — WAR resource name
- Panel entrypoint / public asset naming as required by WXT for the renamed HTML document
- Extension tests that assert fixed `#lurkloot-*` ids, visible wordmark, or `inpagePanel.html`
- `packages/extension/tests/settings.test.ts` — default-on pin stays; add/adjust coverage for icon-only + opaque ids as needed

## Testing / verification

Automated:

- Default `showInPagePanel` remains `true`
- Button has no visible text node “Lurkloot”
- Button/panel ids are non-empty, opaque, and stable across reconcile
- No assertions remain on `#lurkloot-nav-button` / `#lurkloot-panel`
- Built manifest WAR list does not include `inpagePanel.html`

Manual:

- Twitch + Kick: icon-only nav button appears; tooltip still names Lurkloot
- Open/close/drag panel; fullscreen still hides chrome
- Managed farming tab still gets no button
- Firefox: panel iframe still loads despite WAR flattening

## Success criteria

- Page DOM no longer exposes stable `lurkloot-*` element ids or a visible Lurkloot wordmark in panel chrome
- WAR resource name is opaque; page console warnings are unbranded
- Panel remains default-on and functionally unchanged for end users who rely on tooltip/aria
- Farming paths untouched

## Follow-ups (explicitly later)

- Shadow DOM / per-load id churn (approach B)
- Deeper CS/WAR surgery (approach C)
- Softening tooltip/aria if product later wants zero product strings in page-accessible attributes
