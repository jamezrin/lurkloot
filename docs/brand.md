# Brand

Where Lurkloot's colours live, what each one is allowed to mean, and what is
still open.

## The rule

**Lurkloot is flat and monochrome.** Black ink is the only accent — primary
buttons, selections, switches, links, progress and the farming state — and it
inverts to off-white on a dark ground. Surfaces are solid fills separated by
hairlines: no gradients, no glows, no drop shadows.

**Platform colour only names a platform.** `--platform-twitch`,
`--platform-kick` and their `-text` variants are for the status dots on the
rail's Twitch/Kick switch and per-row platform badges. They are never a surface
colour, a fill or a gradient.

| Token | Means |
| --- | --- |
| `--ink` / `--ink-text` / `--ink-contrast` | The accent. `--ink-contrast` is text drawn on `--ink`. |
| `--ink-soft` / `--ink-ring` | Pressed chips and hovers; focus rings. |
| `--surface` / `--surface-edge` | A raised surface: solid fill and hairline (the status strip, the source chip). |
| `--rail-*` | The black rail and its selected item. |
| `--accent-*`, `--brand-*` | Aliases of ink, so components don't need to know. |
| `--platform-twitch` / `--platform-kick` | Naming a platform. |

Both files that define tokens follow this: `packages/popup-ui/src/styles.css`
for the popup and the site's live demo, `packages/site/src/styles/global.css`
for the marketing site.

## What #566 is actually about

#566 observes that the identity is assembled from defaults other drop farmers
reach for too: the two platform hexes, a purple→lime gradient between them, glow
shadows, and the Bricolage + Geist pairing. Making the popup's accent
platform-neutral was tried during the workspace redesign and reverted — inside
the popup, the platform's own colour is the right answer.

That leaves the issue pointed at everything around the popup, where there is no
platform to belong to:

- the marketing site's `--signal` gradient and `--glow-*` shadows, which are
  built from Twitch purple and Kick green blended together;
- the icon, the logo ring and the store logo;
- the store screenshots and promo tiles — which must not depict store rating or
  standing, per the 1.13.0 rejection;
- the type pairing.

The brand colour chosen for those surfaces does not replace the in-popup
accent; it sits beside it, the way the platform switch already does.

## Black: Lurkloot's own look

It replaces Ember, a red-orange that — with the warm beige neutrals it came
with — read as one more generic AI-product palette, and then a glass pass that
was too decorative.

| Token | Light | Dark |
| --- | --- | --- |
| `--ink` | `#0a0a0a` | `#fafafa` |
| `--ink-contrast` | `#ffffff` | `#0a0a0a` |
| `--surface` / `--surface-edge` | `#ffffff` / `#e4e4e7` | `#111111` / `#262626` |
| `--rail-bg` / `--rail-selected` | `#0a0a0a` / `#1f1f1f` | `#000000` / `#1c1c1c` |

Neutrals are Tailwind's plain zinc. **The rail is black in both themes**, and
the mark sits at its top: the extension icon itself, ring and play glyph on
the Twitch-purple to Kick-green tile (`packages/popup-ui/src/mark.tsx`). It is
the one place the popup chrome keeps the platform blend.

**Shape.** Cards are 10px, controls 6–8px (`rounded-md`/`rounded-lg`); round
shapes are for status dots, switches and the floating carousel arrows only.
Group labels are sentence case, not mono capitals.

Still to do under #566:

- apply it to `packages/site/src/styles/global.css`, replacing the `--signal`
  gradient and the `--glow-*` shadows;
- audit hard-coded colours in `packages/site/src/components/*` and `pages/*`;
- regenerate the Chrome Web Store screenshots and promo tiles — which must not
  depict store rating or standing, per the 1.13.0 rejection;
- check AA contrast for text and interactive states in both themes.

## Typography

The popup uses the prototype's pairing: `--font-display` (Archivo) for names and
headings, `--font-sans` (Geist) for everything else, `--font-mono` (Geist Mono)
for numbers that line up — ranks, counts, timestamps. All three are bundled
through `@lurkloot/popup-ui/fonts.css`, which the extension's popup and in-page
panel import; before that, the extension named Geist but never shipped it and
fell back to the system font. The site demo declares the same families in the
site's global stylesheet, because `@font-face` inside its shadow root is
ignored.

The marketing site's own pages still use Bricolage Grotesque for display. Moving
them to Archivo belongs with the rest of the site's move to the black identity under #566.
