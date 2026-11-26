# @lurkloot/desktop

The Lurkloot desktop app (#981, #1024). It's a [Tauri 2](https://tauri.app) shell that starts
the bundled standalone `lurkloot serve`, shows its app UI in its own window, and keeps farming
from the tray when the window is closed.

The shell is **packaging only**. It never imports `@lurkloot/core`, `@lurkloot/shared`, the CLI's
sources or cycletls, and it farms only through `serve`.
`packages/extension/tests/desktopBoundary.test.ts` enforces this. The "Desktop app" section of
[docs/architecture.md](../../docs/architecture.md) explains how it works.

## What it does

- Starts `lurkloot serve --port 0 --ready-json --exit-with-stdin --config <app data>/config.json`.
  It passes a fresh random `LURKLOOT_SERVE_TOKEN` for each launch and removes any other
  `LURKLOOT_*` or `SA_*` variable from serve's environment. serve starts the cycletls binary on a
  free port of its own and never joins another process's (#1031).
- Opens the window at the URL from serve's ready line. Before the page loads, it writes the
  token to sessionStorage, so the app never asks for it.
- Keeps the window on serve's own address. Links and `window.open` go to the system browser.
- If serve exits unexpectedly, starts it again after a backoff of 1 s up to 60 s. After three
  failures in a row it shows an error.
- Closing the window keeps farming in the tray, which has **Open Lurkloot** and **Quit**. On a
  Linux desktop with no tray, closing the window quits instead.
- Quit closes serve's stdin and waits up to 20 s for it to save and exit. If it hasn't, the
  shell kills serve's whole process tree, cycletls included.
- A second launch focuses the running window.

Config, credentials (`auth/`) and `state.json` live in the OS's app-data folder for the
identifier `name.jamezrin.lurkloot`:

| OS | Data | serve's log |
| --- | --- | --- |
| Linux | `~/.local/share/name.jamezrin.lurkloot/` | `…/logs/serve.log` |
| macOS | `~/Library/Application Support/name.jamezrin.lurkloot/` | `~/Library/Logs/name.jamezrin.lurkloot/serve.log` |
| Windows | `%APPDATA%\name.jamezrin.lurkloot\` | `%LOCALAPPDATA%\name.jamezrin.lurkloot\logs\serve.log` |

The identifier fixes those paths, so it must never change.

## Development setup

You need everything the standalone CLI build needs (Node 24 and pnpm), plus:

- **Rust**, stable, via [rustup](https://rustup.rs).
- **The OS's web view and build tools**:
  - Linux (Debian/Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev build-essential`.
    On Arch: `webkit2gtk-4.1 libayatana-appindicator librsvg xdotool base-devel`.
  - macOS: the Xcode command-line tools (`xcode-select --install`).
  - Windows: the Visual Studio C++ build tools and WebView2, which Windows 10 and 11 already have.

Tauri's [prerequisites page](https://tauri.app/start/prerequisites/) has the details for each OS.

## Commands

From the repository root:

```bash
pnpm install
pnpm dev:desktop        # build the sidecar for this machine, then run the app (tauri dev)
```

From `packages/desktop`:

```bash
pnpm sidecar            # build the standalone CLI executable and copy it to src-tauri/sidecar/
node scripts/prepareSidecar.mjs --skip-build   # copy the last build again
pnpm dev                # sidecar + tauri dev
pnpm bundle             # sidecar + tauri build (installers come with #1025)
pnpm test:rust          # cargo test: supervisor, ready line, navigation, token script
```

`src-tauri/sidecar/` holds the whole executable folder (`lurkloot`, `app/`, `impit/`,
`cycletls/`, `LICENSE`, `NOTICE`), which ships as the app's `sidecar/` resource. Git ignores
everything there except its README. A missing sidecar shows up as a start failure in the window
and in `serve.log`.

CI (`.github/workflows/build-desktop.yml`) runs `cargo fmt --check`, clippy and `cargo test` on
Linux, macOS and Windows.

## Layout

- `src-tauri/src/lib.rs`: the app: window, tray, quit, and wiring the supervisor to the window.
- `src-tauri/src/sidecar.rs`: starts, watches, restarts and stops serve. It has no Tauri code.
- `src-tauri/src/ready.rs`: parses serve's ready line.
- `src-tauri/src/navigation.rs`: where the window may go.
- `src-tauri/src/token.rs`: the launch token and the script that hands it to the page.
- `src-tauri/src/tray.rs`: whether this desktop can show a tray icon.
- `shell/`: the status page shown while serve starts, restarts or keeps failing.
- `scripts/prepareSidecar.mjs`: copies the executable folder into `src-tauri/sidecar/`.
