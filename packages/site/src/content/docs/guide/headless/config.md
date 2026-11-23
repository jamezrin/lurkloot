---
title: CLI settings
description: Where the CLI keeps its settings, how to change them, and how they differ from the extension's.
sidebar:
  order: 6
---

The CLI keeps its settings in `config.json`, in its data folder (`/data` in Docker). The first command you run creates it, listing every setting with its default and a comment on the important ones.

## Changing settings

- **From the web app:** with `lurkloot serve`, change them in Settings, as in the extension. They are saved to `config.json` at once, and comments and layout in the file are kept.
- **By editing the file:** stop the CLI, edit `config.json`, and start it again. Comments (`//`) and trailing commas are allowed.

Check a hand-edited file with `lurkloot validate-config`. It prints the settings the CLI will use, or names the setting it does not accept.

## Differences from the extension

- **Both platforms start switched on.** Turn one off with `"enabled": false` under `platform.twitch` or `platform.kick`.
- **Extension-only settings are refused,** with an error naming them. These are the tab settings, pause while watching, auto-start, language and diagnostic logs. So you cannot simply paste the extension's settings into `config.json`.
- **Your sign-in is never in `config.json`.** It is kept separately in the `auth` folder.
- **How much the log shows:** set it with `--log debug|info|warn|error` on the command line, not in the file.

## A minimal example

This is a complete `config.json`: it farms Twitch only and keeps one channel on the Watchlist. Anything you leave out uses its default.

```json
{
  "settings": {
    "platform": {
      "twitch": {
        "enabled": true,
        "watchlistChannels": ["somechannel"]
      },
      "kick": {
        "enabled": false
      }
    }
  }
}
```

The setting names match the extension's: see [All settings](/guide/settings/reference) for what each one does.

## Connection setting

`"transport"` at the top of the file is `"impersonate"` by default, which reaches both Twitch and Kick. `"http"` is lighter but Kick blocks it, so only use it for Twitch-only setups.
