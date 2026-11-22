---
title: NoPixel
description: Earn NoPixel V daily card packs and join giveaways on NoPixel streams.
section: farming
order: 9
support:
  extension: "yes"
  cli: "partial"
  note: Works in the CLI with credentials imported from the extension. With other CLI sign-ins it is tried but has not been fully tested.
---

NoPixel V is a GTA roleplay server whose Twitch streams run a Twitch extension. Watching earns daily card packs, and the extension runs giveaways. Lurkloot can earn both for you, without opening the stream.

## Turning it on

1. Open the Twitch platform in the popup, then **Extensions** → **NoPixel V**.
2. Switch it on. Your browser asks for permission to reach NoPixel's site. Allow it.

It is off until you turn it on.

## What it does

- Finds a live NoPixel stream that has the extension, and watches it in the background.
- Shows your progress toward the day's pack, for example *Daily pack: 40/60 minutes*.
- Joins giveaways when one is open (*Giveaway entered*).
- Once the daily pack is earned, it stops watching for NoPixel until the next day (UTC), and lets other sources take over.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Open NoPixelV packs automatically** | Off | Reveals cards from unopened packs. Opening uses up the pack and cannot be undone. |

## Things to know

- **You appear in chat.** NoPixel only counts watch time for viewers who are in the channel's chat. Lurkloot joins the chat, so you appear in its viewer list. It never sends a message. If it cannot join chat, the popup says *Not in chat*, and watch time is not earned until it can.
- **Order against drops.** By default, drops come first, then NoPixel, then Fortnite, then your Watchlist. Change it in [Watch-source priority](/guide/choosing/watch-source-priority).
- **No tab fallback.** NoPixel is always watched in the background. If that stops working on a channel, Lurkloot rests that channel for a few minutes and tries another channel or another source.
- Excluded drop channels and pausing while you watch apply here too.
