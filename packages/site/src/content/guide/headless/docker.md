---
title: Run the CLI with Docker
description: Start Lurkloot in Docker, with or without its web app, and keep it running.
section: headless
order: 2
---

The image is `ghcr.io/jamezrin/lurkloot-cli`, for `amd64` and `arm64`. Everything it keeps (settings, sign-in, progress and history) goes in the folder you mount at `/data`.

## With the web app (recommended)

This runs `lurkloot serve` with Docker Compose, so you can manage Lurkloot from a browser page.

```bash
mkdir lurkloot && cd lurkloot
curl -fsSLO https://raw.githubusercontent.com/jamezrin/lurkloot/main/packages/cli/compose.yaml
echo "LURKLOOT_SERVE_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Open `http://127.0.0.1:8420` on the same machine. It asks for the token: the value after `LURKLOOT_SERVE_TOKEN=` in `.env`. Then sign in to Twitch and Kick from the **Accounts** page. See [The CLI web app](/guide/headless/app).

Your data is in `./data`.

## Without the web app

Sign in first:

```bash
docker run --rm -it -v "$PWD/data:/data" ghcr.io/jamezrin/lurkloot-cli:latest auth twitch browser-login
docker run --rm -it -v "$PWD/data:/data" ghcr.io/jamezrin/lurkloot-cli:latest auth kick device-login
```

Then start it in the background:

```bash
docker run -d --name lurkloot --restart unless-stopped \
  -v "$PWD/data:/data" ghcr.io/jamezrin/lurkloot-cli:latest
```

The first command creates `data/config.json` with every setting and a comment on each. See [Sign in to the CLI](/guide/headless/sign-in) and [CLI settings](/guide/headless/config).

## Watching what it does

```bash
docker compose logs -f
```

Without Compose, use `docker logs -f lurkloot`.

## Updating

```bash
docker compose pull && docker compose up -d
```

Without Compose, pull the image, then remove and start the container again with the same `-v` folder. Your settings and sign-in are kept.

## More than one account

Run one container per account, each with its own data folder (and its own port, for `serve`).
