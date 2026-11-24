---
title: Run the CLI as a program
description: Download the standalone Lurkloot CLI for Linux, macOS or Windows and start it.
sidebar:
  order: 3
---

Each [GitHub release](https://github.com/jamezrin/lurkloot/releases/latest) has the CLI as a download for each system. Nothing else needs installing.

| System | Download |
| --- | --- |
| Linux (x64) | `lurkloot-cli-<version>-linux-x64.tar.gz` |
| Linux (arm64) | `lurkloot-cli-<version>-linux-arm64.tar.gz` |
| macOS (Apple Silicon) | `lurkloot-cli-<version>-macos-arm64.tar.gz` |
| macOS (Intel) | `lurkloot-cli-<version>-macos-x64.tar.gz` |
| Windows | `lurkloot-cli-<version>-windows-x64.zip` |

## Start it

On Linux or macOS, using the name of the file you downloaded (this example is Linux x64; for a Mac with Apple Silicon it would be `macos-arm64`):

```bash
tar -xzf lurkloot-cli-<version>-linux-x64.tar.gz
cd lurkloot-cli-<version>-linux-x64
./lurkloot auth twitch browser-login
./lurkloot serve
```

On Windows, unzip it, then open PowerShell in that folder:

```powershell
.\lurkloot.exe auth twitch browser-login
.\lurkloot.exe serve
```

`serve` farms and opens the [web app](/guide/headless/app) at `http://127.0.0.1:8420/`. Use `run` instead to farm with no web app.

## Things to know

- **Keep the folder together.** The `impit` and `cycletls` folders next to `lurkloot` are what let it reach Kick. Do not move `lurkloot` out on its own.
- **Your data goes where you run it from.** `config.json`, the sign-in and the progress files are created in the current folder, not beside the program. To upgrade, unpack the new version and run it from the same place.
- **Linux and macOS:** with the `"cycletls"` connection setting, keep the folder in a path without spaces or special characters.
- **macOS** blocks the first start of a downloaded program that is not notarized. Allow `lurkloot`, the `.node` file in `impit` and `cycletls/cycletls` in System Settings → Privacy & Security, or run `xattr -dr com.apple.quarantine` on the unpacked folder.
- **Windows** SmartScreen may warn on first start. Click **More info** → **Run anyway**.
- **Linux** builds need a reasonably recent glibc. On Alpine or other musl systems, [use Docker](/guide/headless/docker).
