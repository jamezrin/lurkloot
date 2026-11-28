---
title: Rewards to farm
description: Choose which kinds of reward Lurkloot farms, separately for pinned campaigns, favourite games and everything else.
sidebar:
  order: 3
support:
  extension: "yes"
  cli: "yes"
---

**Rewards to farm** is the filter menu at the top of the Queue. The same setting is in Settings for each platform. It decides which rewards Lurkloot spends time on. A campaign with nothing that matches moves to **Skipped**.

When you have changed anything from the defaults, the button is highlighted with a dot.

## Reward types

On Twitch, a reward is one of **In-game items**, **Badges** or **Emotes**. Kick only has in-game items. A reward is farmed if any part of it matches.

The types are a grid with three rows, one for each group in the Queue:

- **Pinned campaigns**
- **Favourite games**
- **Other campaigns**

Tick the types you want for each group. Click a heading to tick or untick a whole row or column. At least one box always stays ticked.

Some examples:

- **Only in-game items, everywhere:** untick the Badges and Emotes columns.
- **Only farm what I pin:** untick the Favourite games and Other campaigns rows. Campaigns you have not pinned then say *Pin it to farm it*.
- **Badges only from my favourite games:** tick Badges in the Favourite games row only.

If a reward you chose needs another reward first, such as a badge you left unticked, Lurkloot farms that one too. Lurkloot stops working on a campaign once the rewards you chose from it are earned. It still claims anything else from that campaign that becomes ready.

## Subscription rewards

- **Include** (default): rewards that need a subscription are farmed with the rest.
- **Skip**: they are left out.
- **Only**: only they are farmed.

See [Subscription rewards](/guide/farming/subscription-rewards).

## Campaigns without a linked account

**Include**, **Skip** or **Farm last**. See [Linked game accounts](/guide/choosing/linked-accounts).

## In the CLI

The CLI's app (`lurkloot serve`) has the same controls. To set it in [`config.json`](/guide/headless/config) instead:

```jsonc title="config.json"
{
  "settings": {
    "platform": {
      "twitch": {
        "rewardFilter": {
          "pinnedKinds": ["item", "badge", "emote"],
          "favouriteKinds": ["item", "badge"],
          "kinds": ["item"],
          "subscriptions": "include"
        },
        "unlinkedCampaigns": "last"
      }
    }
  }
}
```

This farms everything from pinned campaigns, items and badges from favourite games, and only items from everything else. Campaigns without a linked account are farmed last.

- The three rows are `pinnedKinds` (Pinned campaigns), `favouriteKinds` (Favourite games) and `kinds` (Other campaigns).
- The types are `"item"`, `"badge"` and `"emote"`. Kick only has `"item"`. An empty list, `[]`, farms nothing from that row.
- `subscriptions` is `"include"`, `"skip"` or `"only"`.
- `unlinkedCampaigns` is `"include"`, `"skip"` or `"last"` (Farm last).

For Kick, use the same keys under `"kick"` instead of `"twitch"`.

## Starting over

**Reset to all rewards** puts the filter back to its defaults.
