---
title: Games and categories
description: Choose which games are farmed, which come first, and which are never farmed.
section: choosing
order: 2
support:
  extension: "yes"
  cli: "yes"
  note: With code sign-in on Twitch, the CLI also uses this list to know which games to look for.
---

The **Games** view decides which games Lurkloot farms drops for. Each platform has its own.

## All categories or only selected

At the top of Games, pick one:

- **All categories** (default): every game with live drops is farmed, except blocked ones.
- **Only selected**: only the games you tick are farmed. With nothing ticked, nothing is farmed on that platform, and Games warns you.

Search for a game to add it to the list.

## Star a game

The star puts a game's campaigns near the top of the Queue, after pinned campaigns. It does not choose what is farmed: in **All categories** a starred game is farmed anyway, but in **Only selected** you also need to tick it. Drag starred games, or type a number, to order them. See [Campaign order](/guide/choosing/campaign-order).

## Block a game

The ⊘ button blocks a game. Its campaigns are never farmed, in either mode, and show under **Skipped** in the Queue. A campaign that covers several games is skipped only when all of them are blocked; otherwise Lurkloot farms it on channels playing one of the others. You can also block a game from one of its campaigns: **Exclude** → **Category**. Choose it again to unblock.

A blocked game that was starred keeps its star for when you unblock it.

## In the CLI

The CLI uses the same lists. With [code sign-in on Twitch](/guide/headless/sign-in), the CLI cannot see the full campaign list, so it looks for campaigns on live channels of up to four games taken from this list. Add the games you care about there, even with **All categories**.
