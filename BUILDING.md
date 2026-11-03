# Building Lurkloot from source

These steps rebuild the Firefox add-on from the sources archive
(`lurkloot-X.Y.Z-firefox-sources.zip`) attached to every
[GitHub release](https://github.com/jamezrin/lurkloot/releases) and uploaded to
Firefox Add-ons. They produce the same files as the published
`lurkloot-X.Y.Z-firefox.zip`.

## Requirements

- Linux, macOS or Windows (WSL)
- [Node.js](https://nodejs.org/) 24
- [pnpm](https://pnpm.io/) 12.16.1, for example `npm install -g pnpm@12.16.1`

The release builds run on `ubuntu-latest` with exactly these versions.

## Build

From the root of the extracted archive:

```bash
pnpm install --frozen-lockfile
pnpm build:firefox
```

The add-on is written to `packages/extension/.output/firefox-mv2/`. Compare it
with the contents of the published Firefox zip.

`pnpm build` builds the Chrome version into
`packages/extension/.output/chrome-mv3/` from the same sources.

## Layout

The extension is a pnpm workspace. The add-on bundles these packages:

- `packages/extension` — the WebExtension: entrypoints, browser adapters, build
  configuration (`wxt.config.ts`)
- `packages/core` — the browser-free farming engine
- `packages/shared` — shared types, settings and messages
- `packages/locales` — the localized message catalogs
- `packages/popup-ui` — the React popup

The command-line runtime, the website and the store-listing tooling are not
part of the add-on. The archive keeps only their `package.json` files, which
the lockfile needs in order to install.

The add-on downloads and evaluates no remote code. [WXT](https://wxt.dev/)
bundles and minifies it with Vite, and every dependency is pinned in
`pnpm-lock.yaml`.
