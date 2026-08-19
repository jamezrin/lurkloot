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
uses a visible Chrome session to replace all 55 screenshots through the Developer Dashboard and save
the listing draft:

```bash
pnpm screenshot:store:sync
```

`CWS_EXTENSION_ID` and `CWS_PUBLISHER_ID` come from the repository `mise.toml`. Without mise
activated in your shell, export them by hand:

```bash
export CWS_EXTENSION_ID=aobaackpofkghaejdnnmpmeaiaoibhdn
export CWS_PUBLISHER_ID=<publisher-id-from-the-dashboard>
```

The command regenerates and validates the images, then starts Chrome itself and attaches to it over
the DevTools protocol. Sign in to Google and complete 2FA in the window it opens; automation resumes
on its own, replaces the five screenshots for each of the 11 locales in numbered order, and saves
each locale.

Playwright never launches the browser. Google refuses interactive sign-in in a browser started with
automation switches — it answers `accounts.google.com/v3/signin/rejected`, "Couldn't sign you in;
this browser or app may not be secure". Chrome is therefore spawned as an ordinary browser with no
automation flags, and automation only attaches once you are signed in.

The browser runs against a persistent profile at `$XDG_STATE_HOME/lurkloot/cws-chrome-profile`
(`~/.local/state/lurkloot/cws-chrome-profile` by default), alongside your other browser state and
outside the repository. Signing in once is enough; later runs reuse that session. The directory holds
live Google credentials — keep it local, never copy it anywhere or share it. Delete it to sign out.
Three optional variables adjust this:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CWS_CHROME_BINARY` | first of `google-chrome-stable`, `google-chrome`, `chrome`, `chromium`, `chromium-browser` on `PATH` | Full path to the browser to start |
| `CWS_CDP_PORT` | `9333` | DevTools port; chosen off the usual `9222` to avoid colliding with your own debugging sessions |
| `CWS_CHROME_PROFILE` | `$XDG_STATE_HOME/lurkloot/cws-chrome-profile` | Use a different profile directory |

Chrome channels are preferred over Chromium because Google frequently refuses sign-in on Chromium
builds; if only Chromium is found the command says so before continuing.

If something is already listening on the port, the command attaches to it instead of starting a
browser, and leaves it running when it finishes — closing only the automation connection. That is the way to reuse a session you signed into
yourself:

```bash
# The binary name varies by distribution: google-chrome, google-chrome-stable, chrome.
"$BROWSER" --user-data-dir=~/.local/state/lurkloot/cws-chrome-profile --remote-debugging-port=9333
CWS_CDP_PORT=9333 pnpm screenshot:store:upload
```

The listing holds two screenshot groups. **Localized screenshots** change with the language
selector, so each of the 11 locales gets its own five. **Global screenshots** are shared across every
language; the command fills them from the English set, and only when `en` is part of the run. Both
groups label their thumbnails "Screenshot N", so each is located from its own heading rather than by
a page-wide search. Within a group the leading image is removed and its replacement appended, one at
a time, which rotates the set exactly once per image and preserves the original order.

Removing an image raises a confirmation dialog, which the command answers. Image changes take effect
as they are made rather than on save, so "Save draft" is often already inactive by the end of a
group; the command reports that and moves on instead of failing.

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

Validate the screenshot files and extension ID without starting Chrome or changing the dashboard
(`CWS_PUBLISHER_ID` is only checked for a live upload):

```bash
pnpm screenshot:store:upload -- --locales en --validate-only
```

Dashboard automation depends on Google's unsupported UI rather than a stable API. It uses accessible
labels and fails closed if an expected control is missing or ambiguous. If failure occurs after a
change, it leaves Chrome open for inspection — including the browser it started, which you close
yourself — and reports the exact locale and recovery command; no listing submission is attempted.
