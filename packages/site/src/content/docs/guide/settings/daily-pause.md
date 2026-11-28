---
title: Daily watch pause
description: Stop watching during the same hours every day, and let Lurkloot resume on its own.
sidebar:
  order: 5
support:
  extension: "yes"
  cli: "yes"
---

The **Daily watch pause** stops watching on Twitch and Kick during the same hours every day, for example overnight. When the pause ends, farming resumes on its own. It is off by default.

## Setting it up

It is in Settings, next to **Pause when watching manually**. Turn on **Daily watch pause**, then set:

| Field | What it means |
| --- | --- |
| **From** | When the pause starts each day. |
| **Until** | When it ends. A time earlier than the start means the next day, so 23:00 to 07:00 runs overnight. |
| **Time zone** | Whose clock the times follow. The first time you turn the pause on, it uses your computer's time zone. |

Below the fields, Lurkloot shows when the next pause starts, or when the current one ends. If the start and end are the same, or the time zone is not one it knows (such as Europe/Madrid or UTC), it says so and keeps your last working schedule.

## While it is paused

- Lurkloot closes the farming tabs it opened and stops background watching. It leaves the tabs you opened yourself alone.
- The status line reads **Daily pause** and shows when farming resumes.
- Rewards that are ready are still claimed, and Lurkloot keeps checking that you are signed in.
- When the pause ends, a platform starts farming again only if its switch is still on. A platform you paused by closing its farming tab stays paused until you resume it.

## Daylight saving

The times follow the clock in your time zone, all year. On the night the clocks change, the pause can run up to an hour shorter or longer than usual:

- If a time does not exist that night because the clock jumps forward, the pause uses the moment the clock jumps.
- If a time happens twice because the clock goes back, the pause uses the first one, so it never pauses twice in one night.

## In the CLI

The CLI's app (`lurkloot serve`) has the same controls. To set it in [`config.json`](/guide/headless/config) instead:

```jsonc title="config.json"
{
  "settings": {
    "watchPauseSchedule": {
      "enabled": true,
      "start": "23:00",
      "end": "07:00",
      "timeZone": "Europe/Madrid"
    }
  }
}
```

Times are 24-hour. The CLI refuses to start with a time it cannot read, the same start and end, or an unknown time zone, and names the field to fix.
