---
title: Watch-source priority
description: Decide whether drops, watch streaks, Twitch extension rewards or your Watchlist come first.
section: choosing
order: 5
support:
  extension: "yes"
  cli: "yes"
---

Lurkloot can watch for several reasons, called *sources*. **Watch-source priority**, in each platform's settings, decides which one wins when more than one has something to watch.

## The sources

| Source | Platform | Default place |
| --- | --- | --- |
| [Watch streaks](/guide/farming/watch-streaks) | Twitch | 1st |
| Drops | Twitch and Kick | 2nd on Twitch, 1st on Kick |
| [NoPixelV](/guide/farming/nopixel) | Twitch | 3rd |
| [Fortnite](/guide/farming/fortnite) | Twitch | 4th |
| [Watchlist](/guide/farming/watchlist) | Twitch and Kick | Last |

## How it decides

The first source in the list that has something to watch right now is watched. A source that is switched off or has nothing live is skipped.

A higher source takes over as soon as it has something, even in the middle of a drop. For example, with the default order, a streak channel going live interrupts a drop for up to 15 minutes, then the drop carries on.

## Changing the order

Use the up and down buttons next to each source. **Reset priority** puts back the defaults. The change applies within a minute.

Common changes:

- **Watchlist first.** Move **Watchlist** above **Drops** to watch your own channels whenever one is live, and farm drops only when none is.
- **Drops over streaks.** Move **Watch streaks** below **Drops** so streaks never interrupt a drop. A streak channel is then only watched when no drop is.
