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
| Screenshots (1280×800) | `packages/extension/artifacts/store-screenshots/en/` (5 PNGs, numbered for order) |
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
pnpm screenshot:store            # artifacts/store-screenshots/<locale>/ (all 10)
pnpm promo:store                 # artifacts/store-promo/<locale>/
```

Pass locale codes to limit, e.g. `pnpm screenshot:store es ar`.
