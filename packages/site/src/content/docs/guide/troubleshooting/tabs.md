---
title: Tabs keep opening
description: Why Lurkloot opens a tab, why it might open over and over, and what to do about it.
sidebar:
  order: 2
---

## Why Lurkloot opens a tab

Lurkloot watches in the background without a tab. It only opens one when:

- **Background watching stopped counting.** Lurkloot plays that stream in a pinned, muted tab instead. See [Background watching and tabs](/guide/settings/background-watching).
- **Kick blocked a background request,** so it opens a Kick page to get past Kick's checks. It closes again after a few good checks in a row.
- **Tabless low-resource mode is off,** so every watch uses a tab.

Lurkloot reuses its tab when it switches channels, and closes it when nothing needs it (with **Auto-close farming tabs** on).

## Closing the tab

If you close Lurkloot's tab, it pauses that platform: *You closed the farming tab, so Lurkloot stopped farming here.* It does not reopen it until you click **Resume farming**.

## A tab that keeps opening and closing

If a tab keeps reopening, Lurkloot stops it by itself. It shows *Lurkloot has stopped working* with the reason *a tab kept reopening*, and pauses that platform so you can use your browser normally. See [Lurkloot has stopped working](/guide/troubleshooting/stopped-working).

If you see a tab opening and closing again and again before that happens:

1. Switch the platform off in the status strip, to stop it straight away.
2. Copy the log from **Activity** and [report it](/guide/troubleshooting/report-a-problem). It is a bug.
3. Check whether another extension is changing Twitch or Kick pages, for example by redirecting or closing tabs. Try with it turned off.

## Fewer tabs

- Keep **Tabless low-resource mode** on (the default).
- Raise **Tabless fallback threshold** under Advanced, so more background checks must fail before a tab opens.
