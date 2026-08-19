# Store screenshot rework design

## Goal

Replace the five repetitive Chrome Web Store screenshots (same centered headline + framed popup, Kick as a second drops shot, empty activity shot) with a locked five-shot set: Signal-broadcast atmosphere, real 400×600 popup only where it earns its place, and copy that sells drops, extras, ease of use, configurability, and that the extension is featureful, kept updated, and open source.

## Scope

This covers the store-screenshot React shell (`StoreScreenshot`), screenshot variant config, English marketing copy plus the other ten locale catalogs, the Playwright capture script and output filenames, promo-tile headline wiring, site demo default variant, i18n/capture tests, and store-submission docs.

It does not change farming behavior, listing short/detailed descriptions in `docs/store-descriptions.md` (except if a screenshot filename path is referenced), Chrome Web Store upload, or promo tile layout beyond which headline key the marquee uses. Kick watch time is not a farmable selling point.

## Shot lineup

Chrome still allows five 1280×800 screenshots. Upload order is the number prefix.

| # | File stem | Story | Live popup |
|---|-----------|--------|------------|
| 01 | `01-drops` | Hero: farm Twitch and Kick drops | Yes — drops view, Twitch selected |
| 02 | `02-extras` | Overview of extras besides drop campaigns | No |
| 03 | `03-easy` | Install → pin → enable → profit | No |
| 04 | `04-settings` | Configurable | Yes — settings view |
| 05 | `05-updated` | Featureful, always updated, open source | No |

Removed as screenshot variants: Kick-drops-as-a-second-hero, idle-watchlist-as-its-own-shot, activity-log-as-a-selling-point.

The site demo and tests that call `screenshotVariant("twitch-drops")` or `screenshotVariant("settings")` keep working: `twitch-drops` aliases 01, `settings` aliases 04. Old ids `kick-drops`, `idle-watchlist`, and `activity` map to 01, 02, and 05 respectively so stale URLs do not crash.

## Visual language

Signal broadcast, as locked in the companion:

- Canvas `#060609`, Bricolage Grotesque display type, zinc subcopy (`#9c9db4`).
- Purple (`#9147ff`) and lime (`#53fc18`) only as **atmospheric radial glows**, placed differently per shot. No decorative gradient **bars**, no full-canvas wallpaper blobs on every frame, no illustrated fake popup UI.
- Eyebrows use the existing purple→lime text gradient.
- The live popup is always the real `Popup` at **400×600**. Scale, crop (overflow hidden on the 1280×800 canvas), or slight rotate are allowed. Stretching to another aspect ratio is not.
- Shots without a popup are marketing frames: type, compact cards, or numbered steps on the same void.

RTL (`ar`): 01 places the popup on the left; 04 places it on the right; 03 steps run right-to-left. 02 cards keep source order in LTR and reverse in RTL.

## English copy (locked)

**01 — Hero**

- Eyebrow: `Twitch + Kick`
- Headline: `Farm drops while you do anything else.`
- Subcopy: `Auto-claim from your own logged-in session. No passwords.`
- Camera: lower-third copy on the left; full 400×600 popup on the right, slight tilt (~−2deg), not vertically centered.

**02 — Extras**

- Eyebrow: `Beyond campaigns`
- Headline: `More than drops.`
- Subcopy: `Channel points and Kick challenges, also claimed for you. An idle watchlist when nothing is left to farm.`
- Cards (compact row, lots of void — not a full-bleed panel set):
  - Channel points — `Twitch · also claimed for you`
  - Daily challenges — `Kick · also claimed for you`
  - Idle watchlist — `Watches your streamers between campaigns`
- Do not call Kick watch time a farmable. Watch time is only a side effect of the idle watchlist.

**03 — Easy**

- Eyebrow: `Easy to use`
- Headline: `That easy.`
- Steps (a real sequence, so numbered):
  1. Install — `Chrome Web Store. No account.`
  2. Pin it — `Keep the popup one click away.`
  3. Enable a platform — `Twitch, Kick, or both.`
  4. Profit — `It farms. You do other things.`

**04 — Settings**

- Eyebrow: `Your rules`
- Headline: `Farm exactly how you want.`
- Subcopy: `Priorities, games, tabless mode, auto-claim — per platform.`
- Camera: 400×600 settings popup flush left on the canvas (no extra glass bezel); copy on the right.

**05 — Updated**

- Eyebrow: `Open source`
- Headline: `Featureful. Always updated.`
- Subcopy: `Frequent releases as Twitch and Kick change — and open to ideas and improvements.`
- Camera: lower-third type only. No popup, no activity-log pitch, no second column of facts.

## Implementation

### Variant model

`ScreenshotVariant` gains a `layout` discriminant instead of one shared two-column grid:

- `hero` — copy + live popup (01)
- `extras` — copy + three cards (02)
- `steps` — copy + four steps (03)
- `settings` — live popup + copy (04)
- `updated` — copy only (05)

`accentGradient` becomes per-shot glow CSS (inline or class), not the current Twitch/Kick pair reused four times. Variants that render `Popup` still carry `platform` and `view`. Variants that do not render `Popup` omit it; `PopupApp` only mounts `Popup` as a child when the variant asks for one.

`StoreScreenshot` in `packages/popup-ui/src/marketing.tsx` implements the five layouts. `PromoPills` (Twitch/Kick + Auto-claim ready) is removed from screenshots; it was part of the repetitive chrome. Promo tiles may keep a quieter platform treatment if they still need it.

### Capture

`packages/extension/scripts/capture-store-screenshot.mjs` captures the five new stems. The wait for `header img[alt="Lurkloot"]` applies only to variants that mount the popup. Variants without a popup wait on the marketing `h1` having real catalog copy (existing `screenshot` prefix guard, updated to the new headline keys).

Output remains `packages/extension/artifacts/store-screenshots/<locale>/lurkloot-<stem>-1280x800.png`.

### i18n

Replace the current `screenshotTwitch*`, `screenshotKick*`, `screenshotIdleWatchlist*`, `screenshotSettings*`, and `screenshotActivity*` keys with explicit keys per field above (eyebrow, headline, subcopy, card name/meta, step title/sub). Every catalog (`en` plus the other ten) gets the new keys in the same change. Brand names (Twitch, Kick, Chrome Web Store) stay untranslated. “Farm” / “farming” keep the existing gaming-loanword rule.

The marquee promo tile currently uses `screenshotTwitchHeadline`. It switches to the 01 headline key. The small promo tile keeps `promoTagline`.

### Demo data

01 and 04 still use `createDemoPopupAdapter`. 04 should open on a settings section that shows farming controls (priorities / tabless / auto-claim), not an empty or unrelated first panel, so the capture matches the copy. 02/03/05 do not need popup demo data. Filling the empty demo activity log is out of scope unless a later shot needs it.

### Tests and docs

- `packages/extension/tests/i18n.test.ts`: capture scripts still list every locale; new screenshot keys exist in every catalog with matching placeholders (none expected).
- A focused popup-ui or marketing test is optional; prefer asserting variant ids and that no-popup layouts do not render `Popup`.
- `docs/chrome-web-store-submission.md` (and any plan text that says “five screenshots, 01–05 Kick/activity”) updates filenames to the new stems. Do not rewrite store listing body copy in this work.

## Out of scope

- Regenerating and uploading PNGs to the Chrome Web Store (run `pnpm screenshot:store` after implementation; artifacts stay gitignored).
- Changing promo tile composition (only the marquee headline key).
- Promising Kick levels, badges, or watch-time outcomes.
- Adding `.superpowers/` brainstorm HTML to git.

## Self-review

- No TBD/TODO left in the shot copy or layout rules.
- 02 does not sell Kick watch time; 05 does not sell the activity log.
- Five shots, 1280×800, popup 400×600 only — no contradiction with CWS limits.
- Implementation is one capture pipeline and one `StoreScreenshot` component, not a second marketing site.
