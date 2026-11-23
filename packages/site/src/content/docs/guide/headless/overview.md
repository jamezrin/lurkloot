---
title: What the CLI is
description: Lurkloot without a browser, for a server, a NAS or an always-on PC. What it can do and what it cannot.
sidebar:
  order: 1
---

The Lurkloot CLI is the same farming engine as the extension, without the browser. You start it once on a machine that stays on, and it keeps farming Twitch and Kick by itself. It is in **beta**.

## Ways to run it

- **[Docker](/guide/headless/docker)**: the easiest on a server or NAS. Works on `amd64` and `arm64`.
- **[A standalone program](/guide/headless/executable)** for Linux, macOS or Windows, with nothing else to install.

Either way, it can run as `lurkloot run`, which just farms, or `lurkloot serve`, which also gives you [a web page to control it](/guide/headless/app).

## How it differs from the extension

- **It signs in with its own login.** It does not use a browser's session. See [Sign in to the CLI](/guide/headless/sign-in).
- **It always watches in the background.** There is no video, no tab and no ads. If background watching stops counting, it keeps retrying rather than opening a tab.
- **Campaign discovery depends on the Twitch sign-in.** Browser sign-in and imported credentials see every campaign. Code sign-in only sees campaigns you have already started, plus those it finds on live channels of the games you list.
- **No desktop notifications.** Claims and other events go to its log, and to Activity in its app.
- **Some settings do not exist.** Anything about tabs, pausing while you watch, and auto-start. See [All settings](/guide/settings/reference).

The full list is in [Extension or CLI?](/guide/getting-started/extension-or-cli).

## What is not fully tested yet

- Claiming Twitch drops from the CLI alone, on a live account.
- Twitch's live connection (instant channel-point claims, watch streaks) with code and browser sign-ins.
- NoPixel and Fortnite with sign-ins other than credentials imported from the extension.

If you try one of these, a [bug report](/guide/troubleshooting/report-a-problem), or a note that it worked, helps.
