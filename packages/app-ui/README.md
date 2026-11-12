# @lurkloot/app-ui

The full-window app UI for `lurkloot serve`: the extension popup's own views
(Queue, Completed, Games, Watchlist, Activity, Settings) in a window-sized
frame, plus an Accounts view for signing in, all over the CLI's HTTP control
plane. A header across the window holds the Twitch/Kick switch, an account chip
for the platform shown (its menu opens Accounts), what is being farmed and the
farming switch. The sidebar collapses to icons and remembers the choice. In a
window at least 1280px wide, Queue, Games and Completed are cards on one Drops
page, side by side when there is room; a narrower window keeps the popup's
separate views. It is a static bundle; nothing in it farms.

## What it talks to

Every request goes to the same origin, under `/v1`
([control plane reference](../cli/README.md#control-plane-serve)):

- `POST /v1/session/messages`: the popup's `RuntimeMessage`s. The snapshot is
  polled every five seconds, as the popup does. Start and stop farming is the
  status strip's switch (`setAutomation`). Settings changes are saved to the
  CLI's `config.json`.
- `/v1/session/auth/...`: Twitch browser sign-in (recommended), Twitch device
  code, Kick TV link (a QR code to scan in the Kick phone app), sign-out.

Only what the CLI supports is shown: no tab settings, no Twitch Extension
providers, no credential export, none of the extension's own preferences. The
CLI keeps no activity history (it logs instead), so Activity shows the last
check and each platform's status.

What stays in the browser:

- the language and the selected platform, in `localStorage` (the CLI config
  cannot hold a language);
- the access token, in `sessionStorage`, only when serve asks for one.

The app never stores or shows a Twitch or Kick token. The pasted Twitch
address is cleared from the input as soon as it is sent.

## Running it in development

Start a serve, then the app with a dev proxy in front of it. Serve keeps
running, so start the app in a second terminal:

```bash
# terminal 1
pnpm build:cli
pnpm cli serve                # http://127.0.0.1:8420
```

```bash
# terminal 2
pnpm dev:app                  # http://127.0.0.1:5173
```

Open http://127.0.0.1:5173. Vite forwards `/v1` to serve unchanged, so the
page and the API share an origin and serve's Host and Origin checks pass.
Point it at another serve with `LURKLOOT_SERVE_URL`:

```bash
LURKLOOT_SERVE_URL=http://127.0.0.1:8431 pnpm dev:app
```

If serve was started with `LURKLOOT_SERVE_TOKEN`, the app asks for the token
on its first request and keeps it for the tab.

To work on the UI without a CLI, Twitch or Kick:

```bash
pnpm dev:app:fixture
```

That answers `/v1` from `fixture/controlPlane.ts`: the popup's demo campaigns
and a simulated sign-in that stores nothing. Set `LURKLOOT_FIXTURE_TOKEN` to
make the fixture require a bearer token too.

## Building

```bash
pnpm build:app                # packages/app-ui/dist
```

The bundle uses relative asset paths. `pnpm build:cli` builds it and copies it
to `packages/cli/dist/app`, where `lurkloot serve` serves it at `/` (see the
[CLI README](../cli/README.md#the-app)). The Docker image ships it the same way.

## Tests

```bash
pnpm --filter @lurkloot/app-ui test
```

The tests run the adapter, the token prompt, polling, the Accounts flows and
the capability gating against the fixture control plane.
