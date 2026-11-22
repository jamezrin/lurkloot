---
title: Background watching and tabs
description: How Lurkloot watches without a video, when it opens a muted tab instead, and the settings for those tabs.
section: settings
order: 1
support:
  extension: "yes"
  cli: "partial"
  note: The CLI always watches in the background. It cannot open a tab, so it keeps retrying instead.
---

## Watching in the background

By default, Lurkloot watches without opening a stream. It tells Twitch or Kick you are watching the same way their own player does, but without the picture, sound or ads. Your computer stays quiet and your bandwidth stays free. This is **Tabless low-resource mode**, and it is on by default.

- **Twitch:** Lurkloot loads the stream the way the player does, without showing it.
- **Kick:** Lurkloot joins the stream as a viewer, as an open Kick page does.

## When a tab opens

Sometimes background watching stops counting. If 5 checks in a row fail (**Tabless fallback threshold**), Lurkloot opens the stream in a **pinned, muted tab** instead. It is a real stream, so a Twitch or Kick ad can play there.

Leave that tab alone. Lurkloot reuses it when it switches channels, and closes it when it no longer needs it (with **Auto-close farming tabs** on).

If you close it yourself, Lurkloot takes that as a sign you want it to stop. Farming on that platform pauses with *You closed the farming tab, so Lurkloot stopped farming here.* Click **Resume farming** to carry on.

Turn tabless mode off to always use a tab.

## Settings for farming tabs

These are under **Farming tabs** in Settings. Some only apply when tabless mode is off, or when it falls back to a tab.

| Setting | Default | What it does |
| --- | --- | --- |
| **Tabless low-resource mode** | On | Watch in the background, with a tab only as a fallback. |
| **Auto-close farming tabs** | On | Close Lurkloot's tabs when there is nothing to farm or watch. |
| **Mute farming tabs** | On | Keep drop and Watchlist tabs muted. |
| **Keep farming videos unmuted** | On | Keep the page's video player unmuted while the browser tab itself stays muted, so you hear nothing. |
| **Focus tab during ads** | Tab + window | Ad countdowns freeze in background tabs. Lurkloot briefly brings the tab forward while an ad plays, then puts your previous tab back. **Tab only** does not switch windows. **None** turns it off. |

## Watching a stream yourself

With **Pause when watching manually** on (the default), Lurkloot pauses a platform while you have one of its streams open and playing. Pause the stream, close it or switch away from it, and farming resumes on the next check.

## In the CLI

The CLI has no tabs. Everything is watched in the background, and if that fails it keeps retrying rather than opening a tab. The settings on this page do not exist in the CLI.
