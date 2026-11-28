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
- Closing the window keeps farming in the tray, which has **Open Lurkloot**, **Launch at startup**,
  **Check for updates automatically** and **Quit**. On a Linux desktop with no tray, closing the
  window quits instead.
- Quit closes serve's stdin and waits up to 20 s for it to save and exit. If it hasn't, the
  shell kills serve's whole process tree, cycletls included.
- A second launch focuses the running window.
- **Launch at startup** (#1027), off by default, adds the app to this user's sign-in items
  (`src/autostart.rs`):
  - Windows: a `Lurkloot` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
  - macOS: `~/Library/LaunchAgents/name.jamezrin.lurkloot.plist`.
  - Linux: `name.jamezrin.lurkloot.desktop` in `$XDG_CONFIG_HOME/autostart`, or
    `~/.config/autostart`. It points at the AppImage itself when the app runs from one.

  The entry starts the app with `--autostart`, which farms from the tray with no window until
  **Open Lurkloot**. When there's no tray, or no panel has registered to show it, the window opens.
  The choice is a shell setting, saved in `desktop.json` in the app's config folder, never in
  serve's `config.json`. Only the tray writes the entry, never a launch. A user who switches it off
  in the OS (Task Manager, Login Items) stays switched off, and an entry removed outside the app
  turns the setting off. After a failed change, the check shows what the OS really has. An
  AppImage moved after turning it on needs it turned off and on again.
- Updates itself from GitHub releases (#1028, `src/updates.rs`, Tauri's updater):
  - **When it checks:** a minute after start, then every 6 hours, while **Check for updates
    automatically** is on (`automaticUpdates` in `desktop.json`, on by default). Development
    builds never check.
  - **When it installs:** never on its own. A found update adds **Update ready: restart to install
    X.Y.Z** to the tray and a bar to the window. Choosing either downloads it, checks its signature
    against `plugins.updater.pubkey`, stops serve the way Quit does, installs and restarts. A
    failed download or signature check leaves everything running and the update ready to try again.
  - **What it installs:** the update published for the installer kind the app came from (AppImage,
    `.deb` through `pkexec`, `.msi`, NSIS, macOS `.app`), with the sidecar inside, so serve and the
    shell always match. Config and credentials stay in the app-data folder.
  - **How it installs:** the install checks the manifest again, so a release repaired since the last
    check is the one used. Checks time out after 30 s and downloads after 30 min. Only one check runs
    at a time, and none replaces an install in progress. The app can't exit while the installer runs.
    An install that fails restarts the old version, which shows the update as failed and ready to
    try again (`failedUpdate` in `desktop.json`).
  - **Signing:** each signature is bound to its version (`requireSignedVersion`), so a forged
    manifest can't downgrade the app. `RELEASING.md` ("Desktop updates") covers the key and how to
    rotate it.
- Signs in to Twitch without pasting (#1026). **Sign in to Twitch** opens Twitch's sign-in page in
  a private window of the app's own. Its cookies are discarded when it closes. When Twitch sends
  that window back with the token, the app closes it and finishes the sign-in through serve, the
  same way a pasted address would. Closing the window early cancels. If the window can't read
  Twitch's answer, the app shows the paste steps instead.

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
pnpm bundle             # sidecar + tauri build: this machine's installers
pnpm test:rust          # cargo test: supervisor, ready line, navigation, token script
```

## Installers

`pnpm bundle` writes every installer Tauri makes for this OS under
`src-tauri/target/release/bundle/`. The release builds only the ones it ships (#1025), with
`pnpm tauri build --bundles "$(node scripts/collectInstallers.mjs --bundles)"`, then
`node scripts/collectInstallers.mjs --version X.Y.Z --out <dir>` copies them out under their
release names (`lurkloot-desktop-X.Y.Z-<target>…`). The targets and names are
`desktopInstallerTargets` in `scripts/release/pipeline.mjs`; `RELEASING.md` covers the CI job.
They are unsigned; macOS builds are ad-hoc signed. The version is the root `package.json`'s:
`tauri.conf.json` points at it, and `scripts/release.mjs prepare` writes it into `Cargo.toml`.

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
- `src-tauri/src/twitch_sign_in.rs`: the Twitch sign-in window's rules: which link opens it,
  which navigation is Twitch's answer, and what the app UI is told.
- `src-tauri/src/serve_api.rs`: the shell's own two calls to serve, for that sign-in.
- `shell/`: the status page shown while serve starts, restarts or keeps failing.
- `scripts/prepareSidecar.mjs`: copies the executable folder into `src-tauri/sidecar/`.
