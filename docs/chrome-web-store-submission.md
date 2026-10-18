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
| Screenshots (1280×800) | `packages/extension/artifacts/store-screenshots/en/` (5 PNGs, numbered for order: `01-drops`, `02-extras`, `03-easy`, `04-settings`, `05-updated`) |
| Small promo tile 440×280 | `artifacts/store-promo/en/lurkloot-promo-small-440x280.png` (optional) |
| Marquee 1400×560 | `artifacts/store-promo/en/lurkloot-promo-marquee-1400x560.png` (optional) |
| Icon 128×128 | from the built package |

## 2. Localized listings

`pnpm cws:listing:sync` sets the description and five screenshots of every locale; see
[Syncing the listing automatically](#syncing-the-listing-automatically). Promo tiles per locale are
under `artifacts/store-promo/<locale>/`.

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
pnpm screenshot:store            # artifacts/store-screenshots/<locale>/ (all 17)
pnpm promo:store                 # artifacts/store-promo/<locale>/
```

Pass `--locales` to limit, for example `pnpm screenshot:store --locales ja id pl ko uk cs`. An unknown
locale is an error rather than being skipped. Promo tiles for every catalog locale are under
`artifacts/store-promo/<locale>/`. Nothing uploads the promo tiles; add them in the Developer
Dashboard by hand.

## Syncing the listing automatically

The public Chrome Web Store API cannot update listing screenshots or per-language descriptions. The
local operator command below uses a visible Chrome session to set the detailed description and the
five screenshots of every locale through the Developer Dashboard, then save the listing draft:

```bash
pnpm cws:listing:sync                       # build, capture, sync, read back
pnpm cws:listing:sync --locales ja id       # the same for some locales
```

`cws:listing:sync` builds the extension, then runs `sync --capture`, so the locale list reaches the
capture as well as the sync. Everything is one command with stages:

| Command | What it does | Needs the dashboard |
| --- | --- | --- |
| `capture [screenshots\|promos]` | Photographs the built popup into `artifacts/` and records [provenance](#what-the-screenshots-show) | no |
| `validate` | Checks the files, descriptions and provenance | no |
| `sync` | Validates, edits the draft, then reads it back | yes |
| `verify` | Reads the dashboard and compares it with the local files; changes nothing | yes |
| `snapshot --locales …` | Writes sanitized copies of the page for the [contract tests](#when-the-dashboard-changes) | yes |

Run them as `pnpm cws:listing <command> -- <options>` (a bare `pnpm cws:listing` is a `sync`).

Each description is the plain-text file `packages/extension/store-descriptions/<locale>.txt`. The
summary is not synced: the dashboard takes it from the package's `extensionDescription` message.

`CWS_EXTENSION_ID` and `CWS_PUBLISHER_ID` come from the repository `mise.toml`. Without mise
activated in your shell, export them by hand:

```bash
export CWS_EXTENSION_ID=aobaackpofkghaejdnnmpmeaiaoibhdn
export CWS_PUBLISHER_ID=<publisher-id-from-the-dashboard>
```

The command regenerates and validates the images and descriptions, then starts Chrome itself and
attaches to it over the DevTools protocol. Sign in to Google and complete 2FA in the window it opens;
automation resumes on its own, sets the description and replaces the five screenshots for each of the
17 locales in numbered order, and saves each locale. The dashboard language list comes from the
`_locales` directories in the uploaded package, so upload a build that contains `ja`, `id`, `pl`,
`ko`, `uk`, and `cs` before the first listing run for those languages.

A language added that way starts with no screenshots of its own and a description the dashboard
pre-fills from English. The command fills it in order rather than rotating, and checks for every
language that the localized and global groups are separate panels, so an empty language can never be
mistaken for the shared set. English keeps its images only in the global group, so its localized group
is empty too. Switching from English to a new language therefore changes neither group nor the
description. The command confirms the switch from the read-only "Title from package" and "Summary
from package" values, which come from each language's manifest messages. The six languages added in
1.18.0 were filled this way on 2026-10-18.

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
CWS_CDP_PORT=9333 pnpm cws:listing
```

The listing holds two screenshot groups. **Localized screenshots** change with the language
selector, so each of the 17 locales gets its own five. **Global screenshots** are shared across every
language; the command fills them from the English set, and only when `en` is part of the run. Both
groups label their thumbnails "Screenshot N", so each is located from its own heading rather than by
a page-wide search. Within a group the leading image is removed and its replacement appended, one at
a time, which rotates the set exactly once per image and preserves the original order.

Removing an image raises a confirmation dialog, which the command answers. Image changes take effect
as they are made rather than on save, so "Save draft" is often already inactive by the end of a
group; the command reports that and moves on instead of failing.

This workflow deliberately stops at a saved draft. It has no operation that submits the item for
review or publishes it. Use the normal release flow when the draft should be submitted.

To sync already-generated files, retry selected locales after an interruption, or touch only one
part of the listing:

```bash
pnpm cws:listing
pnpm cws:listing -- --locales ja id pl ko uk cs
pnpm cws:listing -- --only descriptions
pnpm cws:listing -- --only screenshots --locales ar
```

`--only descriptions` needs no generated screenshots and no provenance.

### What the screenshots show

Captured images say nothing about which build they came from, so `capture` writes
`artifacts/store-screenshots/capture-manifest.json` beside them: for every locale the extension
version from the built `manifest.json`, the commit, whether the working tree was dirty, and a hash of
each file. A sync refuses to go on when

- there is no manifest, or a requested locale is not in it;
- the locales were captured from different versions (an incremental capture makes this easy);
- the captured version is not the version of the checkout running the sync;
- a file changed after it was captured;
- the capture came from a dirty tree.

`--allow-version-mismatch` and `--allow-dirty` accept the second to fourth and the last. Local tags
are never consulted: the first 1.18.0 captures here came from a stale tag and said 1.17.2. To list
what a version shipped, capture from its release commit in a worktree.

### Reading the dashboard back

Neither the dashboard nor the page's own state is proof that a save worked, so a `sync` ends by
reloading the listing and comparing it with the local files: each language's description (line
endings and surrounding whitespace ignored) and the number of screenshots in the group that language
uses. For the source language, `en`, that is the shared group; its own localized group is empty on the
live dashboard and is not checked. A mismatch fails the command and names the locale.

`verify` runs the same check without changing anything, for all locales by default, and needs no
captured screenshots. `--no-verify` skips the readback after a sync. When Chrome was already running,
the tab the command opened is closed after a clean run and left open after a failure.

### Skipping what is already there

After a sync passes its readback, `sync-state.json` records, per language, the hash of every local
image and the thumbnail ids the dashboard showed for it. The next sync leaves a language's
screenshots alone only when **both** still match, so an image edited locally is uploaded again, and an
image changed by hand on the dashboard is replaced rather than trusted. A language with no record is
filled as before. `--force` always uploads. Descriptions were already skipped when unchanged.

### Locked listings

An item that has been submitted cannot be edited until its review ends. The form stays disabled and
the page says `Status: Pending review`. The preflight waits out the moment the form is disabled while
loading, then stops with that status in the message and changes nothing. `verify` still works, and
prints the status.

### When the dashboard changes

The driver locates controls by their accessible names and by headings, because Google offers no
stable API. `tests/fixtures/cws-dashboard/` holds sanitized snapshots of the real page, and
`storeListingContract.test.ts` runs every locator against them. When the dashboard changes, retake
them while signed in:

```bash
pnpm cws:listing snapshot -- --locales en es
```

The snapshot keeps only the listing form and removes scripts, styles, links, hidden inputs, option
lists (which hold account and site names), image addresses and every attribute outside a short allow
list. Guard tests fail on an email address, an id, a Google host or a `data-` attribute, but look at
the diff before committing it: the page is a signed-in session and the repository is public.

### Layout

`packages/extension/scripts/store-listing/` is split so that it could be lifted out of this
repository without rewriting:

- `core/` is the generic tooling: the dashboard driver, the Chrome session, the sync and readback
  loops, provenance, sync state and the sanitizer. It receives a **listing profile** (languages,
  screenshot variants, file names, the command to rerun) and never imports one.
  `storeListingBoundary.test.ts` fails if a core file imports anything outside `core/` or names the
  product.
- `lurkloot.mjs` is the profile and the repository paths; `capture.mjs` and `cli.mjs` are the
  product's wiring.

A run interrupted between deletion and upload may leave four screenshots in one locale. The next
locale-filtered run repairs that state before replacing the full ordered set. The operation is safe
to repeat.

Validate the screenshot files, descriptions and extension ID without starting Chrome or changing the
dashboard (`CWS_PUBLISHER_ID` is only checked for a live run):

```bash
pnpm cws:listing -- --locales en --validate-only
```

Dashboard automation depends on Google's unsupported UI rather than a stable API. It uses accessible
labels and fails closed if an expected control is missing or ambiguous. If failure occurs after a
change, it leaves Chrome open for inspection — including the browser it started, which you close
yourself — and reports the exact locale and recovery command; no listing submission is attempted.
