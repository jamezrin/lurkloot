---
title: Compatibility settings
description: What the compatibility options are for, and why you should usually leave them on Automatic.
section: settings
order: 3
support:
  extension: "yes"
  cli: "yes"
---

Twitch and Kick change how their sites work from time to time. Lurkloot ships with several ways of talking to each platform, and picks the right one by itself. The **Compatibility** settings, under each platform's **Advanced & compatibility**, let you choose by hand.

**Leave them on Automatic** unless a bug report or the maintainer asks you to change one. Automatic follows Lurkloot's updates. A manual choice stays as it is, and may stop working when the platform changes. While one is set, Settings shows *Manual compatibility overrides are active*.

## The options

| Setting | Platform | What it chooses |
| --- | --- | --- |
| **Twitch compatibility profile** | Twitch | A bundled set of the options below, by date, for example *Twitch October 2026*. |
| **Twitch heartbeat transport** | Twitch | How Lurkloot tells Twitch you are watching, in the background. |
| **Twitch inventory query** | Twitch | How it reads your drops and progress. |
| **Kick compatibility profile** | Kick | A bundled set of Kick options. |
| **Kick claim-link handling** | Kick | How it handles the links Kick uses to connect game accounts. |

Each option is marked *Recommended*, *Legacy* or *Experimental*.

## Getting back to normal

Click **Restore automatic compatibility** to put every option back on Automatic.
