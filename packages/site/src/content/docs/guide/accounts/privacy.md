---
title: Privacy and account safety
description: What Lurkloot can see, what it never does, and what to keep in mind about your accounts.
sidebar:
  order: 2
---

## What Lurkloot uses

The extension uses the Twitch and Kick sessions already signed in to your browser. That is how it can see your drops and claim them.

- It never asks for your password.
- There is no Lurkloot account, no Lurkloot server and no analytics. Your settings, progress and activity stay in your browser.
- It talks to Twitch and Kick directly. When you turn on [NoPixel](/guide/farming/nopixel) or [Fortnite](/guide/farming/fortnite), it also talks to that extension's own service, and only after your browser asks you for permission. That service gets the same viewer pass a Twitch extension normally gets. Depending on how your accounts are linked, it can tell who you are and update your rewards there. It never gets your Twitch or Kick login.

The [privacy policy](/privacy) has the full details.

## Exporting your sign-ins

**Settings → Export credentials** saves your Twitch and Kick sign-ins to a file, to set up the CLI. Only you can start it, and Lurkloot asks you to confirm first.

Treat that file like a password. Anyone who has it can use your Twitch and Kick accounts. Do not share it, upload it or attach it to a bug report. Delete it once the CLI has imported it.

**Export settings** is different: it never contains your login. It does contain your Watchlist, games and other preferences, so look through it before you share it.

## What others can see

- Streamers see you as a viewer of their stream, like any viewer.
- Only when you turn on **Always enter channel chat**, or use NoPixel, does your name appear in the chat's viewer list. Lurkloot never sends a chat message.

## Platform rules

Lurkloot is an independent project, not made or approved by Twitch, Kick, Epic Games or NoPixel. Platform rules can change, and automated watching may go against them. Use it at your own discretion.
