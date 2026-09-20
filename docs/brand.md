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

A brand colour chosen for those surfaces would not replace the in-popup accent;
it would sit beside it, the way the platform switch already does.

## Open: a colour for everything that is not the popup

No value is chosen yet. These are the candidates explored with the interactive
prototype, all of them clear of both platform hues, so a site header or an icon
drawn in one of them reads as Lurkloot rather than as Twitch or Kick:

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

- apply it to `packages/site/src/styles/global.css`, replacing the `--signal`
  gradient and the `--glow-*` shadows that are derived from the two platform
  hues;
- audit hard-coded colours in `packages/site/src/components/*` and `pages/*`;
- redraw `packages/extension/public/icon/source.svg`, `logo-ring.svg` and
  `chrome-store-logo-128.svg`;
- regenerate the Chrome Web Store screenshots and promo tiles — which must not
  depict store rating or standing, per the 1.13.0 rejection;
- check AA contrast for text and interactive states in both themes;
- decide whether it earns a place inside the popup at all, on the few surfaces
  that are about Lurkloot rather than about a platform (the wordmark, the
  update and rating notices).

## Typography

`--font-display` (Bricolage Grotesque) for names and headings, `--font-sans`
(Geist) for everything else, `--font-mono` (Geist Mono) for numbers that line
up: ranks, counts, timestamps. #566 asks whether this pairing is distinctive
enough — it is the same one a lot of recent projects reach for. Open with the
palette, and worth deciding together with it.
