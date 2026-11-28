---
title: Campaign order
description: Pin campaigns, star games and pick a rule for the rest, so Lurkloot farms what you care about first.
sidebar:
  order: 1
support:
  extension: "yes"
  cli: "yes"
---

Lurkloot farms one campaign per platform at a time: the highest one in the [Queue](/guide/popup/queue) that has a live channel. The order has three layers.

## 1. Pinned campaigns

Drag a campaign card to a new place, or type a rank, and it is pinned there. Pinned campaigns always come first, in your order. **Unpin all** clears them.

Pins stay put when a campaign is briefly missing. If Twitch or Kick stops listing it for a while, it comes back in the same place.

## 2. Favourite games

Star a game in **Games**, and its campaigns come right after the pinned ones. Favourites are ordered among themselves the same way as pins: drag them, or type a number.

Stars are long-lived: next season's campaign for a game you starred is already near the top when it starts.

## 3. Then by

Everything else follows the rule you pick on the **Then by** divider in the Queue, or under **Campaign priority** in Settings.

One exception: if [campaigns without a linked account](/guide/choosing/linked-accounts) are set to **Farm last**, those come after every linked campaign, even one that ends later. The rule below still orders campaigns within each of the two groups.

- **Ending soonest** (default): campaigns that end first are farmed first, so fewer run out before you finish them.
- **Low availability first**: campaigns with the fewest channels to watch go first, while you can still find one.

## Rewards earned once a day

Some Twitch campaigns give a reward once a day, such as a badge for an hour of watching on each of six days. A day you miss is gone for good, so while today's reward can still be earned, that campaign goes ahead of the others in its layer, whatever its end date. Once today's reward is in, it goes back to its usual place until the next day opens. This never moves a campaign above your pinned ones, and it only applies to rewards you farm under [Rewards to farm](/guide/choosing/rewards-to-farm).

## When the order changes mid-campaign

Lurkloot does not drop progress lightly. If it is part-way through a reward and a campaign further up becomes watchable:

- A **pinned** campaign above takes over straight away.
- A favourite or a campaign under Then by waits until the current reward is earned.

## In the CLI

The CLI's app (`lurkloot serve`) has the same Queue: drag campaigns, star games and pick **Then by** there. In [`config.json`](/guide/headless/config), the rule is one setting for both platforms:

```jsonc title="config.json"
{
  "settings": {
    "priorityMode": "lowest_availability"
  }
}
```

It is `"ending_soonest"` (Ending soonest) or `"lowest_availability"` (Low availability first).

Pins are saved per platform in `campaignPins`, and excluded campaigns in `excludedCampaignIds`, as lists of campaign IDs. Twitch and Kick do not show those IDs, so pin and exclude from the app rather than by hand. Favourite games are in `favouriteCategories`: see [Games and categories](/guide/choosing/games#in-the-cli).

## What the order cannot do

The order only decides *which first*. It never makes a campaign farmable. A campaign that is excluded, blocked, outside your [Rewards to farm](/guide/choosing/rewards-to-farm) or waiting for a subscription stays in **Skipped** or **Action required**, wherever you pin it.
