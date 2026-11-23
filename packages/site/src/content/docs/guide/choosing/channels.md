---
title: Channels and chat
description: Prefer channels you know, exclude channels you don't want, and choose whether to appear in chat.
sidebar:
  order: 6
support:
  extension: "yes"
  cli: "yes"
  note: Joining Kick chat from the CLI needs its default connection setting.
---

## Prefer followed and Watchlist channels

When a drop can be earned on several channels, Lurkloot normally picks the one with the most viewers. With **Prefer followed and Watchlist channels** on (the default), it picks a channel from your Watchlist first, then one you follow, then the rest.

Turn it off to always go by viewer count.

## Excluded drop channels

Add a channel to **Excluded drop channels**, in each platform's settings, and Lurkloot never watches it for drops or Twitch extension rewards. Channels you put in your [Watchlist](/guide/farming/watchlist) are still watched as Watchlist channels.

## Strict campaign availability (Twitch)

Twitch does not always list a campaign on every channel that counts toward it, so Lurkloot also uses channels that stream the campaign's game. **Strict campaign availability** limits it to the channels Twitch lists. This is off by default, because it can leave drops unfarmed.

## Always enter channel chat

Off by default. Turn on **Always enter channel chat** to join the chat of each channel Lurkloot watches in the background. You then appear in the chat's viewer list, where streamers and moderators can see you. Lurkloot never sends a message.

[NoPixel](/guide/farming/nopixel) joins chat whatever this setting says, because it only counts watch time for viewers in chat.

## In the CLI

The CLI's app (`lurkloot serve`) has the same controls. To set it in [`config.json`](/guide/headless/config) instead:

```jsonc title="config.json"
{
  "settings": {
    "preferKnownChannels": true,
    "platform": {
      "twitch": {
        "excludedChannels": ["somechannel"],
        "strictCampaignAvailability": false,
        "alwaysEnterChat": false
      },
      "kick": {
        "excludedChannels": ["otherchannel"]
      }
    }
  }
}
```

`preferKnownChannels` applies to both platforms. The others are set per platform. Channel names are written without `@`.
