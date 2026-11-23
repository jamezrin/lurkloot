---
title: Twitch channel points
description: Earn channel points and claim bonus chests on every Twitch channel Lurkloot watches.
sidebar:
  order: 3
support:
  extension: "yes"
  cli: "yes"
  note: In the CLI, instant claiming depends on Twitch accepting its live connection. Otherwise it checks once a minute.
---

Every Twitch channel Lurkloot watches earns you that channel's channel points, whether it is watching for a drop, a Watchlist channel or a Twitch extension reward. On top of the points for watching, Lurkloot claims the bonus chest whenever one appears.

## Settings

Both are in Settings under the Twitch section, and both are on by default:

| Setting | What it does |
| --- | --- |
| **Auto-claim channel points** | Claims the bonus chest on the channel being watched. |
| **Claim channel points from live events** | Claims the bonus as soon as Twitch offers it. Turn this off and Lurkloot checks once a minute instead. |

## Seeing what you earned

**Activity** shows your farming sessions with the points each one earned, split by reason: *Watching*, *Bonus*, *Streak* (from [watch streaks](/guide/farming/watch-streaks)) and *Raid*.

## In the CLI

The CLI's app (`lurkloot serve`) has the same controls. To set it in [`config.json`](/guide/headless/config) instead:

```jsonc title="config.json"
{
  "settings": {
    "platform": {
      "twitch": {
        "autoClaimChannelPoints": true,
        "channelPointsPushClaim": true
      }
    }
  }
}
```

`channelPointsPushClaim` is **Claim channel points from live events**.

## Things to know

- Points are earned only on channels Lurkloot is actually watching. To earn on your favourite channels when there are no drops, add them to your [Watchlist](/guide/farming/watchlist).
- Kick has no channel points.
