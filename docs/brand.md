# Brand

Where Lurkloot's colours live, what each one is allowed to mean, and what is
still open.

## The rule

**Chrome is ink; farming state is the platform's.** Lurkloot's own identity is
matte black ink with glass for the few raised surfaces. Platform colour —
Twitch purple under `[data-platform="twitch"]`, Kick green under
`[data-platform="kick"]` — is kept for what the platform is doing: progress,
the Farming pill, the live dots and the switch that turns farming on or off.
The popup still reads as part of the platform's session where it matters, and
as a product of its own everywhere else.

**`--platform-*` names a platform that is not the selected one.**
`--platform-twitch`, `--platform-kick` and their `-text` variants exist for the
rail's platform switch, per-row platform badges, and status dots — the places
that have to say *which* platform while another one owns the accent. They are
never a surface colour and never a hero gradient.

| Token | Means |
| --- | --- |
| `--ink` / `--ink-text` / `--ink-contrast` | Primary buttons, selected segments, ticked boxes, switches, links. `--ink-contrast` is text drawn on `--ink`. |
| `--ink-soft` / `--ink-ring` | Pressed chips and hovers; focus rings (`--accent-ring` resolves to it). |
| `--glass-*` | Raised surfaces: the status strip, the source chip, the carousel arrows. |
| `--rail-*` | The matte black rail and its glass selection. |
| `--accent` and its variants | The selected platform, for farming state only. |
| `--platform-twitch` / `--platform-kick` | A platform other than the selected one. |
| `--brand` and its variants | Aliases of `--ink`, kept for the update notice and nudges. |

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

## Ink and glass: Lurkloot's own look

It replaces Ember, a red-orange that — with the warm beige neutrals it came
with — read as one more generic AI-product palette.

| Token | Light | Dark |
| --- | --- | --- |
| `--ink` | `#121214` | `#ececee` |
| `--ink-contrast` | `#fafafa` | `#0d0d0f` |
| `--ink-soft` / `--ink-ring` | ink at 6% / 32% | white at 7% / 34% |
| `--rail-bg` | `#0d0d0f` | `#0a0a0b` |

**Ink** inverts with the theme: on a dark ground primary actions are an
off-white fill with dark text, so "black" chrome never disappears into the page.
Neutrals are Tailwind's plain zinc, with no warm bias.

**The rail is matte black in both themes** — the one signature surface. A
static grain (a background image, painted once) takes the plastic sheen off it.
The mark sits at its top: the icon's ring and play glyph on a black tile with a
glass sheen (`packages/popup-ui/src/mark.tsx`).

**Glass** is a translucent fill, a hairline edge and a lit top edge. It never
uses `backdrop-filter`: an extension popup is re-laid-out on every auto-size
probe, and a blur layer under scrolling content would be paid for each time. It
is reserved for raised chrome — the status strip, the rail's selection and
platform switch, the source chip, the carousel arrows — never repeated rows.

**Shape.** Cards are 10px, controls 6–8px (`rounded-md`/`rounded-lg`); round
shapes are for status dots, switches and floating arrows only. Group labels are
sentence case, not mono capitals.

Still to do under #566:

- apply it to `packages/site/src/styles/global.css`, replacing the `--signal`
  gradient and the `--glow-*` shadows;
- audit hard-coded colours in `packages/site/src/components/*` and `pages/*`;
- redraw `packages/extension/public/icon/source.svg`, `logo-ring.svg` and
  `chrome-store-logo-128.svg` as the rail's black mark, so the toolbar icon
  matches the popup;
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
them to Archivo belongs with the rest of the site's move to ink and glass under #566.
