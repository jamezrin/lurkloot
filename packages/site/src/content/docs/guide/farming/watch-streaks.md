---
title: Twitch watch streaks
description: Keep your Twitch watch streak going on the channels you choose.
sidebar:
  order: 7
support:
  extension: "yes"
  cli: "partial"
  note: The CLI needs Twitch to accept its live connection to see when a streak is confirmed. This has not been fully tested for every CLI sign-in.
---

Twitch rewards you for watching a channel's streams regularly, with a watch streak and bonus channel points. Lurkloot can keep that streak going on channels in your [Watchlist](/guide/farming/watchlist): it watches each new stream on those channels until Twitch confirms the streak, then goes back to whatever else it was doing.

## Turning it on

1. Open **Watchlist** on Twitch.
2. Next to a channel, turn on **Maintain watch streak**.

Do this for each channel whose streak you want to keep.

## How it works

- **Watch streaks** is its own source in [Watch-source priority](/guide/choosing/watch-source-priority), first by default, ahead of Drops. When a streak channel goes live, Lurkloot watches it before anything else.
- It watches until Twitch confirms the streak payout, or until the **Watch streak budget** runs out (15 minutes by default), whichever comes first. Then it returns to drops or the rest of your Watchlist.
- It watches each stream once. If the video will not play, it waits for the **Watch streak retry delay** and tries the same stream again, up to **Watch streak tries** times, keeping the time it already watched. A new stream on that channel starts over.

## What the labels mean

| Label | Meaning |
| --- | --- |
| **Streak pending** | Waiting for the channel's next stream. |
| **Keeping streak** | Watching the stream now for its streak. |
| **Streak confirmed** | Twitch paid out the streak for this stream. |
| **Not confirmed** | Lurkloot watched for the full time, but Twitch did not confirm a streak. Twitch may not have counted this stream, or you may already have had it. |
| **Couldn't watch** | The stream would not play after several tries. |
| **Streak unavailable** | Lurkloot cannot follow streaks right now, so the channel is watched as an ordinary Watchlist channel. |

## Settings

Under **Advanced** in the Twitch settings:

| Setting | Default | What it does |
| --- | --- | --- |
| **Watch streak budget** | 15 minutes | How long a stream is watched before moving on if Twitch has not confirmed the streak (5–60). |
| **Watch streak retry delay** | 30 minutes | How long to wait before trying again after the stream would not play (10–240). |
| **Watch streak tries** | 3 | How many times to try a stream that will not play before showing *Couldn't watch* (1–5). |

## Things to know

- Lurkloot does not know your streak count. It only knows whether Twitch confirmed the streak for a stream.
- Kick has its own watch streak, which any Kick watching counts toward. See [Kick daily challenges and level](/guide/farming/kick-challenges).
