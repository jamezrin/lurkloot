---
title: Sign-in and access problems
description: What the sign-in messages mean, and what to do when Twitch or Kick will not let Lurkloot in.
section: troubleshooting
order: 5
---

Lurkloot uses the Twitch and Kick accounts signed in to your browser. It never signs in by itself.

## The messages

| Message | What to do |
| --- | --- |
| *Sign in to continue farming drops.* | Sign in to the platform in this browser, using **Sign in to Twitch** or **Sign in to Kick**. |
| *Your session is no longer valid. Sign in again to continue.* | Sign out of the platform's website and back in. |
| *Your browser session could not be checked. Lurkloot will retry automatically.* | Nothing. It usually clears on its own. |
| *The network is temporarily unavailable.* / *The platform is temporarily unavailable.* | Nothing. Lurkloot waits and tries again, waiting a little longer each time. |
| *Kick rejected this browser profile. Signing in alone may not resolve it.* | See below. |

## Signed in, but Lurkloot says you are not

- Make sure you signed in in the **same browser profile** Lurkloot is installed in.
- Open twitch.tv or kick.com in a tab. If the site asks you to sign in, so will Lurkloot.
- Private or incognito windows have their own sign-in. Lurkloot uses the normal one.

## Kick blocks access

Kick has strict security checks that sometimes refuse a browser. When they block background requests, Lurkloot opens a Kick page and works through it. When Kick refuses the browser profile entirely:

1. Open kick.com in a tab and complete any check it shows.
2. Sign out of Kick and back in.
3. If it keeps happening, try another browser profile with only Lurkloot installed. Other extensions can trip Kick's checks.

## In the CLI

The CLI keeps its own sign-in. If it reports a sign-in problem, sign in again with the same method. See [Sign in to the CLI](/guide/headless/sign-in). Remember that `SA_*` environment variables, if set, override what you sign in with.
