# @lurkloot/cli

A headless command-line / Docker runtime for Lurkloot. It reuses the browser
extension's farming engine (`@lurkloot/core`) through clean port/adapter seams —
there is **no faking of `chrome`/`browser` globals**; each runtime injects its
own implementations.

## Quick start

```bash
pnpm install
pnpm --filter @lurkloot/cli build          # bundles dist/index.mjs
node packages/cli/dist/index.mjs validate-config --config ./config.json
# or, from the repo root:
pnpm cli validate-config --config ./config.json
```

## Config

The config file reuses the extension's `ExtensionSettings` model **verbatim**
(validated through the same `mergeSettings`), so defaults and behavior match the
extension. Only `transport` and `authDir` are CLI-specific. **Credentials never
go in the config** — they live in the auth store.

```jsonc
{
  "transport": "impersonate",   // "http" | "impersonate" | "browser"
  "authDir": "auth",            // resolved relative to this file
  "settings": {                 // ExtensionSettings shape, merged over defaults
    "running": true,
    "tablessMode": true,
    "pollIntervalMinutes": 5,
    "platform": {
      "twitch": { "enabled": true },
      "kick":   { "enabled": true }
    }
  }
}
```

## Transports

| Transport | Twitch | Kick | Notes |
|---|---|---|---|
| `http` | ✅ plain Node fetch | ❌ Cloudflare WAF (403) | Lightest; Twitch-only in practice. |
| `impersonate` | ✅ | ✅ **cycletls Chrome JA3/HTTP-2** | Recommended default. Fixes Kick with no browser. |
| `browser` | ✅ + **integrity capture** (claims) | ✅ via cycletls | Playwright; needed for Twitch drop *claims* (the Client-Integrity token cannot be minted headless). |

Kick's Cloudflare WAF inspects the TLS/JA3 + HTTP-2 fingerprint, so a plain Node
request is rejected (HTTP 403). The `impersonate` transport sends a real Chrome
fingerprint via [cycletls](https://github.com/Danny-Dasilva/CycleTLS) and reaches
Kick's API and viewer socket without a browser. Twitch has no such WAF; the only
thing it needs a browser for is capturing the page-minted Client-Integrity token
required to *claim* drops.

## Auth

Credentials live in `<authDir>/` (`credentials.json`, plus a `browser-profile/`
for the browser transport). The login flows write the store; `auth status`
reports what is present.

```bash
pnpm cli login --import creds.json   # import an extension export ("-" = stdin)
pnpm cli login --twitch-device       # device-code OAuth, no browser (Twitch)
pnpm cli login                       # browser-assisted sign-in (Twitch + Kick)
pnpm cli login --twitch-only         # or --kick-only
pnpm cli auth status
```

The browser extension can export a credential blob for `login --import` via its
Settings → **Export credentials** button.

Env-var overrides (useful for Docker secrets) take precedence over the store:
`SA_TWITCH_AUTH_TOKEN`, `SA_TWITCH_DEVICE_ID`, `SA_TWITCH_CLIENT_ID`,
`SA_KICK_SESSION_TOKEN`.

## Commands

- `validate-config` — load + normalize the config; print the effective settings.
- `discover` — one discovery pass per enabled platform.
- `run` — full farming loop (discovery + watch heartbeats) until SIGINT/SIGTERM,
  persisting `state.json`. `--once` runs a single tick.
- `login [--import <f>|--twitch-device|--twitch-only|--kick-only]`
- `auth status`

## Docker

```bash
# build from the repo root
docker build -f packages/cli/Dockerfile -t lurkloot-cli .

# run the loop against a mounted data dir holding config.json (+ auth/)
docker run --rm -v "$PWD/data:/data" lurkloot-cli
# one-off discovery
docker run --rm -v "$PWD/data:/data" lurkloot-cli discover --config /data/config.json
```

Run `login` on your desktop first (the browser-assisted flow needs a display, or
use `login --twitch-device` / an extension export), then mount the resulting
`auth/` dir into the container. The Playwright-based image supports every
transport; for `http`/`impersonate` only, swap the base image for `node:22-slim`
to drop the ~1.5 GB browser layer.
