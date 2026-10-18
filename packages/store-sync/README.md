# @lurkloot/store-sync

Syncs a directory of store listing content to the Chrome Web Store Developer Dashboard. It knows
nothing about what is in the directory: something else produces it, and this reads it, checks it, edits
the listing draft and reads the dashboard back to confirm.

It lives in this repository, uses no other workspace package and imports nothing outside itself,
`node:` and `playwright`. `tests/storeSyncBoundary.test.ts` enforces that, so moving the folder to its
own repository is a plain move.

## Why it drives the dashboard

The Chrome Web Store API can upload and publish a package. It cannot set per-language descriptions or
screenshots. This drives the Developer Dashboard in a Chrome the operator signs into, by accessible
labels and headings, and fails closed when a control is missing or ambiguous. It depends on an
unsupported UI, so the locators are tested against snapshots of the real page (see
[When the dashboard changes](#when-the-dashboard-changes)).

It stops at a saved draft. Nothing here submits the item for review or publishes it.

## The bundle

A bundle is a directory. The layout is the contract:

```text
<bundle>/bundle.json                     written by stampBundle, never by hand
<bundle>/<locale>/description.txt        the detailed description
<bundle>/<locale>/screenshots/NN-*.png   uploaded in filename order
<bundle>/global/screenshots/NN-*.png     the group shared by every language
<bundle>/global/promo/small.png          440x280
<bundle>/global/promo/marquee.png        1400x560
<bundle>/sync-state.json                 written by sync, never by a producer
```

- A locale directory uses the extension package's own code (`ja`, `pt_BR`). The dashboard's
  hyphenated spelling (`pt-BR`) is derived.
- A section is `<scope>/<part>`, with the scope a locale or `global` and the part `description`,
  `screenshots` or `promo`. The global group has no description, and promo tiles exist only there,
  because the dashboard keeps them under "Global assets".
- Screenshots are PNG, 1 to 5 per group, 1280x800 or 640x400. A language the bundle gives no
  screenshots to is simply not touched. This is how a store's default language, whose artwork the
  dashboard keeps in the shared group, is expressed: it has no `screenshots/`, and `global/` has them.
- A description is at most 16,000 characters.

### Stamping

Producers never write `bundle.json`. They write files and call `stampBundle` (or `store-sync stamp`),
which validates each section, records a hash of every file and records where the section came from
(`version`, `commit`, `dirty`, when):

```js
import { gitProvenance, stampBundle } from "@lurkloot/store-sync";

await stampBundle({
  dir: "artifacts/store",
  name: "acme",
  extensionId: "abcdefghijklmnopabcdefghijklmnop", // optional; sync refuses another item
  source: { version: "2.1.0", ...(await gitProvenance({ cwd: repo })) },
  sections: ["ja/screenshots", "ja/description", "global/screenshots"],
  forget: ["en/screenshots"], // sections a producer removed
});
```

```bash
store-sync stamp --bundle artifacts/store --name acme --version 2.1.0 --commit "$(git rev-parse HEAD)" \
  --sections ja/screenshots ja/description
```

Only the sections named are restamped, so a producer that regenerates some languages cannot erase the
rest. A producer replaces its own section directories and never touches `sync-state.json`.

Reading is strict. `readBundle` refuses a bundle with a file that changed since it was stamped, a file
that was added or is missing, a section nobody stamped, or a stray file or directory, and lists every
problem at once. Files a producer forgot to stamp are never uploaded.

## Commands

```text
store-sync <validate|sync|verify|snapshot|stamp> [options]

  --bundle <dir>             the bundle (default ./store-bundle)
  --locales <a b …>          only these languages
  --only <part>              descriptions, screenshots or global
  --global                   include the shared group in a run that names languages
  --expect-version <v>       the version the artwork must have been generated from
  --allow-version-mismatch   accept artwork from another version, or from different versions
  --allow-dirty              accept artwork generated from a tree with uncommitted changes
  --force                    upload even what the last verified sync left in place
  --no-verify                skip the readback after a sync
```

| Command | What it does | Needs the dashboard |
| --- | --- | --- |
| `validate` | Reads the bundle and checks it, including artwork provenance | no |
| `sync` | Validates, edits the draft, saves it, then reads it back | yes |
| `verify` | Reads the dashboard and compares it with the bundle; changes nothing | yes |
| `snapshot --locales …` | Writes sanitized copies of the page for the contract tests | yes |
| `stamp` | Records sections a producer wrote | no |

A run that names languages leaves the shared group alone unless `--global` or `--only global` asks for
it, because the shared group belongs to no language. Options are strict: an unknown one is an error.

Syncing needs `CWS_EXTENSION_ID` (32 letters) and `CWS_PUBLISHER_ID` (the UUID in the Developer
Dashboard's URL). A bundle stamped with an extension id is refused for any other.

### Artwork provenance

Screenshots show a build, and a listing that shows the wrong one is worse than no update. Sync refuses
artwork whose stamp says it came from a different version than `--expect-version`, from different
versions in one run, or from a dirty working tree. Descriptions carry no build and are not checked.
The expected version is an option because only the caller knows what it is: a wrapper supplies it, and
this package never reads tags or a `package.json`.

### Reading the dashboard back

A sync can finish without an error while the page still shows something else, so it ends by reloading
the listing and comparing: each language's description (line endings and surrounding whitespace
ignored) and the number of screenshots in each group the bundle fills. A mismatch fails the command and
names the group. `verify` runs the same check on its own. When Chrome was already running, the tab the
command opened is closed after a clean run and left open after a failure.

### Skipping what is already there

After a sync passes its readback, `sync-state.json` in the bundle records, per group, a hash of every
local image and the thumbnail ids the dashboard showed. The next sync leaves a group alone only when
both still match, so an image edited locally is uploaded again, and an image changed by hand on the
dashboard is replaced rather than trusted. `--force` always uploads.

### Screenshot groups

A group of 1 to 5 images is made to hold exactly the bundle's images in order. The dashboard only
offers "remove the leading image" and "add one", so the group is trimmed to size, topped up, and then
rotated once: each image is removed from the front and its replacement appended. Removing an image
raises a confirmation, which is answered. Image changes take effect as they are made, so "Save draft"
is often already inactive at the end; that is reported, not an error.

### Locked listings

A submitted item cannot be edited until its review ends. The description field stays disabled and the
page says `Status: Pending review`. The preflight waits out the moment the form is disabled while
loading, then stops with the status in the message and changes nothing. `verify` still works and prints
the status.

### Promo tiles

They are validated, stamped and carried in the bundle, and `validate` and `sync` say plainly that they
are not uploaded. There is no promo upload yet.

## The Chrome session

Playwright never starts the browser. Google refuses interactive sign-in in a browser started with
automation switches (`accounts.google.com/v3/signin/rejected`). Chrome is spawned as an ordinary
browser and Playwright attaches over the DevTools protocol once you are signed in, so complete sign-in
and 2FA in the window it opens.

The profile is `$XDG_STATE_HOME/<name>/cws-chrome-profile`
(`~/.local/state/<name>/cws-chrome-profile` by default), where `<name>` is the bundle's name. It holds
live Google credentials: keep it local, never copy it, delete it to sign out. A caller can name the
profile with the `profileApp` option for commands that load no bundle (`snapshot`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CWS_CHROME_BINARY` | first of `google-chrome-stable`, `google-chrome`, `chrome`, `chromium`, `chromium-browser` on `PATH` | Full path to the browser to start |
| `CWS_CDP_PORT` | `9333` | DevTools port |
| `CWS_CHROME_PROFILE` | the path above | Use a different profile directory |

If something is already listening on the port, the command attaches to it and leaves it running. Any
failure keeps the browser open: signing in again costs 2FA, and after a mutation the half-changed draft
is what the operator needs to see.

## Calling it from a wrapper

`store-sync`'s `main(args, env, options)` is exported as `@lurkloot/store-sync/cli`. A wrapper adds
options and nothing else:

| Option | Purpose |
| --- | --- |
| `bundleDir` | Default for `--bundle` |
| `invocation` | The command named in retry hints, such as `pnpm store:sync` |
| `expectedVersion` | Default for `--expect-version` |
| `profileApp` | Chrome profile name for commands with no bundle |
| `checks` | Async functions `({ bundle, locales, parts, output })` run before a sync; throw to stop |

## When the dashboard changes

`tests/fixtures/cws-dashboard/` holds sanitized snapshots of the real page and
`tests/storeSyncContract.test.ts` runs every locator against them. The hand-built fixtures in
`tests/storeSyncDashboard.test.ts` only prove the driver handles the page its author imagined. When the
dashboard changes, retake the snapshots while signed in:

```bash
store-sync snapshot --locales en es
```

A snapshot keeps only the listing form and removes scripts, styles, links, hidden inputs, option lists
(which hold account and site names), image addresses and every attribute outside a short allow list.
Guard tests fail on an email address, an id, a Google host or a `data-` attribute, but read the diff
before committing: the page is a signed-in session.
