---
title: Kick drops
description: How Lurkloot farms Kick drop campaigns, and what is different from Twitch.
sidebar:
  order: 2
support:
  extension: "yes"
  cli: "yes"
  note: The CLI reaches Kick with its default connection setting. With the http setting, Kick blocks it.
---

Kick runs drop campaigns too: watch a game's streams for a while and earn an in-game item. Lurkloot farms them the same way it farms Twitch drops. It finds the campaigns, watches a live channel that counts, and claims each reward.

## How it works

1. **Finding campaigns.** Lurkloot reads Kick's list of drop campaigns and your progress on each. It hears about newly started campaigns straight away.
2. **Choosing a channel.** It uses a channel the campaign lists, or else the live channel with the most viewers in that game. A channel you follow or have in your Watchlist wins when **Prefer followed and Watchlist channels** is on.
3. **Watching.** In the background, Lurkloot joins the stream as a viewer, the same way an open Kick page does, without playing the video.
4. **Claiming.** Each reward is claimed once its watch time is reached.

## Things to know

- **Only item rewards.** Kick drops are in-game items. The other reward types in [Rewards to farm](/guide/choosing/rewards-to-farm) are Twitch only.
- **Linking your game account.** Most Kick drops need your game account connected to Kick before you can claim them. The campaign shows **Link your account** when it does. See [Linked game accounts](/guide/choosing/linked-accounts).
- **Kick sometimes blocks the extension.** Kick's security checks can refuse requests from the extension. When that happens, Lurkloot opens a Kick page in a tab and works through it. The tab closes again once things work normally for a few minutes. If Kick refuses your browser profile completely, the popup says *Kick rejected this browser profile*, and signing in again may not help. See [Sign-in and access problems](/guide/troubleshooting/sign-in).
- **Watch time also counts toward your Kick level.** Anything Lurkloot watches on Kick counts toward your viewer level and watch streak. See [Kick daily challenges and level](/guide/farming/kick-challenges).
- **No channel points.** Kick has no channel points to collect.

## In the CLI

The CLI farms Kick drops without a browser. Sign it in with a code you confirm in the Kick app on your phone (`auth kick device-login`), or import credentials from the extension. Keep the default `impersonate` connection setting (or `impit` or `cycletls`): Kick can block the plain `http` setting. See [Sign in to the CLI](/guide/headless/sign-in).
