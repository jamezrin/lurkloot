# @lurkloot/cli

A headless command-line / Docker runtime for Lurkloot. It reuses the browser
extension's farming engine (`@lurkloot/core`) through clean port/adapter seams —
there is **no faking of `chrome`/`browser` globals**, and **no browser at all**:
both platforms farm over pure HTTP.

## Quick start

```bash
pnpm install
pnpm --filter @lurkloot/cli build          # bundles dist/index.mjs
node packages/cli/dist/index.mjs validate-config --config ./config.json
# or, from the repo root:
pnpm cli validate-config --config ./config.json
```

## Standalone executables

Each [GitHub release](https://github.com/jamezrin/lurkloot/releases/latest)
has the CLI as one archive per system, with no Node to install:

| System | Archive |
|---|---|
| Linux x64 | `lurkloot-cli-<version>-linux-x64.tar.gz` |
| Linux arm64 | `lurkloot-cli-<version>-linux-arm64.tar.gz` |
| macOS Apple Silicon | `lurkloot-cli-<version>-macos-arm64.tar.gz` |
| macOS Intel | `lurkloot-cli-<version>-macos-x64.tar.gz` |
| Windows x64 | `lurkloot-cli-<version>-windows-x64.zip` |

`SHA256SUMS` on the same release covers every archive, and each one has build
provenance (`gh attestation verify <archive> --repo jamezrin/lurkloot`).

An archive unpacks to one folder:

- `lurkloot` (`lurkloot.exe` on Windows): the CLI, built as a Node.js
  [single executable application](https://nodejs.org/api/single-executable-applications.html).
- `cycletls/`: the [cycletls](https://github.com/Danny-Dasilva/CycleTLS)
  package that carries Kick requests past Cloudflare. It holds the unmodified
  package (its JavaScript, `package.json` and GPL-3.0 `LICENSE`), its runtime
  dependencies in `node_modules/`, and its Go helper as `cycletls`
  (`cycletls.exe`). It is not compiled into `lurkloot`: the CLI loads it from
  this folder, as the Docker image loads it from `node_modules`. Keep the
  folder next to `lurkloot`. If it is missing, `run`, `serve` and `discover`
  with the default `impersonate` transport, and `auth kick device-login` with
  any transport, stop with an error naming the folder.
- `app/`: the app `lurkloot serve` serves at `/`.
- `LICENSE` and `NOTICE`. The NOTICE lists the third-party software in the
  archive, with its licenses.

First run, on Linux or macOS:

```bash
tar -xzf lurkloot-cli-<version>-linux-x64.tar.gz
cd lurkloot-cli-<version>-linux-x64
./lurkloot auth twitch browser-login   # creates config.json here on first use
./lurkloot serve                       # App and control plane at http://127.0.0.1:8420/
```

On Windows, unzip the archive and run `.\lurkloot.exe serve` from PowerShell
in that folder. Every command below works the same with `lurkloot` in place of
`node dist/index.mjs` or `pnpm cli`. Config, state and credentials go where
`--config` points (`config.json` in the current directory by default), not
beside the executable, so an upgrade is unpacking the new archive.

- **Path:** on Linux and macOS, keep the folder at a path without spaces or
  shell characters. cycletls is started through the shell there, and the CLI
  refuses such a path with an error rather than hang.
- **macOS:** the binaries are signed ad hoc, not notarized. A browser download
  is quarantined, so Gatekeeper blocks the first start; clear the flag with
  `xattr -dr com.apple.quarantine lurkloot-cli-<version>-macos-arm64`, or allow
  `lurkloot` and `cycletls/cycletls` under System Settings → Privacy & Security.
- **Windows:** the executables are not code-signed, so SmartScreen may warn on
  the first start (More info → Run anyway).
- **Linux:** built on the GitHub-hosted Ubuntu runners against the official
  Node.js binary, so they need glibc 2.28 or newer; there is no musl (Alpine)
  build. Use the Docker image there.

To build one for the machine you are on (the Node version running the build is
the one inside the executable; releases use Node 24):

```bash
pnpm install
pnpm --filter @lurkloot/cli build:executable   # dist/executable/lurkloot-cli-<version>-<target>/
node packages/cli/scripts/smokeExecutable.mjs packages/cli/dist/executable/lurkloot-cli-*
```

`--archive <dir>` after `build:executable` also writes the release archive.

## Config

The CLI creates the requested config file automatically when it does not exist.
The generated file is JSONC: it lists every supported default and includes
comments explaining the important choices. Existing `.json` and `.jsonc` files
both accept `//` / `/* */` comments and trailing commas.

The CLI has its **own** settings schema — it is *not* the extension's
`ExtensionSettings` verbatim. Only settings that do something in the headless,
tabless watch path are accepted; the schema is validated strictly, so an unknown
key (or an extension-only one copy-pasted from the browser config) is a **hard
error** that names the offender. `running` is gone — the CLI always runs. An
unversioned config that still has it loads: `running: false` switches off each
platform block the config lists, with a warning, and the key is dropped. The CLI
has no browser tabs, so it always watches tabless: `tablessMode` is derived, not
configured. A config that still sets it loads, with a warning that the key is
ignored. **Credentials never go in the config** — they live in the auth store.

Legacy `settings.enabledLogLevels` is accepted but ignored, with one actionable
warning per command; use the global `--log debug|info|warn|error` option instead.
`diagnosticLogging` is extension-only and is rejected because the CLI's `--log`
option is its sole event filter.

Supported `settings` keys: `autoClaim`, `priorityMode`,
`preferKnownChannels`, `offlineRetryLimit`, `pollIntervalMinutes`,
`notifyRewardEarned`, `notifyNoDropsLeft`, and per-platform
`enabled`, `watchSourcePriority`, `watchlistChannels`, `excludedChannels`, `categoryMode`, `rewardFilter`,
`campaignPins`, `excludedCampaignIds`, `unlinkedCampaigns`,
`categories`, `favouriteCategories`, `blockedCategories`, plus Twitch's
`autoClaimChannelPoints` and Kick's `autoClaimChallenges`.

Campaign order has three layers, and only the last one is automatic:
A platform's `campaignPins` lists its campaign ids to farm first, in that order; then campaigns
whose category is in that platform's `favouriteCategories`, in star order; then
everything else by `priorityMode` (`ending_soonest` or `lowest_availability`).
With a platform's `unlinkedCampaigns` set to `"last"`, its unlinked campaigns
that are neither pinned nor in a favourite category come after all of these,
in the same `priorityMode` order.
Which campaigns are farmed at all is eligibility, not order — a strategy is
always in effect. Each platform's `rewardFilter` is `{ "kinds": [...], "subscriptions": "..." }`.
`kinds` lists the reward kinds to farm: any of `item`, `badge` and `emote` on
Twitch, only `item` on Kick, combined as any-of; `[]` farms nothing (see below).
Optional `pinnedKinds` and `favouriteKinds` choose the kinds for pinned
campaigns and for campaigns of a `favouriteCategories` game instead; left out,
they follow `kinds`. A pinned campaign of a favourite game uses `pinnedKinds`.
In a config at `schemaVersion` 12 or later an empty list farms nothing from its
group, so farming only pins is empty `favouriteKinds` and `kinds`; this replaced
`farmPinnedOnly`, which still loads, with a warning. A config without a
`schemaVersion`, or an older one, keeps reading `[]` as every kind.
`subscriptions` is `include` (the default), `skip` to leave out rewards that
need a channel subscription, or `only` to farm just those. Only matching
rewards (and what they wait on) are farmed, and a campaign is left once those
are earned. A config still using the old `campaignPriorities` map,
`priorityMode: "priority_list_only"`, global `farmPinnedOnly`, `farmRewardTypes`
or `farmingEligibility` is migrated automatically, with a deprecation warning
naming each moved key.

`preferKnownChannels` defaults to `true`. For a general Drops campaign, the
CLI can pick a live Watchlist or followed channel outside the Twitch or Kick
directory results when the stream is in an allowed category and passes the
campaign's eligibility checks. Eligible Watchlist channels rank ahead of
followed channels, then other directory channels. Campaign allow lists and
`excludedChannels` still apply to Drops. Setting `preferKnownChannels` to
`false` skips the follow lookup and uses viewer count to rank campaign channels
within the same allow-list priority.

`watchSourcePriority` selects the first eligible watch source independently for
each platform. Twitch defaults to `["drops", "nopixel", "fortnite", "watchlist"]`;
Kick defaults to `["drops", "watchlist"]`. Reorder the array to prefer a
source, including while already watching. Unknown, duplicate and wrong-platform
entries are discarded; missing sources append in their default order. Idle
Watchlist keeps its own channel order. Excluded drop channels also apply to
supplemental providers; explicitly listed Watchlist channels remain allowed.

The deprecated `idleWatchlistFallbackOnly` field remains accepted for existing
configs. When a platform has no explicit priority and that field is `false`, it
migrates to Watchlist first. An explicit priority always wins, and the
generated config uses the per-platform arrays.

`categoryMode` is `"all"` (farm every category) or `"include"` (farm only the
categories in `categories`). Neither mode ranks: list order has no scheduling
effect. `blockedCategories` is never farmed in either mode, and
`favouriteCategories` ranks its campaigns above the strategy without filtering
anything. An unknown mode is rejected rather than defaulted. A config still
using the old `farmAllCategories` boolean is migrated automatically — `false`
becomes `"include"`, anything else becomes `"all"` — and a config using the
removed `"exclude"` mode becomes `"all"` plus `blockedCategories`, both with a
startup warning.

Twitch's campaign dashboard may return no campaigns to headless clients. In
that case the CLI scans up to four games from `categories` and
`favouriteCategories` (plus games already present in Inventory), with up to
eight live Drops-enabled channels per game. Add games you care about to
`categories` even when `categoryMode` is `"all"`. This discovers only campaigns
visible on those live channels; offline and unscanned campaigns remain unknown.
Inventory is still authoritative for started campaigns and reward progress.

Per platform, `unlinkedCampaigns` defaults to `"include"`: `"skip"` never
farms campaigns that need an account link, and `"last"` farms them only once no
linked campaign can be farmed. The old `farmUnlinkedCampaigns` boolean still
loads, with a warning: `true` becomes `"include"` and `false` becomes `"skip"`. Skipping subscription campaigns is
`rewardFilter.subscriptions: "skip"`. When every discovered campaign is
filtered out, the run logs a warning saying so.

Rejected (extension-only, no effect headlessly): `muteFarmingTabs`, `keepFarmingVideosUnmuted`, `pauseOnManualWatch`,
`adFocusMode`, `autoCloseFinishedDrops`, `autoStartDropFarming`,
`languageOverride`, `rateNudgeStatus`, `githubStarNudgeStatus`, `diagnosticLogging`.
The retired `dropsListFilter` is no longer rejected: it is migrated away for
every host, with a deprecation warning.

```jsonc
{
  "transport": "impersonate",   // default; use "http" for Twitch-only setups
  "authDir": "auth",            // resolved relative to this file
  "settings": {                 // CLI settings schema, merged over defaults
    "pollIntervalMinutes": 5,
    "platform": {
      "twitch": { "enabled": true },
      "kick":   { "enabled": true }
    }
  }
}
```

### Settings with limited CLI support

These settings can be shared with the extension. Their CLI support depends on
the platform, transport and sign-in. A per-platform setting that asks for an unavailable
feature and differs from its default logs one warning per run. If the signed-in
identity changes during a run, the warning can first appear when the new adapter
lacks the feature. Once logged, it stays quiet for the rest of that run.

| Setting | Why | Tracked in |
|---|---|---|
| `platform.twitch.channelPointsPushClaim` (with `autoClaimChannelPoints` on) | Web sign-ins support push; Android and Smart TV sign-ins claim points through the one-minute check | [#1101](https://github.com/jamezrin/lurkloot/issues/1101) |
| `platform.twitch.watchlistStreakChannels`, `watchStreakBudgetMinutes`, `watchStreakRetryCooldownMinutes`, `watchStreakMaxRounds` | Web sign-ins support streaks; Android and Smart TV sign-ins watch these as ordinary Watchlist channels | [#1101](https://github.com/jamezrin/lurkloot/issues/1101) |
| `platform.kick.alwaysEnterChat` on `http` | The HTTP transport cannot reach Kick realtime through the WAF | [#1099](https://github.com/jamezrin/lurkloot/issues/1099) |

The default config is quiet. `channelPointsPushClaim` is on by default, and
setting it to `false` disables push claiming, so either value stays quiet.
`tests/inertSettings.test.ts` checks these gaps per transport and Twitch sign-in.

## Twitch Extensions

NoPixelV and Fortnite are available in `run` and `serve` and disabled by default.
Enable a provider in the app's Twitch Extensions settings or in `config.json`:

```jsonc
"twitchExtensions": {
  "nopixel": { "enabled": true, "autoOpenPacks": false },
  "fortnite": { "enabled": true, "allowTakeovers": false }
}
```

Enabling a provider authorizes the CLI to contact its backend. NoPixelV joins
the selected channel's Twitch chat for watchtime credit. Enable `autoOpenPacks`
to open eligible packs when they arrive. Fortnite records confirmed sprite
captures. `allowTakeovers` opts in to eligible takeover actions. The CLI logs
confirmed rewards and saves completion and cooldown deadlines to
`twitch-extension-lane.json` beside `state.json`, keyed to the Twitch login.
A custom `--state` file gets its own companion file. Lane memory contains no credentials.

Both providers use the Client-ID of the sign-in on file, on either CLI
transport. Some providers require you to share your Twitch identity with
the extension on Twitch.

| Twitch sign-in | NoPixelV | Fortnite |
| --- | --- | --- |
| Imported web session (`auth import`) | Supported web-client path | Supported web-client path |
| Android (`auth twitch browser-login`) | Attempted with the Android Client-ID, subject to Twitch accepting the provider queries | Same |
| Smart TV (`auth twitch device-login`) | Attempted with the Smart TV Client-ID, subject to Twitch accepting the provider queries | Same |

Live CLI earning is unverified for each sign-in. If Twitch explicitly refuses
a provider query for a non-web sign-in, the CLI logs one warning for that
provider and leaves it idle until the credentials change. Other farming
continues. Provider refreshes use polling. Hermes broadcast integration is tracked in #1105.

## Transports

| Transport | Twitch | Kick | Notes |
|---|---|---|---|
| `http` | ✅ plain Node fetch | ❌ Cloudflare WAF (403) | Lightest; Twitch-only in practice. |
| `impersonate` | ✅ | ✅ **cycletls Chrome JA3/HTTP-2** | Recommended default. Reaches both with no browser. |

New Twitch device logins use the **SMARTBOX (Smart TV) client**. Previously
issued Android tokens retain their recorded client ID. Twitch may hide its
campaign dashboard from those clients, so CLI discovery can be partial as
described above. An imported web session from the updated extension uses the
web client identity and mints its own integrity token in Node; its protected
dashboard request was verified live. Twitch drop claiming with the CLI alone
still needs an account-level live test.

Kick's Cloudflare WAF inspects the TLS/JA3 + HTTP-2 fingerprint, so a plain Node
request is rejected (HTTP 403). The `impersonate` transport sends a real Chrome
fingerprint via [cycletls](https://github.com/Danny-Dasilva/CycleTLS) and reaches
Kick's API without a browser. The viewer socket uses Node's WebSocket client
with the same Kick session bearer.

On `impersonate`, set `platform.kick.alwaysEnterChat` to `true` to join the
channel's chat while watching. The CLI opens the chat socket only when needed,
and `serve` reports presence in `state.chatPresence.kick` in the snapshot.
Drop discovery signals use their own Pusher connection with the existing
handshake.

## Auth

Credentials live in `<authDir>/credentials.json`. The `auth` sub-commands write
the store; `auth status` reports what is present.

```bash
pnpm cli auth twitch browser-login   # Twitch sign-in in a browser, full campaign list
pnpm cli auth twitch device-login    # Twitch device-code OAuth, no browser
pnpm cli auth kick device-login      # Kick smart-TV link flow, no browser
pnpm cli auth import creds.json      # import an extension export ("-" = stdin)
pnpm cli auth kick logout            # forget stored credentials for a platform
pnpm cli auth status
```

- **`auth twitch browser-login`** is the recommended Twitch login. It prints a
  Twitch sign-in link. Open it in any browser and sign in; Twitch then sends you
  to `https://www.twitch.tv/#access_token=…`. Paste that whole address at the
  prompt, or pipe it in. The token is checked with Twitch and saved with its
  client ID; it is never logged. twitch.tv can remove the `#access_token` part
  from the address bar almost at once. If it does, open the browser's developer
  tools on the Network tab with **Preserve log** on before you sign in, filter
  for `access_token`, and copy the `location` header of the `id.twitch.tv`
  redirect. This token sees every drop campaign without a Client-Integrity
  token.
- **`auth twitch device-login`** runs Twitch's device-code OAuth against the
  Smart TV client: it prints an activation URL + code, you approve it on any
  device, and the token and its client ID are saved together. Twitch only lets
  this token see campaigns you have already started, so the CLI finds others by
  scanning live channels of your configured games, which misses campaigns on
  offline channels.
- **`auth kick device-login`** runs Kick's smart-TV link flow (the same one the
  Kick TV app uses): it prints a `kick.com/tv/login` URL + a 6-digit code; open
  it on your phone, where it opens in the Kick app you're signed in to, and
  confirm the code, and the session token is saved — no cookie export needed.
  The link does not open in a desktop browser (kick.com has no page for it).
- **`auth import`** ingests a credential blob exported by the updated extension
  (Settings → **Export credentials**) for Twitch and/or Kick. A Twitch web
  import needs the exported device ID and Kasada session cookie as well as the
  OAuth token. The extension reads that cookie from `k.twitchcdn.net`, so
  clicking **Export credentials** asks for that one extra site permission. If
  the popup closes when the browser asks, open it and export again. Decline
  the permission and the export carries only the login cookies. The CLI validates the web client identity, mints integrity
  without launching a browser, and persists cookie rotation in its private
  auth store. Older exports lacking these fields cannot import Twitch; export
  again from the updated extension or use `auth twitch browser-login`.

Env-var overrides (useful for Docker secrets) take precedence over the store:
`SA_TWITCH_AUTH_TOKEN`, `SA_TWITCH_DEVICE_ID`, `SA_TWITCH_CLIENT_ID`,
`SA_KICK_SESSION_TOKEN`. The rotating Kasada cookie is loaded only from the
private auth store, so a stale environment value cannot override a refresh.

### Twitch push (Hermes)

Twitch's web client gets live notices over one push connection, Hermes. With
a **web sign-in** (`auth import`), the CLI opens that connection too, as the
extension does. The socket presents Twitch's web `Origin`
(`https://www.twitch.tv`) and no other identity header: no User-Agent, Referer,
cookie or client hint. Over it the CLI:

- claims channel-point bonuses as Twitch announces them
  (`channelPointsPushClaim`), with the one-minute claim job as the fallback;
- sees watch-streak payouts, so `watchlistStreakChannels` rows are maintained
  the way the extension maintains them, tuned by `watchStreakBudgetMinutes`,
  `watchStreakRetryCooldownMinutes` and `watchStreakMaxRounds`;
- hears when the watched stream ends, checks it 60 s later and switches
  channel without waiting for the next discovery.

The **Android** (`auth twitch browser-login`) and **Smart TV**
(`auth twitch device-login`) sign-ins do not open Hermes. Hermes is the web
client's service, and whether it accepts a token issued to those clients has
not been checked live. These sign-ins keep polling instead: channel points are
claimed by the one-minute job, `channelPointsPushClaim` has no effect,
`watchlistStreakChannels` rows are watched as ordinary Watchlist rows, and an
ended stream is noticed at the next check. Defaults stay quiet. The CLI warns
once per changed setting that requests unsupported push functionality. Chat
presence (`alwaysEnterChat`) uses a separate connection for all three sign-ins.

If a web sign-in's push connection fails three times in a row, the CLI logs
one warning, pauses streak priority and accrual, and starts retrying at
five-minute intervals with backoff up to 30 minutes. Confirmation of the
channel-points subscription restores streak tracking. Updating the web login
while the CLI runs replaces the old connection on the next reconciliation.

`run --once`, SIGINT, SIGTERM, and `serve --exit-with-stdin` wait for the
Hermes socket to close. The socket is dropped if the peer takes more than
2 s to answer the close frame.

## Commands

- `validate-config` — load + normalize the config; print the effective settings.
- `discover` — one discovery pass per enabled platform.
- `run` — full farming loop (discovery + watch heartbeats) until SIGINT/SIGTERM,
  persisting `state.json`. `pnpm cli run --once` is the explicit refresh command:
  it discovers campaigns, refreshes authoritative progress, claims eligible
  rewards, persists state, and exits.
- `serve [--host 127.0.0.1] [--port 8420]` — the same farming loop as `run`,
  plus [the app](#the-app) and a local HTTP control plane (see
  [Control plane](#control-plane-serve)).
  It takes `--transport` and `--state` like `run`, but has no `--once`.
- `auth import <file>` — import an extension credential export ("-" = stdin).
- `auth twitch browser-login` — Twitch sign-in in a browser; paste back the address it ends on.
- `auth twitch device-login` — Twitch device-code OAuth (no browser).
- `auth kick device-login` — Kick smart-TV link flow (no browser).
- `auth <platform> logout` — forget the stored `twitch` / `kick` credentials (an
  `SA_*` env override, if set, still applies — it warns when that's the case).
- `auth status` — report which credentials are present.

The CLI is built on [yargs](https://yargs.js.org): every command and subcommand
has `--help`, unknown flags/subcommands are rejected, and `--config` / `--log`
are accepted everywhere. For shell autocomplete, source the generated script:

```bash
pnpm cli completion >> ~/.bashrc   # or ~/.zshrc, then restart your shell
```

## The app

`lurkloot serve` also serves the Lurkloot app: the extension popup's views in a
full window, plus an Accounts page that signs in to Twitch and Kick through the
same flows as `auth`. Start it and open the address it prints:

```bash
pnpm build:cli                # bundles the CLI and the app (dist/app)
pnpm cli serve                # App and control plane at http://127.0.0.1:8420/
```

The app talks to the [control plane](#control-plane-serve) on the same origin.
If `LURKLOOT_SERVE_TOKEN` is set, it asks for the token once and keeps it for
that browser tab only. Settings changed in the app are saved to `config.json`.

With Docker, [`compose.yaml`](compose.yaml) runs `serve` from the published image:

```bash
mkdir lurkloot && cd lurkloot
curl -fsSLO https://raw.githubusercontent.com/jamezrin/lurkloot/main/packages/cli/compose.yaml
echo "LURKLOOT_SERVE_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d          # http://127.0.0.1:8420
```

Sign in from the app's Accounts page, or with `docker compose run --rm lurkloot auth …`.
Config, state and credentials live in `./data`.

Inside the container `serve` binds `0.0.0.0`, which requires the token, and the
compose file publishes the port on this machine's loopback only
(`127.0.0.1:8420:8420`). Opening the app from another machine is remote access:
publish the port further only behind a reverse proxy that terminates HTTPS, so
the token never crosses the network in clear. The proxy must pass the original
`Host` header through: serve refuses a request whose `Origin` names another
host than its `Host`, so a proxy that rewrites `Host` to the upstream address
breaks every change the app makes. Caddy and Traefik pass it by default; nginx
needs `proxy_set_header Host $host;`. `run` stays the image's default command,
for farming with no app.

## Control plane (`serve`)

`lurkloot serve` farms exactly like `lurkloot run` (one shared loop) and also
answers a small HTTP API, so an app UI can operate the CLI. `run` never starts a
server. On SIGINT/SIGTERM the server closes first, then the loop shuts down as
`run` does.

| Endpoint | Answer |
| --- | --- |
| `GET /v1/health` | `{ "status": "ok" }`, for liveness checks. |
| `GET /v1/session` | `{ id, version, platforms }`. `id` is `"default"` (one process serves one account; the id exists so more can follow). Each platform has `enabled` and `auth`: the engine's last live `status` with its `reasonCode`/`checkedAt`, plus `credential: { present, source, status }`, the same network-free reading as `auth status`. Never a token, cookie or account id. |
| `POST /v1/session/messages` | Body: one `RuntimeMessage` (`@lurkloot/shared/messages`), the popup's own contract, with `Content-Type: application/json`. Answers `{ "result": … }`: the CLI host or controller result (a snapshot for most messages), or `null`. |

### Signing in over the control plane

The sign-in routes run the same flows as the `auth` commands and write the same
private auth store (`<authDir>/credentials.json`). They add no other way to get a
credential.

| Endpoint | Answer |
| --- | --- |
| `GET /v1/session/auth` | `{ platforms: { twitch, kick } }`. Each has `auth` (the same masked view as `GET /v1/session`) and `deviceLogin`, the platform's current or last device login, or `null`. |
| `GET /v1/session/auth/twitch/browser-login` | `{ platform, authorizeUrl, redirectUri }`: the link `auth twitch browser-login` prints. |
| `POST /v1/session/auth/twitch/browser-login` | Body `{ "address": "https://www.twitch.tv/#access_token=…" }`, the address Twitch ended on. The server reads the token, checks it with Twitch, then replaces the stored Twitch login with it. Answers `{ platform, environmentOverride, login? }` (the Twitch login name, never the account id). A pending Twitch device login is cancelled. |
| `POST /v1/session/auth/{twitch,kick}/device-login` | Starts the Twitch device-code flow or the Kick TV link, and cancels one already in flight for that platform. Answers `{ deviceLogin }` with `status: "pending"`, `verificationUrl`, `userCode` and `expiresAt`. |
| `GET /v1/session/auth/{twitch,kick}/device-login` | `{ deviceLogin }`. Poll it: `status` goes from `pending` to `approved`, `expired`, `failed` (with `error.message`) or `cancelled`. Only `approved` writes the store. |
| `DELETE /v1/session/auth/{twitch,kick}/device-login` | Cancels the flow; a late approval is dropped. Answers `{ deviceLogin }`. |
| `POST /v1/session/auth/{twitch,kick}/logout` | Forgets the platform's stored credentials, as `auth <platform> logout` does, and cancels its device login. Answers `{ platform, forgotten, environmentOverride }`. |

Every POST needs `Content-Type: application/json`; an empty body counts as
`{}`. `environmentOverride: true` means an `SA_*` variable still supplies the
platform's credential, so the engine keeps using that one. One device login
runs per platform. Closing `serve` stops the polling.

The running loop picks a change up without a restart: the transport reloads the
store before it builds each platform adapter. After a sign-in or logout, `serve`
also asks for a tick, so the auth probe reports the new state at once.

A failed, expired or cancelled sign-in leaves the stored credentials as they
were. Sign-in errors use these codes:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_redirect`, `invalid_request` | The address has no token, or Twitch refused the sign-in; or the body has no `address`. |
| 409 | `login_cancelled` | The device login was replaced or cancelled while it was starting. |
| 422 | `login_rejected` | Twitch rejected the token, or it was not issued to the sign-in link's client. |
| 502 | `upstream_unavailable` | Twitch or Kick could not be reached to start a flow or check a token. |

Supported messages: `getSnapshot`, `exportDiagnostics`, `tickNow`, `claimReward`,
`selectRewardLane`, `searchCategories`, `dismissCriticalFailure`, the settings
messages `saveSettings`, `updateIdleWatchlist`, `setPlatformEnabled`, `setAutomation`
and `setTwitchExtensionEnabled`, and the activity messages `getActivity`,
`getActivitySessions` and `clearActivity`. The provider toggle takes
`provider` (`nopixel` or `fortnite`) and a boolean `enabled`. Its result is
`{ enabled }`. Live updates come from polling `getSnapshot`, including provider
summaries in `state.twitchExtensions`.

The activity messages read the [activity history](#activity-history):

| Message | Answer |
| --- | --- |
| `{ "type": "getActivity", "category": "activity", "platform"?, "limit"?, "cursor"? }` | `{ events, nextCursor? }`, newest first, at most 100 per page (80 by default). Pass `nextCursor` back as `cursor` for the next page. `category: "diagnostic"` is accepted and always empty: the CLI keeps diagnostics in its log only. |
| `{ "type": "getActivitySessions", "platform": "twitch" }` | `{ sessions }`: the platform's farming sessions with their point tallies and reward counts, newest first. |
| `{ "type": "clearActivity" }` | `null`, once the history and its sessions are emptied. |

A settings message is applied by the running loop and saved to the config file
(`--config`, `config.json` by default) at once. Only the values that change are
rewritten, through a temporary file and a rename, so the file keeps its
comments, key order, `transport` and `authDir`. A change the CLI config cannot
hold is refused and nothing is written: an extension-only setting (such as
`muteFarmingTabs`), a value the CLI pins (`pauseOnManualWatch`,
`autoStartDropFarming`), or a value `validate-config` would reject or correct (a
wrong type, an out-of-range number, an unknown choice, a watchlist over the
limit). `run` never writes the config file. Change settings through the API
while `serve` runs, or edit the file while it is stopped: a hand edit is read
the next time the loop loads its settings, but nothing that follows a settings
change (switching a platform on or off, the poll interval) runs for it until a
restart.

Errors are JSON, `{ "error": { "code", "message" } }`. A refused settings change
also carries `paths`, the dotted settings paths it is about (for example
`"platform.twitch.watchlistChannels"`):

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_message` | Unparseable body, no string `type`, a missing/unknown `platform`, a settings message without its fields (`settingsPatch` object, boolean `enabled`, string `channel`), or a `getActivity` with no `category`, a wrong field type, or a `cursor` this server did not issue. |
| 400 | `settings_unrepresentable` | The change sets something the CLI config cannot hold, or changes a value the CLI pins. Nothing is written. |
| 400 | `settings_invalid` | The change has a value the CLI settings rules reject. Nothing is written. |
| 401 | `unauthorized` | A token is configured and the request lacks `Authorization: Bearer <token>`. |
| 403 | `forbidden_host`, `forbidden_origin` | See the security model below. |
| 404 / 405 | `not_found`, `method_not_allowed` | Unknown endpoint or method. |
| 409 | `settings_read_only` | A settings message to a host started without a settings store that saves (not `lurkloot serve`). |
| 413 | `payload_too_large` | Body over 64 KiB. |
| 415 | `unsupported_media_type` | A POST that is not `application/json`. |
| 422 | `unsupported_message` | A message type the CLI host does not support, including the extension-only ones (`getTabId`, `playbackTelemetry`, `getPlaybackControl`, `exportCliCredentials`, `resumeAfterManualClose`, `resetExtension`, `setTwitchExtensionEnabled`) and `exportDiagnostics`. |
| 500 | `internal_error` | The controller failed; the details go to the log only. |
| 500 | `settings_not_saved` | The edited config would not load back as the new settings; nothing was written. Details in the log. |
| 503 | `settings_unavailable` | The config file cannot be read or parsed (fix it, then retry); nothing was written. Details in the log. |

### Security model

- **Loopback by default.** `serve` binds `127.0.0.1`. Any other `--host`
  (`0.0.0.0`, a LAN address) refuses to start unless an access token is set in
  `LURKLOOT_SERVE_TOKEN` (at least 16 characters). The token is read from the
  environment only, never from a flag (it would show in `ps`) or the config
  file. For a remote Docker host, terminate HTTPS in front of it.
- **Bearer token.** With a token set, every request, loopback included, needs
  `Authorization: Bearer <token>`. It is compared in constant time.
- **DNS rebinding.** On a loopback bind, a request whose `Host` header is not
  `localhost`, `127.x.x.x` or `[::1]` is refused.
- **Cross-site requests.** There are no CORS headers, so a browser lets no other
  site read a response. A request with an `Origin` other than the server's own
  is refused, and a POST must be `application/json`, which a cross-site page
  cannot send without a CORS preflight.
- **No secrets out.** No response or log line carries a token, cookie or
  credential value; the session view is built from named safe fields only.
  The pasted Twitch address and a Twitch device code are never returned or
  logged, and the request log records the path without its query string. The
  Kick link and code go back to the caller, who must open them. They are never
  logged, because anyone holding both can collect the session once it is approved.
  `packages/cli/tests/serveAuth.test.ts` checks every sign-in response and log line
  for planted tokens.
- **The app's files are public, the API is not.** With the app bundled, every
  path outside `/v1` is a static file of the app, served with no token so the
  page can load and ask for it, but with the same Host check. The files are
  read from the bundle's directory only: dot segments, encoded separators and
  NUL are refused, and directories are never listed. The page is sent with a
  content-security policy that keeps it to its own origin, and it cannot be
  framed.
- **Sign-in needs the same access as everything else.** On a non-loopback bind
  only a holder of `LURKLOOT_SERVE_TOKEN` can start a sign-in or log out, and the
  token must travel over HTTPS.

```bash
# local
lurkloot serve
curl -s http://127.0.0.1:8420/v1/session
curl -s -H 'content-type: application/json' -d '{"type":"getSnapshot"}' \
  http://127.0.0.1:8420/v1/session/messages
# stop farming Kick; saved to config.json
curl -s -H 'content-type: application/json' \
  -d '{"type":"setPlatformEnabled","platform":"kick","enabled":false}' \
  http://127.0.0.1:8420/v1/session/messages

# reachable from other machines: a token is required
LURKLOOT_SERVE_TOKEN="$(openssl rand -hex 32)" lurkloot serve --host 0.0.0.0
```

### Running under a launcher

Two `serve` options exist for a parent process that starts `serve` as its child,
such as the desktop app. Both are off by default, and `run` has neither.

- **`--ready-json`** prints one line on stdout once the control plane listens:

  ```json
  {"event":"ready","url":"http://127.0.0.1:49152/"}
  ```

  `url` is the address that reaches the server from this machine. With
  `--port 0` it carries the port the OS picked; on a wildcard bind it names
  `127.0.0.1`. It never carries the token. The human log line is still written.
  Lurkloot's own logger writes to stderr, but other output can reach stdout: a
  transport's helper process (cycletls) shares it. Read stdout line by line
  and take the first line that parses as JSON with `"event":"ready"`; do not
  assume it is the first or only line. With `--exit-with-stdin`, `serve` skips
  the ready line if it observes EOF before announcing readiness. Pipe EOF can
  arrive after the ready line. A subsequent exit with code 0 is normal.
- **`--exit-with-stdin`** shuts down when stdin ends, closes or fails, the same
  way as SIGINT/SIGTERM. The server closes, any startup reconciliation and
  pending state writes finish, and the process exits with code 0. A launcher
  stops `serve` by closing the pipe, including on Windows. If the launcher
  crashes, the OS closes the pipe. `serve` reads and discards anything written
  to stdin. Give the launcher a pipe for this option. With stdin redirected
  from a file or the null device (such as `/dev/null` under `docker run` without
  `-i`), `serve` exits before binding or printing a ready line.

With either option, output is best effort: a launcher may stop reading stdout
and stderr before it closes stdin, and the lines `serve` then cannot write are
dropped instead of stopping it, so the shutdown still runs to the end.

To keep other programs on the machine out of the API, the launcher sets a fresh
`LURKLOOT_SERVE_TOKEN` for each launch. A token applies to a loopback bind too
(see [Security model](#security-model)).

```bash
LURKLOOT_SERVE_TOKEN="$(openssl rand -hex 32)" \
  lurkloot serve --port 0 --ready-json --exit-with-stdin
```

## Event logging

The farming engine reports typed activity and diagnostic batches directly to
the CLI. The CLI preserves their causal order, formats activity records into
human-readable lines, and passes diagnostic messages through unchanged. Lines
go to stderr and are filtered only by `--log`; `state.json` contains scheduler
state. Use Docker logs, systemd/journald, Loki, or another external collector
when long-term retention is needed. Loading and saving an old
state file also removes any legacy embedded `events` field.

### Activity history

`run` and `serve` also keep the activity the extension's Activity view shows
(claims, farming starts and stops, interruptions, obtained rewards and each
farming session's point and reward totals) in `activity.json`, beside
`state.json` in the data directory. A custom state filename gets a sidecar
with `.activity.json` appended to its full name. History keeps up to 2,000
events from the last 30 days and up to 200 session summaries per platform,
including open sessions and ones that ended in the last 30 days.
The app localizes the structured records. Activity snapshots omit diagnostic
messages, raw interruption details and credentials embedded in HTTPS links.
Publisher query parameters and anchors are preserved.

The CLI saves activity atomically and combines batches into at most one
scheduled write every 30 seconds. On shutdown it gives in-flight farming jobs
and background work up to five seconds to finish before flushing pending
activity. The app's Clear activity action saves the empty history before
returning success.

The CLI reads activity snapshots up to 4 MiB. If an activity file is unreadable
or exceeds the limit, it logs a warning and starts with an empty history.
If the file declares an unsupported version, the CLI leaves it on disk,
keeps new activity in memory for that run, and rejects requests to clear it.

Subscription requirements are reported separately from watch progress. The CLI
never tries to satisfy them by opening or farming a stream, and it reports
partial subscription progress as unavailable when Twitch does not provide an
authoritative count rather than inventing `0/N`. During the normal loop, a
waiting requirement is logged only when it first appears; once Twitch confirms
the reward, the next poll detects and claims it, with the existing reward-claimed
engine event providing the notification. Run `pnpm cli run --once` whenever an
immediate non-interactive refresh is needed.

## Diagnostics export

After reproducing a problem with `run` or `serve`, export from the same working
directory or pass absolute paths. Use the same `--config` and, if set,
`--state` as the farming process. The paths below are examples:

```sh
lurkloot diagnostics export --config /path/to/config.json --state /path/to/state.json --out diagnostics.log
# Save the Compose service's report on the host:
docker compose exec -T lurkloot node /app/dist/index.mjs diagnostics export --config /data/config.json > diagnostics.log
```

Append the matching `--state` path to the command before `>` if the container
uses a custom state file. For Docker without Compose, replace
`docker compose exec -T lurkloot` with `docker exec <container>`.

Attach the resulting text file under **Additional context** in your bug report.
Omit `--out` (or pass `--out -`) for stdout. A file specified with `--out` must be new.

The command works while farming or after shutdown. It reads the local config,
last saved scheduler state, and up to 500 recent engine diagnostics from the
saved sidecar. The report identifies its source and includes the sidecar's last
write time when available. The loop keeps diagnostics across restarts regardless
of `--log`. It writes a private atomic snapshot beside the state file
(`state.json.diagnostics.json` by default) at most once every five seconds
during farming. It publishes pending rows when the interval ends, even if
no new diagnostics arrive. Clean shutdown flushes any remaining rows.
Missing or unreadable history yields a report with no events. A disk write
failure leaves the in-memory history available to `serve` and is retried.
Run one farming process per state file.

The report includes Lurkloot and runtime versions, selected farming settings,
auth health codes, session status and recent English diagnostic lines for both
platforms. Credential values are used only to redact text. Raw settings,
account IDs, headers, credential fields and diagnostic metadata are excluded.

For a live, platform-scoped export, post
`{"type":"exportDiagnostics","platform":"twitch"}` (or `"kick"`) to
`/v1/session/messages` on `serve` using its usual authentication. The response's
`result.report` is the attachable text and `result.events` contains the redacted
diagnostic rows for that platform plus unscoped diagnostics.

## Docker

No browser means a slim Node image:

```bash
# build from the repo root
docker build -f packages/cli/Dockerfile -t lurkloot-cli .

# Or use the published image. The first command creates a documented config.json.
# Authenticate Twitch and/or Kick before starting the farming loop.
docker run --rm -it -v "$PWD/data:/data" \
  ghcr.io/jamezrin/lurkloot-cli:latest auth twitch browser-login
docker run --rm -it -v "$PWD/data:/data" \
  ghcr.io/jamezrin/lurkloot-cli:latest auth kick device-login

# Leave the farming loop running in the background.
docker run -d --name lurkloot --restart unless-stopped \
  -v "$PWD/data:/data" ghcr.io/jamezrin/lurkloot-cli:latest

# Or run serve with the app from compose.yaml: see "The app" above.

# The same flow with an image built locally:
docker run --rm -v "$PWD/data:/data" lurkloot-cli
# one-off discovery
docker run --rm -v "$PWD/data:/data" lurkloot-cli discover --config /data/config.json
```

Authenticate first — `auth twitch browser-login` (paste the address from any
browser) and `auth twitch device-login` / `auth kick device-login` all work
inside the container, or run them on any host and mount the resulting
`auth/` dir in. An updated extension export can also supply Twitch and Kick
credentials through `auth import`; Kick alone can use `SA_KICK_SESSION_TOKEN`.
