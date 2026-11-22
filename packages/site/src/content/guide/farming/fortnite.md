---
title: Fortnite
description: Collect Fortnite sprites and phase rewards from the Fortnite Twitch extension.
section: farming
order: 10
support:
  extension: "yes"
  cli: "partial"
  note: Works in the CLI with credentials imported from the extension. With other CLI sign-ins it is tried but has not been fully tested.
---

Fortnite streams on Twitch can run a Fortnite extension that hands out sprites and phase rewards to viewers. Lurkloot can collect them in the background.

## Turning it on

1. Open the Twitch platform in the popup, then **Extensions** → **Fortnite**.
2. Switch it on. Your browser asks for permission to reach the extension's site. Allow it.

It is off until you turn it on.

## What it does

- Finds a live Fortnite stream that has the extension, and watches it in the background.
- Collects sprites as they appear and earns the rewards for each phase. Each confirmed capture shows in Activity.
- When there is nothing left to collect, it lets other sources take over and checks back later.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Allow Fortnite takeovers** | Off | Starts eligible takeovers during interactive phases. |

## Things to know

- **Order against drops.** By default, drops and NoPixel come first, then Fortnite, then your Watchlist. Change it in [Watch-source priority](/guide/choosing/watch-source-priority).
- **No tab fallback.** Fortnite is always watched in the background. If that stops working on a channel, Lurkloot rests that channel for a few minutes and moves on.
- Some Twitch extensions ask you to share your Twitch identity with them before they work. If rewards never arrive, open a Fortnite stream on Twitch once and check the extension's panel.
