# Brand

Where Lurkloot's colours live, what each one is allowed to mean, and the one
decision still open.

## The rule this replaces

Until the workspace redesign, the product accent *was* the platform's brand
colour: `--accent` resolved to Twitch purple under `[data-platform="twitch"]`
and to Kick green under `[data-platform="kick"]`. Two things followed from that,
both bad:

- switching platform repainted every accented surface in the popup, so the
  product had no identity of its own to recognise;
- Twitch's and Kick's trademarks did the work of Lurkloot's brand, in a category
  where other drop farmers reach for the same two hexes (#566).

## The rule now

**One product accent, on `:root`.** Buttons, focus rings, the farming emphasis,
the rail's current destination, progress — all of it reads from `--accent*`,
which never changes with the platform.

**Platform colours identify a platform, nothing else.** `--platform-twitch`,
`--platform-kick` and their `-text` variants exist for the rail's platform
switch, per-row platform badges, and status dots that answer "which platform is
this". They are never a surface colour, never a hero gradient, and never the
accent.

| Token | Means |
| --- | --- |
| `--accent` | The product's accent. Fills and strokes. |
| `--accent-text` | The accent as text or an icon, contrast-corrected per theme. |
| `--accent-contrast` | Text drawn *on* `--accent`. |
| `--accent-soft` / `--accent-softer` | Accent-tinted surfaces (current rail item, farming row). |
| `--accent-ring` | Focus rings. |
| `--accent-glow` | The one decorative shadow. |
| `--platform-twitch` / `--platform-kick` | Platform identity only. |

Both files that define tokens follow this: `packages/popup-ui/src/styles.css`
for the popup and the site's live demo, `packages/site/src/styles/global.css`
for the marketing site.

## Open: the accent value itself

The redesign made the accent a single token; it did **not** choose its value.
The current value is a violet close to the old Twitch-derived one, held there so
the redesign ships without pre-empting the decision. Swapping it is now a
one-token change in each of the two files above.

Candidates explored with the prototype, all of them clear of both platform
hues:

| Name | Light | Dark |
| --- | --- | --- |
| Teal | `#0f7a63` | `#3ed3ae` |
| Marine | `#0e7490` | `#38cbe3` |
| Cobalt | `#2f61d8` | `#7ea6ff` |
| Ember | `#cf4420` | `#ff8a5c` |
| Copper | `#a7601c` | `#e0a54c` |
| Ruby | `#c2185b` | `#ff7aa8` |

Notes from that pass: Teal and Marine read as the same choice at a glance, so
they do not both need to be on the table; Cobalt is the safest and the most
generic; Ember and Ruby are the most distinctive and the hardest to pair with a
warning colour, which is already amber.

Still to do under #566 once a value is picked:

- apply it to `packages/site/src/styles/global.css`, including the `--signal`
  gradient and the `--glow-*` shadows, which are still derived from the two
  platform hues;
- audit hard-coded colours in `packages/site/src/components/*` and `pages/*`;
- redraw `packages/extension/public/icon/source.svg`, `logo-ring.svg` and
  `chrome-store-logo-128.svg`;
- regenerate the Chrome Web Store screenshots and promo tiles — which must not
  depict store rating or standing, per the 1.13.0 rejection;
- check AA contrast for text and interactive states in both themes.

## Typography

`--font-display` (Bricolage Grotesque) for names and headings, `--font-sans`
(Geist) for everything else, `--font-mono` (Geist Mono) for numbers that line
up: ranks, counts, timestamps. #566 also asks whether this pairing is
distinctive enough; that question is open with the palette.
