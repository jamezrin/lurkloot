---
title: Sign in to the CLI
description: The ways to sign the CLI in to Twitch and Kick, and which one to pick.
section: headless
order: 4
---

The CLI cannot use a browser's session, so it signs in once on its own and keeps that sign-in in its data folder. You can sign in from the **Accounts** page of [its web app](/guide/headless/app), or with the commands below.

Commands are shown as `lurkloot …`. With Docker, run them as `docker run --rm -it -v "$PWD/data:/data" ghcr.io/jamezrin/lurkloot-cli:latest auth …`, or `docker compose run --rm lurkloot auth …`.

## Twitch

| Method | Sees every campaign? | How |
| --- | --- | --- |
| **Browser sign-in** (recommended) | Yes | Sign in on a page in any browser and paste back an address. |
| **Imported from the extension** | Yes | Export a file from the extension, import it in the CLI. |
| **Code sign-in** | No, only campaigns you have started | Enter a code on Twitch's activation page. |

### Browser sign-in

```bash
lurkloot auth twitch browser-login
```

1. Open the link it prints, in any browser, and sign in to Twitch.
2. Twitch sends you to an address starting with `https://www.twitch.tv/#access_token=`. Copy the whole address from the address bar.
3. Paste it at the prompt.

Twitch sometimes removes the `#access_token` part from the address bar almost at once. If that happens, open your browser's developer tools on the **Network** tab and turn on **Preserve log** before you sign in. Then filter for `access_token` and copy the `location` header of the `id.twitch.tv` request.

### Code sign-in

```bash
lurkloot auth twitch device-login
```

It prints a link and a code. Open the link on any device, enter the code and approve. No browser is needed on the server.

Twitch only lets this sign-in see campaigns you have already started. The CLI finds others by looking at live channels of up to four games from your [Games list](/guide/choosing/games), so it misses campaigns whose channels are offline. Use it only if browser sign-in is not an option.

## Kick

```bash
lurkloot auth kick device-login
```

It prints a `kick.com/tv/login` link and a 6-digit code. Open the link **on your phone**, where it opens in the Kick app you are signed in to, and confirm the code. The link does not work in a computer's browser.

## Import from the extension

This brings over the Twitch and Kick sign-ins from your browser.

1. In the extension, open Settings → **Export credentials** and confirm. If your browser asks for one more site permission, allow it. Without it, the Twitch part cannot be imported.
2. Copy the file to the CLI's machine. With Docker, put it in the `data` folder, because the container only sees that folder.
3. Run `lurkloot auth import <file>`. With Docker, the path is the one inside the container, for example `auth import /data/lurkloot-credentials.json`.
4. Delete the file. Anyone who has it can use your accounts.

## Checking and signing out

See what is signed in:

```bash
lurkloot auth status
```

Sign out of Twitch (use `kick` instead of `twitch` for Kick):

```bash
lurkloot auth twitch logout
```

If you set `SA_TWITCH_AUTH_TOKEN` or `SA_KICK_SESSION_TOKEN` as environment variables, those win over whatever is stored. Remove them to use a sign-in made here.
