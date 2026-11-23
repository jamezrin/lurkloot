---
title: Twitch drops
description: How Lurkloot finds, watches and claims Twitch drop campaigns, and the quirks to know about.
sidebar:
  order: 1
support:
  extension: "yes"
  cli: "partial"
  note: The CLI sees every campaign only with browser sign-in or imported credentials. Claiming drops from the CLI alone has not been fully tested on a live account yet.
---

Twitch drops are rewards a game gives you for watching its streams for a while: an in-game item, a badge or an emote. Lurkloot finds the ones you can still earn, watches a channel that counts, and claims each reward as soon as it is ready.

## How it works

1. **Finding campaigns.** Lurkloot reads your Twitch drops inventory and the list of current campaigns, the same ones you see on Twitch's Drops page. Campaigns appear in the [Queue](/guide/popup/queue).
2. **Choosing a campaign.** It takes the first campaign in the Queue that has a live channel to watch. You decide the order with [pins, favourite games and the Then by rule](/guide/choosing/campaign-order).
3. **Choosing a channel.** When a campaign lists the channels taking part, Lurkloot uses one of those. Otherwise it looks for live channels streaming that game with drops turned on, and picks the one with the most viewers. If **Prefer followed and Watchlist channels** is on, a channel you follow or have in your Watchlist wins over an unfamiliar one.
4. **Watching.** By default it watches [in the background](/guide/settings/background-watching), with no video playing. Your progress shows on the campaign card and on Twitch's own inventory page.
5. **Claiming.** Each reward is claimed the moment it is earned. A campaign with several rewards is claimed one at a time, so a one-hour reward does not wait for the five-hour one.
6. **Moving on.** When the campaign is done, the stream ends, or the channel switches to another game, Lurkloot picks the next channel or the next campaign by itself.

## Things to know

- **Switching when a stream ends.** Lurkloot checks the channel every minute. When Twitch announces that the stream ended, Lurkloot confirms it a minute later and switches. Otherwise it switches after three checks in a row find the channel offline or playing another game.
- **Fast reward handoff.** After a claim, Lurkloot checks for the next reward in the campaign every few seconds for up to 45 seconds, rather than waiting for the next minute. This is the **Fast reward handoff** setting.
- **Rewards that cannot finish in time.** If a reward needs more watch time than is left before the campaign ends, Lurkloot skips it rather than wasting time on it. Turn this off with **Skip rewards that cannot be completed**.
- **Linked game accounts.** Many campaigns only pay out when your game account is connected to Twitch. Lurkloot still farms them by default, but you only get the reward once you link the account. See [Linked game accounts](/guide/choosing/linked-accounts).
- **Subscription rewards.** Some rewards need you to subscribe to a channel. Lurkloot never subscribes for you. See [Subscription rewards](/guide/farming/subscription-rewards).
- **Special Events and IRL.** Channels taking part in these campaigns often stream another category. Lurkloot accepts them anyway, as long as they are on the campaign's channel list.
- **Campaigns missing from a channel.** Twitch does not always list a campaign on every channel that counts toward it. Lurkloot watches those channels anyway. To only use channels Twitch lists, turn on **Strict campaign availability**. That can leave some drops unfarmed.
- **Badge campaigns.** Twitch also runs sitewide badge events. They appear in the same Queue. See [Twitch badge campaigns](/guide/farming/twitch-reward-campaigns).

## In the CLI

The CLI farms Twitch drops the same way, always in the background. How much it sees depends on how you sign it in:

- **Sign in with your browser** (`auth twitch browser-login`) and a sign-in imported from the extension both see every campaign.
- **Sign in with a code** (`auth twitch device-login`) only sees campaigns you have already started. To find others, the CLI looks at live channels of up to four games from your Games list, so add the games you care about there. It cannot find campaigns whose channels are offline.

See [Sign in to the CLI](/guide/headless/sign-in).
