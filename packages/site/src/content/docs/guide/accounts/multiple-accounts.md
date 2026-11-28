---
title: Farm on more than one account
description: Use one browser profile per account to farm several Twitch or Kick accounts at the same time.
sidebar:
  order: 1
support:
  extension: "yes"
  cli: "yes"
  note: In the CLI, run one copy per account, each with its own data folder.
---

Lurkloot farms whichever Twitch and Kick accounts are signed in to the browser it runs in. To farm a second account, give it a browser profile of its own.

## Set up a second account

1. Create a new browser profile. In Chrome, click your profile picture in the top-right corner, then **Add**. Edge, Brave and the other Chromium browsers have the same option in their profile menu.
2. In the new profile, [install Lurkloot](/guide/getting-started/install) again.
3. Sign in to the other Twitch or Kick account in that profile.
4. Open the Lurkloot popup in that profile and switch on the platform.

Repeat for each extra account. Keep a window from each profile open, or that profile stops farming.

## Things to know

- Each profile has its own settings, queue and Activity. There is no single view across them.
- To copy your settings from one profile to another, use **Export settings** in one profile and import the file in the other. The file never contains your Twitch or Kick login.
- Every profile that is farming plays by the same rules as the first one, including muted tabs that open when a stream must actually play.

## In the CLI

Run one CLI per account. Give each its own folder for `config.json` and its sign-in, or with Docker, its own container and data volume. See [Run the CLI with Docker](/guide/headless/docker).
