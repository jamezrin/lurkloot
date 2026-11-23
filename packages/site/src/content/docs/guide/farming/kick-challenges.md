---
title: Kick daily challenges and level
description: Claim Kick's daily challenge rewards and keep track of your viewer level and watch streak.
sidebar:
  order: 8
support:
  extension: "yes"
  cli: "yes"
---

## Daily challenges

Kick sets daily challenges with a watch-time goal. When you meet the goal, there is a reward to claim. Anything Lurkloot watches on Kick counts toward the goal: drops, or your Watchlist.

With **Auto-claim daily challenges** on (the default), Lurkloot claims the reward as soon as the goal is met. If notifications are on, you get *Challenge reward claimed*.

The setting is in Settings, in the Kick section.

## Level and watch streak

On Kick, the status strip shows a small badge with your viewer level, how close you are to the next one, and your daily watch streak, for example *Kick level 12 · 40% to level 13* and *5-day watch streak*. It refreshes about every 10 minutes. It is hidden when you are signed out, or when the popup is too narrow to fit it.

## Keeping it going when there are no drops

Kick watch time only counts while Lurkloot is watching something. Add a few channels to your Kick [Watchlist](/guide/farming/watchlist), so it keeps watching when no drop campaigns are running.

## In the CLI

The CLI's app (`lurkloot serve`) has the same controls. To set it in [`config.json`](/guide/headless/config) instead:

```jsonc title="config.json"
{
  "settings": {
    "platform": {
      "kick": {
        "autoClaimChallenges": true,
        "watchlistChannels": ["kickchannel"]
      }
    }
  }
}
```

