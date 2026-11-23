---
title: Compatibility settings
description: What the compatibility options are for, and why you should usually leave them on Automatic.
sidebar:
  order: 3
support:
  extension: "yes"
  cli: "yes"
---

Twitch and Kick change how their sites work from time to time. Lurkloot ships with several ways of talking to each platform, and picks the right one by itself. The **Compatibility** settings, under each platform's **Advanced & compatibility**, let you choose by hand.

Leave them on **Automatic** unless a bug report or the maintainer asks you to change one. Automatic follows Lurkloot's updates. A manual choice stays as it is, and may stop working when the platform changes. While one is set, Settings shows *Manual compatibility overrides are active*.

## The options

| Setting | Platform | What it chooses |
| --- | --- | --- |
| **Twitch compatibility profile** | Twitch | A bundled set of the options below, by date, for example *Twitch October 2026*. |
| **Twitch heartbeat transport** | Twitch | How Lurkloot tells Twitch you are watching, in the background. |
| **Twitch inventory query** | Twitch | How it reads your drops and progress. |
| **Kick compatibility profile** | Kick | A bundled set of Kick options. |
| **Kick claim-link handling** | Kick | How it handles the links Kick uses to connect game accounts. |

Each option is marked *Recommended*, *Legacy* or *Experimental*.

## In the CLI

The CLI's app (`lurkloot serve`) has the same settings. In [`config.json`](/guide/headless/config) they are under `compatibility`, and `"auto"` is Automatic:

```jsonc title="config.json"
{
  "settings": {
    "compatibility": {
      "twitch": {
        "profile": "auto",
        "heartbeatTransport": "auto",
        "inventoryQueryVersion": "auto"
      },
      "kick": {
        "profile": "auto",
        "claimLinkHandling": "auto"
      }
    }
  }
}
```

Only change one when a bug report or the maintainer gives you a value. `lurkloot validate-config` warns about a value it does not know, and the CLI then uses Automatic.

## Getting back to normal

Click **Restore automatic compatibility** to put every option back on Automatic.
