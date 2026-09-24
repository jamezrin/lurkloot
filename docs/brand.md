# Brand

Where Lurkloot's colours live, what each one is allowed to mean, and what is
still open.

## The rule

**The accent follows the platform.** `--accent` and its variants resolve to
Twitch purple under `[data-platform="twitch"]` and Kick green under
`[data-platform="kick"]`, so every accented surface — buttons, focus rings, the
farming emphasis, the rail's current destination, progress — belongs to the
platform being farmed. The popup is a companion to a session on that site, and
reading as part of it is worth more than a colour of our own would be.

**`--platform-*` names a platform that is not the selected one.**
`--platform-twitch`, `--platform-kick` and their `-text` variants exist for the
rail's platform switch, per-row platform badges, and status dots — the places
that have to say *which* platform while another one owns the accent. They are
never a surface colour and never a hero gradient.

| Token | Means |
| --- | --- |
| `--accent` | The selected platform's accent. Fills and strokes. |
| `--accent-text` | The accent as text or an icon, contrast-corrected per theme. |
| `--accent-contrast` | Text drawn *on* `--accent`. |
| `--accent-soft` / `--accent-softer` | Accent-tinted surfaces (current rail item, farming row). |
| `--accent-ring` | Focus rings. |
| `--accent-glow` | The one decorative shadow. |
| `--platform-twitch` / `--platform-kick` | A platform other than the selected one. |
| `--brand` and its variants | Lurkloot itself. See Ember below. |

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

## Ember: Lurkloot's own colour

| Token | Light | Dark |
| --- | --- | --- |
| `--brand` | `#cf4420` | `#ff8a5c` |
| `--brand-text` | `#b3391a` | `#ff9f78` |
| `--brand-contrast` | `#ffffff` | `#170904` |
| `--brand-soft` / `--brand-ring` | Ember at 11% / 40% | Ember at 16% / 45% |

Twitch is violet and Kick is green. A red-orange sits clear of both hues, so
anything drawn in Ember reads as Lurkloot rather than as either platform. It
was picked over the other candidates from the interactive prototype (Teal,
Marine, Cobalt, Copper, Ruby): Teal and Marine sit too close to Kick green,
Cobalt too close to Twitch violet and to every other product, and Copper was
already turned down.

**Where it goes.** The surfaces that are about Lurkloot rather than about a
platform:

- in the popup, the update notice, and the mark once the icon is redrawn;
- the marketing site, where it replaces the purple-to-lime `--signal`
  gradient and the `--glow-*` shadows;
- the icon, the logo ring and the store logo;
- the store screenshots and promo tiles.

**Where it never goes.** Farming state. Progress, the farming row, toggles, the
rail's current destination and focus rings belong to the platform being
farmed, as the rule above says. Ember and the amber used for warnings sit near
each other, so a warning keeps its icon and wording and never relies on hue
alone.

Still to do under #566:

- apply it to `packages/site/src/styles/global.css`, replacing the `--signal`
  gradient and the `--glow-*` shadows;
- audit hard-coded colours in `packages/site/src/components/*` and `pages/*`;
- redraw `packages/extension/public/icon/source.svg`, `logo-ring.svg` and
  `chrome-store-logo-128.svg`, then use the mark in the popup's rail;
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
them to Archivo belongs with the rest of the site's move to Ember under #566.
