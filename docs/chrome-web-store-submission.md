# Chrome Web Store submission — 1.3.0

Step-by-step for re-specifying the listing (description, localized + global screenshots, etc).
Pairs with `store-descriptions.md` (per-language copy) and `store-readiness.md` (compliance fields,
permission justifications). Dashboard item: `aobaackpofkghaejdnnmpmeaiaoibhdn`.

## 0. Upload the package

- Upload **`packages/extension/.output/lurklootextension-1.3.0-chrome.zip`** under *Package*.
- (AMO/Firefox: `lurklootextension-1.3.0-firefox.zip` + `lurklootextension-1.3.0-sources.zip`.)

## 1. Default (global) listing — language **English**

The store's default locale is `en` (manifest `default_locale`). Fill the main listing in English:

| Field | Value / source |
|-------|----------------|
| Name | `Lurkloot - Farm Drops on Twitch & Kick` (manifest `extensionStoreName`) |
| Summary (≤132) | English **Short** in `store-descriptions.md` |
| Description | English **Detailed** in `store-descriptions.md` |
| Category | Productivity |
| Screenshots (1280×800) | `packages/extension/artifacts/store-screenshots/en/` (5 PNGs, numbered for order: `01-drops`, `02-extras`, `03-easy`, `04-settings`, `05-updated`) |
| Small promo tile 440×280 | `artifacts/store-promo/en/lurkloot-promo-small-440x280.png` (optional) |
| Marquee 1400×560 | `artifacts/store-promo/en/lurkloot-promo-marquee-1400x560.png` (optional) |
| Icon 128×128 | from the built package |

## 2. Localized listings — add a translation for each locale

For every locale below, set its **Summary** + **Description** (from `store-descriptions.md`) and upload
**that locale's 5 screenshots**. Promo tiles per locale are under `artifacts/store-promo/<locale>/`.

| Locale | Screenshots dir | Copy in store-descriptions.md |
|--------|-----------------|-------------------------------|
| es | `store-screenshots/es/` | Spanish |
| fr | `store-screenshots/fr/` | French |
| it | `store-screenshots/it/` | Italian |
| ru | `store-screenshots/ru/` | Russian |
| de | `store-screenshots/de/` | German |
| zh_CN | `store-screenshots/zh_CN/` | Simplified Chinese |
| hi | `store-screenshots/hi/` | Hindi |
| pt_BR | `store-screenshots/pt_BR/` | Portuguese (Brazil) |
| ar | `store-screenshots/ar/` | Arabic |
| tr | `store-screenshots/tr/` | Turkish |

(English `en` is the default listing in §1.) All short descriptions are within the 132-char limit.

## 3. Privacy / compliance tab

- **Single purpose**, **data-usage** answers, **permission justifications**, and **host-permission
  justifications**: copy from `store-readiness.md` (paste-ready).
- **Privacy policy URL:** `https://lurkloot.jamezrin.com/privacy` (live).
- **Remote code:** No.

## 4. Before clicking Publish

Run manual acceptance with real logged-in Twitch and Kick sessions (private APIs change without
notice): enable each platform, confirm visible-tab mode pins/mutes a watch tab, confirm tabless mode
falls back when unhealthy, and confirm reward progress on the platforms' inventory pages.

## Regenerating assets

```bash
pnpm zip && pnpm zip:firefox     # extension packages
pnpm screenshot:store            # artifacts/store-screenshots/<locale>/ (all 11)
pnpm promo:store                 # artifacts/store-promo/<locale>/
```

Pass locale codes to limit, e.g. `pnpm screenshot:store es ar tr`. Turkish promo tiles are under
`artifacts/store-promo/tr/`.

## Replacing localized screenshots automatically

The public Chrome Web Store API cannot update listing screenshots. The local operator command below
uses a visible, isolated Chrome session to replace all 55 screenshots through the Developer
Dashboard and save the listing draft:

```bash
export CWS_EXTENSION_ID=aobaackpofkghaejdnnmpmeaiaoibhdn
export CWS_PUBLISHER_ID=<publisher-id-from-the-dashboard>
pnpm screenshot:store:sync
```

The command regenerates and validates the images before opening Chrome. Sign in to Google and
complete 2FA in the opened browser; automation resumes on its own, replaces the five screenshots for
each of the 11 locales in numbered order, and saves each locale. The browser context is fresh for
every run and its authentication state is not saved.

This workflow deliberately stops at a saved draft. It has no operation that submits the item for
review or publishes it. Use the normal release flow when the draft should be submitted.

To upload already-generated files or retry selected locales after an interruption:

```bash
pnpm screenshot:store:upload
pnpm screenshot:store:upload -- --locales ar tr
```

A run interrupted between deletion and upload may leave four screenshots in one locale. The next
locale-filtered run repairs that state before replacing the full ordered set. The operation is safe
to repeat.

Validate the screenshot files and extension ID without opening Chrome or changing the dashboard
(`CWS_PUBLISHER_ID` is only checked for a live upload):

```bash
pnpm screenshot:store:upload -- --locales en --validate-only
```

Dashboard automation depends on Google's unsupported UI rather than a stable API. It uses accessible
labels and fails closed if an expected control is missing or ambiguous. If failure occurs after a
change, it leaves Chrome open for inspection and reports the exact locale and recovery command; no
listing submission is attempted.
