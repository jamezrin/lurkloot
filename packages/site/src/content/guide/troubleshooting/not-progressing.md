---
title: A drop is not progressing
description: What to check when the watch time on a drop does not go up.
section: troubleshooting
order: 1
---

First, give it a few minutes. Twitch and Kick update progress in steps, and the campaign card catches up on the next refresh. Your inventory page on Twitch or Kick shows the platform's own number.

If it still does not move, go through these.

## Is Lurkloot actually watching it?

Look at the status strip. It shows what is being watched right now.

- **Nothing, or a different campaign.** Something higher in the [Queue](/guide/popup/queue) is being farmed, or this campaign is under **Skipped** or **Action required**. Its card says why.
- **Paused.** You are watching a stream yourself, or you closed Lurkloot's tab. See [Background watching](/guide/settings/background-watching#watching-a-stream-yourself).
- **Signed out.** See [Sign-in and access problems](/guide/troubleshooting/sign-in).

## Is the computer awake?

The extension only works while your browser is open and the computer is awake. The CLI needs no browser, but its machine has to stay awake too. A sleeping laptop farms nothing. Progress carries on when it wakes up.

## Does the channel count?

A drop only counts on channels taking part in the campaign. Lurkloot checks every minute and moves on after three checks find the channel offline or streaming another game. If you think a channel should count and it does not, try turning on **Strict campaign availability** (Twitch), which uses only the channels Twitch lists.

## Is background watching counting?

If background watching stops counting, the extension opens the stream in a muted tab after 5 failed checks. The CLI has no tabs to fall back to, so there it keeps trying without one. If you see a tab open, that is it working. Leave the tab open.

If it never counts, even in a tab, turn off **Tabless low-resource mode** so Lurkloot always uses a tab, and see whether that helps. Mention it in a [bug report](/guide/troubleshooting/report-a-problem).

## Does the reward need something else?

- **A linked game account.** Many campaigns only pay out once your game account is connected. See [Linked game accounts](/guide/choosing/linked-accounts).
- **A subscription.** See [Subscription rewards](/guide/farming/subscription-rewards).
- **An earlier reward first.** Some campaigns unlock rewards in order.

## Kick only

Kick sometimes refuses the extension's background connection. Lurkloot then opens a Kick page in a tab to work through. If Kick refuses your browser entirely, see [Sign-in and access problems](/guide/troubleshooting/sign-in).
