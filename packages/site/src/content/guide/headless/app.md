---
title: The CLI web app
description: Manage the CLI from a browser page with the same views as the extension popup.
section: headless
order: 5
---

`lurkloot serve` farms like `lurkloot run`, and also serves a web page with the views you know from the extension popup: Queue, Completed, Games, Watchlist, Extensions, Activity and Settings. It adds an **Accounts** page to sign in to Twitch and Kick.

Changes you make there are saved to the CLI's `config.json` straight away, and apply without a restart.

## Opening it

Start `lurkloot serve`, or the Docker Compose setup in [Run the CLI with Docker](/guide/headless/docker), and open `http://127.0.0.1:8420/` on the same machine.

If an access token is set (`LURKLOOT_SERVE_TOKEN`, which the Docker Compose setup sets), the page asks for it once. It is kept in that browser tab only.

## What is different from the popup

- No tab settings, no auto-start and no in-page panel. The CLI has no browser.
- The language is chosen per browser, in the app.
- Activity has no Diagnostics tab. To save diagnostics for a bug report, see [Report a problem](/guide/troubleshooting/report-a-problem#from-the-cli).

## Opening it from another machine

By default the app only answers on the machine it runs on. To reach it from elsewhere:

- An access token is required. `serve` will not listen on other addresses without `LURKLOOT_SERVE_TOKEN` (at least 16 characters).
- Start it with `--host 0.0.0.0` (or the address the proxy connects to), plus the token. Docker already does this. Left on its default address, `serve` turns away requests that arrive under another name, so the app will not load through a proxy.
- Put it behind a reverse proxy that serves HTTPS, such as Caddy or Traefik, so the token is never sent in the clear. With nginx, add `proxy_set_header Host $http_host;`.
- Keep the plain HTTP port itself closed to other machines, for example with a firewall, so the only way in is through the proxy.

Do not expose it to the internet without HTTPS and a token. Anyone who can use it can change your settings and sign-ins.
