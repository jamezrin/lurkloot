# @stream-autopilot/cli

A headless command-line / Docker runtime for stream-autopilot. It reuses the
browser extension's farming engine (`@stream-autopilot/core`) through clean
port/adapter seams — there is **no faking of `chrome`/`browser` globals**; each
runtime injects its own implementations.

## Quick start

```bash
pnpm install
# from packages/cli:
pnpm cli validate-config --config ./config.json
pnpm cli login            # browser-assisted sign-in (or see Auth below)
pnpm cli discover --config ./config.json
pnpm cli run --config ./config.json
```

## Config

The config file reuses the extension's `ExtensionSettings` verbatim (validated
through the same `mergeSettings`), so the model and defaults match the extension.
Only `transport` and `authDir` are CLI-specific. **Credentials never go in the
config** — they live in the auth store.

```jsonc
{
  "transport": "impersonate",   // "http" | "impersonate" | "browser"
  "authDir": "auth",            // resolved relative to this file
  "settings": {                 // ExtensionSettings shape, merged over defaults
    "tablessMode": true,
    "pollIntervalMinutes": 5,
    "platform": {
      "twitch": { "enabled": true,  "farmAllCategories": true },
      "kick":   { "enabled": true,  "farmAllCategories": true }
    }
  }
}
```

## Transports

| Transport | Twitch | Kick | Notes |
|---|---|---|---|
| `http` | ✅ plain Node fetch | ❌ Cloudflare WAF (403) | Lightest; Twitch-only in practice. |
| `impersonate` | ✅ plain fetch | ✅ **cycletls Chrome JA3/HTTP-2 + viewer WebSocket** | Recommended default. Fixes Kick with no browser. |
| `browser` | ✅ + **integrity capture** (claims) | ✅ via cycletls | Playwright; needed for Twitch drop *claims* (Kasada integrity token can't be minted headless). |

Kick's Cloudflare WAF inspects the TLS/JA3 + HTTP-2 fingerprint, so a plain Node
request is rejected. The `impersonate` transport sends a real Chrome fingerprint
via [cycletls](https://github.com/Danny-Dasilva/CycleTLS) (the same approach as
`curl_cffi`-based Kick miners) and reaches Kick's API and viewer socket without a
browser. Twitch has no such WAF; the only thing it needs a browser for is
capturing the page-minted Client-Integrity token required to *claim* drops.

## Auth

Credentials are stored in `<authDir>/` (`credentials.json`,
`twitch-integrity.json`, and a `browser-profile/` for the browser transport).

```bash
pnpm cli login                       # browser-assisted: sign in to Twitch + Kick
pnpm cli login --twitch-only         # or --kick-only
pnpm cli login --twitch-device       # device-code OAuth, no browser (Twitch)
pnpm cli login --import creds.json   # import an extension export (- for stdin)
pnpm cli auth status
```

The browser extension can export a credential blob for `login --import` via its
Settings → **Export credentials** button.

Env-var overrides (useful for Docker secrets) take precedence over the store:
`SA_TWITCH_AUTH_TOKEN`, `SA_TWITCH_DEVICE_ID`, `SA_TWITCH_CLIENT_ID`,
`SA_KICK_SESSION_TOKEN`.

## Docker

```bash
# build from the repo root
docker build -f packages/cli/Dockerfile -t stream-autopilot-cli .

# run the loop with a mounted data dir holding config.json
docker run --rm -v "$PWD/data:/data" stream-autopilot-cli
```

Run `login` on your desktop first (it needs a display), then mount the resulting
`auth/` dir into the container. The Playwright-based image supports every
transport; for `http`/`impersonate` only, swap the base image for `node:22-slim`.

## Commands

- `validate-config` — load + normalize the config; print effective settings.
- `discover` — one discovery pass per enabled platform.
- `run` — full farming loop (discovery + watch heartbeats) until SIGINT/SIGTERM.
- `login [--twitch-only|--kick-only|--twitch-device|--import <f>]`
- `auth status`
