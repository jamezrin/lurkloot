---
title: All settings
description: Every setting in Lurkloot, what it does, its default, and whether the CLI has it.
section: settings
order: 2
---

Settings has a search box at the top: type part of a setting's name to find it. Each platform also has its own section. Open **Show advanced settings** to see the advanced ones.

"CLI" says whether the [CLI](/guide/getting-started/extension-or-cli) has the setting. The CLI keeps its settings in `config.json`, and its app saves changes there. See [CLI settings](/guide/headless/config).

## Appearance and behavior

| Setting | Default | What it does | CLI |
| --- | --- | --- | --- |
| **Language** | Browser language | The language of the popup and notifications. | App only |
| **Auto-start on launch** | On | Start farming as soon as the browser starts. | No, it always runs |
| **Pause when watching manually** | On | Pause while you watch a stream yourself. See [Background watching](/guide/settings/background-watching#watching-a-stream-yourself). | No |
| **Hide tips** | Off | Remove tips from the Queue. | No |
| **Show panel on Twitch and Kick** | On | Add an **Open Lurkloot** button to twitch.tv and kick.com. | No |

## Notifications

| Setting | Default | What it does | CLI |
| --- | --- | --- | --- |
| **Reward earned** | On | Notify when a drop reward is ready or claimed. | Logged |
| **No drops left** | On | Notify when every active campaign is used up. | Logged |

## Drops

| Setting | Default | What it does | CLI |
| --- | --- | --- | --- |
| **Campaign priority** | Ending soonest | How campaigns that are not pinned or favourites are ordered. See [Campaign order](/guide/choosing/campaign-order). | Yes |
| **Auto-claim drops** | On | Claim rewards as soon as they are earned. | Yes |
| **Skip rewards that cannot be completed** | On | Skip rewards that need more watch time than is left before they end. | Yes |
| **Prefer followed and Watchlist channels** | On | Pick a channel you know over an unfamiliar one. See [Channels and chat](/guide/choosing/channels). | Yes |
| **Forget excluded campaigns** | A button | Put back every campaign you excluded. | Edit `config.json` |

## Farming tabs

See [Background watching and tabs](/guide/settings/background-watching). None of these exist in the CLI.

## Platform settings

Each platform has its own section with:

| Setting | Platform | Page | CLI |
| --- | --- | --- | --- |
| **Watch-source priority** | Both | [Watch-source priority](/guide/choosing/watch-source-priority) | Yes |
| **Auto-claim channel points** | Twitch | [Channel points](/guide/farming/channel-points) | Yes |
| **Auto-claim daily challenges** | Kick | [Kick daily challenges](/guide/farming/kick-challenges) | Yes |
| **Games and categories** | Both | [Games and categories](/guide/choosing/games) | Yes |
| **Rewards to farm** | Both | [Rewards to farm](/guide/choosing/rewards-to-farm) | Yes |
| **Campaigns without a linked account** | Both | [Linked game accounts](/guide/choosing/linked-accounts) | Yes |
| **Excluded drop channels** | Both | [Channels and chat](/guide/choosing/channels) | Yes |
| **Always enter channel chat** | Both | [Channels and chat](/guide/choosing/channels) | Yes |
| **Twitch extensions** | Twitch | [NoPixel](/guide/farming/nopixel), [Fortnite](/guide/farming/fortnite) | Yes |

Under each platform's **Advanced & compatibility**:

| Setting | Platform | Default | What it does | CLI |
| --- | --- | --- | --- | --- |
| **Claim channel points from live events** | Twitch | On | Claim bonuses the moment Twitch offers them, instead of once a minute. | Yes |
| **Strict campaign availability** | Twitch | Off | Only use channels Twitch lists for a campaign. | Yes |
| **Watch streak budget**, **retry delay**, **tries** | Twitch | 15 min, 30 min, 3 | See [Watch streaks](/guide/farming/watch-streaks#settings). | Yes |
| **Compatibility** | Both | Automatic | See [Compatibility settings](/guide/settings/compatibility). | Yes |

## Advanced

Only change these if you have a reason to.

| Setting | Default | Range | What it does | CLI |
| --- | --- | --- | --- | --- |
| **Scheduler interval** | 1 minute | 1–60 | How often Lurkloot checks campaigns and streams. Longer saves a little work but reacts more slowly. | Yes |
| **Tabless fallback threshold** | 5 | 1–10 | Failed background checks in a row before a tab opens. | No |
| **Kick fallback-page recovery** | 3 | 1–10 | Good checks in a row before Lurkloot closes the Kick page it opened to get past Kick's checks. | No |
| **Fast reward handoff** | On | | After a claim, check quickly for the next reward. Twitch only. | Yes |
| **Handoff check interval** | 5 seconds | 1–30 | Time between those checks. | Yes |
| **Handoff time limit** | 45 seconds | 5–120 | When to give up and go back to the normal schedule. | Yes |
| **Deadline safety margin** | 5 minutes | 0–60 | Spare time a reward must have before its deadline to be farmed. | Yes |
| **Include diagnostic logs** | On | | Keep extra technical detail for bug reports. | No, use `--log` |

## Keeping and resetting your settings

See [Back up, move and reset](/guide/settings/backup-and-reset).
