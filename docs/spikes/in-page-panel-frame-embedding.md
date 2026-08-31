# Spike: in-page panel frame embedding

Tracking issue: [#446](https://github.com/jamezrin/lurkloot/issues/446)

**Status: awaiting a manual run.** This spike is throwaway; nothing here ships.

## The question

The in-page panel uses two-stage injection: a dependency-free content script
injects a toggle button (stage 1), and clicking it inserts an `<iframe>` pointing
at an extension page that renders the popup UI (stage 2).

Stage 2 must be a separate document rather than a lazily-imported module, because
WXT builds content scripts with `build.lib` + `formats: ["iife"]`
(`wxt/dist/core/builders/vite/index.mjs`, `getLibModeConfig`). Single-format lib
mode forces Rollup's `inlineDynamicImports`, so `await import("./panel")` is
inlined into the same file and still ships on every page load.

That makes one thing load-bearing and unverified:

> Does an extension page listed in `web_accessible_resources` load in an iframe
> injected into `twitch.tv`, or does the host page's CSP block it?

Chrome is *believed* to exempt web-accessible resources from the embedding page's
CSP. Do not take that from recall — Twitch is a hardened origin and this decides
the whole design.

## What to run

```bash
cd .worktrees/in-page-panel
pnpm build            # Chrome
pnpm build:firefox    # Firefox
```

**Chrome** — `chrome://extensions` → enable Developer mode → *Load unpacked* →
`packages/extension/.output/chrome-mv3`.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
pick `manifest.json` in `packages/extension/.output/firefox-mv2`.

Then open <https://www.twitch.tv> (logged in, any page) and click the purple
**Lurkloot** pill at the bottom-right. Repeat on <https://kick.com>.

Twitch is the hardened origin — if it passes there, Kick will pass. Test Twitch
first; only bother with Kick if Twitch passes.

## Reading the result

**Pass** — the panel renders a white card listing four checks:

| Check | Means |
| --- | --- |
| frame rendered (the heading) | the primary result: CSP did not block the frame |
| `origin` | it is a real `chrome-extension://` / `moz-extension://` document |
| `browser.runtime` | extension privileges, so the adapter plan holds |
| `html/body present` | document-level selectors work, so `popup-ui/src/styles.css` applies unmodified |
| `getSnapshot round-trip` | the panel can talk to the background |

**Fail** — the button appears but the card never renders, and the page console
shows a CSP violation naming `frame-src` or `child-src`.

Please paste the console output either way, and note the browser and version.

## What each outcome means for issue #446

- **Pass on both browsers** → the iframe design is settled. `popup-ui/src/styles.css`
  needs no `:host` refactor, and the toolbar popup and site demo stay untouched.
- **Fail on either** → fall back to shadow-root injection for that browser, and the
  `:host` / explicit-sizing stylesheet work comes back into scope, with the
  regression risk to the popup and site demo that implies.

## Cleanup

The spike is confined to:

- `packages/extension/entrypoints/inpagePanel/` (whole directory)
- `packages/extension/src/core/inPagePanelSpike.ts`
- the `mountInPagePanelSpike()` calls in `twitch.content.ts` / `kick.content.ts`
- this file

The `web_accessible_resources` entry in `wxt.config.ts` is **not** spike-only —
the real feature needs it too.

Note what the spike already demonstrates about stage-1 purity: the built
`content-scripts/twitch.js` is ~6.7 kB with no React, because
`inPagePanelSpike.ts` imports nothing but `wxt/browser` and styles itself with
hand-written CSS. The real stage 1 has to hold that line.
