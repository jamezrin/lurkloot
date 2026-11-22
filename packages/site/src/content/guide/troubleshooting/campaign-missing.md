---
title: A campaign is missing
description: Why a drop campaign you expected is not in the Queue, and where to look.
section: troubleshooting
order: 3
---

## Look in the other lists

A campaign may be in the popup, just not where you expect:

- **Skipped**, at the bottom of the Queue, with the reason it is not farmed.
- **Action required**, if it needs a subscription or a choice.
- **Upcoming**, if it has not started yet.
- **Completed**, if every reward is claimed, or it ended.

## Check your filters

- **Games → Only selected** farms only the ticked games. Switch to **All categories**, or tick the game.
- A **blocked** game is never farmed.
- [Rewards to farm](/guide/choosing/rewards-to-farm) can leave a campaign out if none of its rewards match.
- **Campaigns without a linked account** set to **Skip** leaves out campaigns that need a linked game account.

## Does your account see it?

Lurkloot only sees campaigns your account can see. Open the Drops page on Twitch, or the drops page on Kick, while signed in to the same account:

- If it is not there either, the campaign is not available to your account, for example because of your region, or it has not started.
- If it is there and Lurkloot still does not show it, wait for the next refresh (a minute or so), then [report it](/guide/troubleshooting/report-a-problem).

## In the CLI

With [code sign-in on Twitch](/guide/headless/sign-in), the CLI only sees campaigns you have already started, plus those it finds on live channels of the games in your Games list. Add the game to your Games list, or sign in with browser sign-in instead.
