# Chrome Web Store submission — 1.3.0

Step-by-step for re-specifying the listing (description, localized + global screenshots, etc).
Pairs with `packages/extension/store-descriptions/` (per-language copy) and `store-readiness.md` (compliance fields,
permission justifications). Dashboard item: `aobaackpofkghaejdnnmpmeaiaoibhdn`.

## 0. Upload the package

- Upload **`packages/extension/.output/lurklootextension-1.3.0-chrome.zip`** under *Package*.
- (AMO/Firefox: `lurklootextension-1.3.0-firefox.zip` + `lurklootextension-1.3.0-sources.zip`.)

## 1. Default (global) listing — language **English**

The store's default locale is `en` (manifest `default_locale`). Fill the main listing in English:

| Field | Value / source |
|-------|----------------|
| Name | `Lurkloot - Farm Drops on Twitch & Kick` (manifest `extensionStoreName`) |
| Summary (≤132) | From the package: the `extensionDescription` message |
| Description | `packages/extension/store-descriptions/en.txt` |
| Category | Productivity |
| Screenshots (1280×800) | `packages/extension/artifacts/store/global/screenshots/` (5 PNGs, numbered for order: `01-drops`, `02-extras`, `03-easy`, `04-settings`, `05-updated`) |
| Small promo tile 440×280 | `artifacts/store/global/promo/small.png` (optional) |
| Marquee 1400×560 | `artifacts/store/global/promo/marquee.png` (optional) |
| Icon 128×128 | from the built package |

### Screenshot composition

The listing shows screenshots scaled down, about 640×400 in its viewer and smaller in the
carousel, and does not open them at full size. The images therefore carry no logo header or
"01 / 05" counter, and each is one large localized headline with one large visual:

1. Farm drops without lifting a finger: the whole popup at actual size, so users see what they
   install, beside the headline and three short steps.
2. Game priorities: the real games list, enlarged.
3. Two platforms: a checklist of what Lurkloot supports on Twitch and on Kick.
4. Idle watchlist: one supporting line and the real watchlist rows, enlarged.
5. Farm everything, watch nothing: a larger closing statement, noting it is free and open
   source.

`StoreArtwork` frames real demo popup components; shots 02 and 04 crop the popup with scoped
camera styles. The platform checklists (`platforms` in `storeArtworkCopy.ts`) and the closing
statement are editorial artwork; keep the checklists to features Lurkloot actually supports.
Promo tiles have their own composition.

Review at 640×400 and 400×250 as well as the 1280×800 export size. Headlines start at 104px
(76px beside the opening popup, 156px in the closing statement) and fit to their actual glyphs
after fonts load; the platform checklists shrink together until their longest item fits.
Generation rejects headline overflow, clipped subtitles, steps or checklist items, copy in the
canvas's bottom margin, a clipped opening popup, and focus regions outside the canvas. The
numbered file stems are stable upload slots; their names predate these stories.

## 2. Localized listings

`pnpm store:generate` then `pnpm store:sync` sets the description and five screenshots of every
locale; see [Syncing the listing](#syncing-the-listing).

## 3. Privacy / compliance tab

- **Single purpose**, **data-usage** answers, **permission justifications**, and **host-permission
  justifications**: copy from `store-readiness.md` (paste-ready).
- **Privacy policy URL:** `https://lurkloot.jamezrin.com/privacy` (live).
- **Remote code:** No.

## 4. Before clicking Publish

Run manual acceptance with real logged-in Twitch and Kick sessions (private APIs change without
notice): enable each platform, confirm visible-tab mode pins/mutes a watch tab, confirm tabless mode
falls back when unhealthy, and confirm reward progress on the platforms' inventory pages.

## Generating the listing content

Everything the listing says is generated into one directory, the **bundle**, at
`packages/extension/artifacts/store/` (ignored by git). The generators are specific to Lurkloot; what
reads the bundle, `@lurkloot/store-sync`, is not. See
[its README](../packages/store-sync/README.md) for the layout, which is the contract between them.

```bash
pnpm zip && pnpm zip:firefox          # extension packages
pnpm store:generate                   # build, then screenshots + promo + descriptions
pnpm store:generate:screenshots       # build, then the popup screenshots
pnpm store:generate:promo             # build, then the promo tiles
pnpm store:generate:descriptions      # copy store-descriptions/*.txt (no build)
```

Pass `--locales` to limit, for example `pnpm store:generate --locales ja id`. An unknown locale is an
error rather than being skipped. `store:generate` builds once and runs the generators in one process,
so the locale list reaches all of them. Each generator replaces only its own sections for the
languages it was given and stamps them, so generating some languages never erases the rest.

- **Screenshots** are five 1280×800 PNGs per language, in `<locale>/screenshots/`. The default
  language, `en`, has no group of its own on the dashboard, so its artwork goes to `global/screenshots/`
  and `en` gets none.
- **Promo tiles** are the small and marquee tiles in `global/promo/`, made from `en`, because the
  dashboard has one pair for the whole listing. They are generated only when `en` is part of the run,
  and need ImageMagick (`magick`) to drop the alpha channel the store rejects. Nothing uploads them yet;
  add them in the Developer Dashboard by hand.
- **Descriptions** are `store-descriptions/<locale>.txt` copied into `<locale>/description.txt`. A sync
  refuses when a source file differs from the bundle's copy, so run
  `pnpm store:generate:descriptions` after editing one.

Each section is stamped with the version of the **build** the screenshots were made from (read from the
built `manifest.json`, not from tags), the commit, and whether the tree was dirty. To list what a
version shipped, generate from its release commit in a worktree.

## Syncing the listing

The public Chrome Web Store API cannot update listing screenshots or per-language descriptions. The
local operator commands below use a Chrome session you sign into to edit the Developer Dashboard draft,
then read it back:

```bash
pnpm store:validate                   # check the bundle; no browser
pnpm store:sync                       # edit the draft, save it, read it back
pnpm store:sync --locales ja id       # only those languages (not the shared group)
pnpm store:sync --only descriptions   # or screenshots, or global
pnpm store:verify                     # compare the dashboard with the bundle; changes nothing
pnpm store:snapshot --locales en es   # retake the dashboard snapshots for the contract tests
```

`store:sync` generates nothing. Run `store:generate` first; it refuses a bundle whose artwork came from
another version than this checkout's, or from a dirty tree (`--allow-version-mismatch`,
`--allow-dirty`). The shared group is synced only by a run that names no language, or with `--global` or
`--only global`. Everything else, including the Chrome session, the profile at
`~/.local/state/lurkloot/cws-chrome-profile`, readback, skipping unchanged screenshots and locked
listings, is in the [package README](../packages/store-sync/README.md).

`CWS_EXTENSION_ID` and `CWS_PUBLISHER_ID` come from the repository `mise.toml`. Without mise
activated in your shell, export them by hand:

```bash
export CWS_EXTENSION_ID=aobaackpofkghaejdnnmpmeaiaoibhdn
export CWS_PUBLISHER_ID=<publisher-id-from-the-dashboard>
```

Sign in to Google and complete 2FA in the window the first run opens; later runs reuse that session.
To reuse a Chrome you signed into yourself, start it with the debugging port and the profile:

```bash
"$BROWSER" --user-data-dir=~/.local/state/lurkloot/cws-chrome-profile --remote-debugging-port=9333
CWS_CDP_PORT=9333 pnpm store:sync
```

This workflow deliberately stops at a saved draft. Nothing here submits the item for review or
publishes it; use the normal release flow for that. Once a release is submitted the listing is locked
until its review ends: `store:sync` says so and changes nothing, and `store:verify` still works.

## Adding a language

1. In the repository: the catalog `packages/locales/messages/<code>.json` and its wiring, the store
   artwork copy, `store-descriptions/<code>.txt`, and the code in `LOCALES` in
   `packages/extension/scripts/store/lurkloot.mjs`. `pnpm locales:check` and the i18n test fail if the
   catalogs and `LOCALES` disagree.
2. Release a package containing the language. The dashboard builds its language list from the uploaded
   package's `_locales`, so the language does not exist there before.
3. From a checkout at that release, with the listing not in review:
   `pnpm store:generate --locales <code>`, then `pnpm store:sync --locales <code>`. Sync one new
   language on its own first.
