---
title: Subscription rewards
description: Rewards that need a channel subscription, what Lurkloot does with them, and Mark as subscribed.
sidebar:
  order: 5
support:
  extension: "yes"
  cli: "yes"
---

Some Twitch drop rewards need a subscription to a channel, or several subscriptions or gifted subs, instead of (or as well as) watch time. Lurkloot never subscribes or spends money for you. It watches for the part it can earn, and leaves the subscription to you.

## What you see

A campaign whose rewards need a subscription shows under **Action required** in the Queue, with *Subscription required* or *$N qualifying subscriptions required*. Pins and favourites still change its order, but cannot make Lurkloot do the subscribing.

Rewards that need both a subscription and watch time are farmed for their watch time once Twitch counts your subscription.

## After you subscribe

Twitch is not always clear about whether a subscription has counted. If you have subscribed and the reward still says it is waiting:

1. Open the campaign and click **I've subscribed — refresh status**. Lurkloot checks with Twitch again.
2. If it still shows *Progress unavailable* or *Waiting for a qualifying subscription*, click **Mark as subscribed** on that reward. Lurkloot then treats the subscription as done: rewards that depend on it unlock, and a reward that also needs watch time is farmed. **Undo** removes the mark.

A mark is your word, not Twitch's. Lurkloot still only claims a reward once Twitch releases it.

## Choosing whether to farm them

In [Rewards to farm](/guide/choosing/rewards-to-farm), **Subscription rewards** can be:

- **Include** (default): farmed with the rest.
- **Skip**: rewards that need a subscription are left out.
- **Only**: only rewards that need a subscription are farmed.

Kick has no subscription rewards.

## In the CLI

The CLI's app (`lurkloot serve`) has the same controls. To set it in [`config.json`](/guide/headless/config) instead:

```jsonc title="config.json"
{
  "settings": {
    "platform": {
      "twitch": {
        "rewardFilter": {
          "subscriptions": "skip"
        }
      }
    }
  }
}
```

`subscriptions` is `"include"`, `"skip"` or `"only"`. **Mark as subscribed** is in the app too. It saves the reward in `subscribedRewardMarks`.
