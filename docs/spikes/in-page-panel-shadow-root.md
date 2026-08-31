# Spike: in-page panel in a shadow root

Tracking issue: [#446](https://github.com/jamezrin/lurkloot/issues/446)

**Status: PASSED** on Twitch/Chrome — `--font-sans` and `--accent` both resolved
and Tailwind utilities applied, so the `:host` mirror works and Twitch's
CSP/trusted-types did not block the style injection. The architecture is settled;
this file is kept for the reasoning and the open bundle-size question.

Supersedes the iframe frame-embedding spike. That approach existed to make
two-stage lazy injection possible; with the two-stage requirement dropped, the
idiomatic WXT path — `createShadowRootUi` — wins on every remaining axis except
bundle size (see the open question at the end).

## What this mounts

The real `<Popup>`, inside a shadow root on twitch.tv and kick.com, with the
restricted read-mostly adapter. It is not a throwaway harness: this is the shape
the feature ships on. A green run means the architecture is settled.

Provisional and deliberately absent: the enable setting, drag, position
persistence, managed-tab suppression.

## The questions it answers

1. **Does the shared popup stylesheet survive the shadow boundary?**
   `packages/popup-ui/src/styles.css` puts `@theme` tokens on `:root`, plus
   `color-scheme` on `:root` and sizing/font on `html`/`body`. WXT's
   `cssInjectionMode: "ui"` injects it *into* the shadow root, where none of
   those selectors match. `src/core/inPagePanel.css` re-states them on `:host`
   without touching the shared sheet — so the toolbar popup and the site demo
   carry zero regression risk.
2. **Does Twitch's CSP / trusted-types policy block the style injection?**
3. **Does the popup actually render and function** against a content-script
   adapter with no `browser.tabs`?

## What to run

```bash
cd .worktrees/in-page-panel
pnpm build            # Chrome
pnpm build:firefox    # Firefox
```

**Disable any installed store build first.** Loading unpacked gives a second live
instance with its own `alarms`, `cookies` and scheduler; two engines will open
managed tabs and hit Twitch GQL concurrently, which looks like a bug and can trip
rate limits.

**Chrome** — `chrome://extensions` → Developer mode → *Load unpacked* →
`packages/extension/.output/chrome-mv3`.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
`manifest.json` in `packages/extension/.output/firefox-mv2`.

Open <https://www.twitch.tv> logged in. The panel mounts bottom-right
automatically — no button yet. Repeat on <https://kick.com>.

Expect the panel inside the extension's own managed farming tabs too. Not a bug:
suppression needs a background round-trip this spike omits.

## Reading the result

A black diagnostic strip sits above the panel:

```
--font-sans: "Geist", ui-sans-serif, …  |  --accent: #9147ff  |  utilities: applied
```

| Reading | Means |
| --- | --- |
| all three populated, panel looks like the toolbar popup | **pass** — `:host` mirroring works, ship this architecture |
| `--font-sans: MISSING` | the `:host` mirror isn't landing; the shared sheet may need restructuring after all |
| `--accent: MISSING` | the `[data-platform]` attribute-selector assumption is wrong |
| `utilities: NOT APPLIED` | Tailwind output isn't reaching the shadow root — the serious failure |
| nothing renders, console shows a CSP / trusted-types violation | style injection blocked; the iframe approach comes back |

Please note browser + version and paste any console errors.

## Open question this spike does not resolve: bundle size

Dropping two-stage means the panel ships in the content script, which is now
**1.2 MB raw / ~345 kB gzipped** per platform (up from 6.7 kB), plus ~65 kB raw /
~10 kB gzipped of CSS. That is parsed and executed on **every** twitch.tv and
kick.com page load, whether or not the user opens the panel.

There is no network fetch — content scripts are local — but the parse/execute
cost on page load is real, and Twitch is already heavy.

If that proves unacceptable, two-stage can be restored *without* going back to
the iframe: keep this exact shadow-root code as stage 2 and move it into a WXT
**unlisted script**, injected on click via `browser.scripting.executeScript`
(the `scripting` permission is already granted). Stage 1 then shrinks back to a
button-only content script. That keeps the idiomatic shadow-root rendering and
the simple single-document drag/focus model, and pays only for the executeScript
plumbing.

Decide it on the measured number after the spike passes, not before.

## Cleanup

Spike-only:

- ~~`src/core/inPagePanelSpike.tsx`~~ — removed; it is now `src/core/inPagePanel.tsx`
- the `mountInPagePanelSpike()` calls in `twitch.content.ts` / `kick.content.ts`
- this file

Not spike-only — these are the real feature:

- `src/core/inPagePanelAdapter.ts`
- `src/core/inPagePanel.css`
- `cssInjectionMode: "ui"` on both content scripts
