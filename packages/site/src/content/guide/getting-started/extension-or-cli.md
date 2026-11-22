---
title: Extension or CLI?
description: The two ways to run Lurkloot, what each one is good at, and which features work in each.
section: getting-started
order: 3
supportTable: true
---

Lurkloot comes in two forms. Both use the same farming engine, so they pick campaigns, switch channels and claim rewards the same way. What differs is where they run and how they sign in.

## The browser extension

The extension is the main way to use Lurkloot, and the one most people should pick.

- It installs from the Chrome Web Store in a few clicks.
- It uses the Twitch and Kick accounts you are already signed in to. There is no separate sign-in.
- It sees every drop campaign your account can earn.
- If watching in the background stops counting, it can open a muted tab with the stream instead.
- It needs your browser to stay open.

## The CLI (beta)

The CLI is Lurkloot without a browser. It runs in Docker, or as a standalone program on Linux, macOS or Windows, and suits a server, a NAS or a PC that is always on.

- It signs in once with its own login and keeps farming on its own.
- `lurkloot serve` gives it a web page with the same views as the popup.
- It never opens a stream video, so it cannot fall back to a tab. Everything it watches is watched in the background.
- How many Twitch campaigns it can see depends on [how you sign in](/guide/headless/sign-in).
- It is in beta. Some parts have not been fully tested against live accounts yet, and the pages below say which.

## What works where

"Partly" means the feature works with limits, which the linked page explains.
