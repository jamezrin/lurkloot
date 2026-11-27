---
title: Install the desktop app
description: Download the Lurkloot desktop app for Windows, macOS or Linux, get past the unsigned-app warning on its first launch, and keep it farming from the tray.
sidebar:
  order: 4
---

The desktop app is the CLI's [web app](/guide/headless/app) in a window of its own, with the CLI inside it. It farms like `lurkloot serve`, keeps going from the tray when you close the window, and needs no terminal. It is in *beta*.

## Download it

Each [GitHub release](https://github.com/jamezrin/lurkloot/releases/latest) has an installer for each system:

| System | Download |
| --- | --- |
| Windows | `lurkloot-desktop-<version>-windows-x64-setup.exe`, or the `.msi`, or the `-portable.zip` to run without installing |
| macOS (Apple Silicon) | `lurkloot-desktop-<version>-macos-arm64.dmg` |
| macOS (Intel) | `lurkloot-desktop-<version>-macos-x64.dmg` |
| Linux (x64) | `lurkloot-desktop-<version>-linux-x64.AppImage`, or the `.deb` |
| Linux (arm64) | `lurkloot-desktop-<version>-linux-arm64.AppImage`, or the `.deb` |

`SHA256SUMS` in the same release lists each file's checksum.

## The first launch

The installers are not signed with a Windows or Apple developer certificate yet, so both systems warn about them once. After that the app starts normally.

### Windows

1. Run the `-setup.exe` (or the `.msi`).
2. If Windows shows *Windows protected your PC*, select *More info*, then *Run anyway*.
3. Start Lurkloot from the Start menu.

To run it without installing, unzip the `-portable.zip` anywhere you like, such as a USB drive, and run `Lurkloot.exe` from the `Lurkloot` folder. It needs Microsoft Edge WebView2, which Windows 10 and 11 already have. The portable copy does not update itself (see [Updates](#updates)).

### macOS

1. Open the `.dmg` and drag Lurkloot to Applications.
2. Open Lurkloot. macOS says it cannot check the app for malicious software. Select *Done*.
3. Open *System Settings → Privacy & Security*, scroll to the message about Lurkloot, and select *Open Anyway*. Confirm with your password.

### Linux

- **AppImage:** make it executable and run it: `chmod +x lurkloot-desktop-*.AppImage`, then `./lurkloot-desktop-<version>-linux-x64.AppImage`.
- **On Debian, Ubuntu and similar:** `sudo apt install ./lurkloot-desktop-<version>-linux-x64.deb`, then start Lurkloot from your applications menu.

## Using it

- Sign in from Accounts in the window. Twitch's browser sign-in opens in a window of the app's own, so there is nothing to paste. See [Sign in to the CLI](/guide/headless/sign-in) for what each sign-in can see.
- Closing the window keeps farming. The tray icon has *Open Lurkloot*, *Launch at startup*, *Check for updates automatically* and *Quit*. On a Linux desktop with no tray, closing the window quits.
- *Launch at startup* starts Lurkloot when you sign in to your computer. It is off until you tick it. Lurkloot then farms from the tray, without opening its window, until you choose *Open Lurkloot*. If your desktop has no tray, the window opens instead. If you turn it off in your system's own startup settings (*Task Manager → Startup apps* on Windows, *System Settings → General → Login Items* on macOS), Lurkloot leaves it off.
- Your settings and sign-ins are kept in your user folder, so they survive reinstalling and updating:

| System | Folder |
| --- | --- |
| Windows | `%APPDATA%\name.jamezrin.lurkloot\` |
| macOS | `~/Library/Application Support/name.jamezrin.lurkloot/` |
| Linux | `~/.local/share/name.jamezrin.lurkloot/` |

## Updates

Lurkloot checks for a new version when it starts and every few hours. It never restarts by itself. When an update is ready, the tray shows *Update ready: restart to install* with the new version, and the window shows **Restart to update**. Choose either when it suits you: Lurkloot stops farming, saves, installs the update and starts again, with your settings and sign-ins kept.

Each update is signed, and Lurkloot refuses one whose signature does not match. To stop checking, untick *Check for updates automatically* in the tray. If you installed the `.deb`, Linux asks for your password to install an update.

The Windows portable zip never updates itself and has no *Check for updates automatically* in its tray. To update it, quit Lurkloot, then replace the `Lurkloot` folder with the one from the new release's `-portable.zip`. Your settings and sign-ins are in your user folder, not in the `Lurkloot` folder, so they are kept.

## Uninstall it

- **Windows:** *Settings → Apps → Installed apps*, then Lurkloot, then *Uninstall*. For the portable zip, turn off *Launch at startup* if you turned it on, quit Lurkloot and delete its folder.
- **macOS:** quit Lurkloot from the tray and move it from Applications to the Bin.
- **Linux:** delete the AppImage, or `sudo apt remove lurkloot`.

Uninstalling leaves the folder above. Delete it too to remove your settings and sign-ins.
