# Spike: what makes Twitch credit a watch (October 2026)

Tracking issues: [#744](https://github.com/jamezrin/lurkloot/issues/744) (tabless watching stopped
crediting; later, no channel points in tabless mode), [#792](https://github.com/jamezrin/lurkloot/issues/792)
(the extension's origin).

**Outcome: solved.** Two separate things are credited:

- **Drop progress:** HLS segment requests (#752, shipped in 1.16.0).
- **Passive channel points:** one GQL `sendSpadeEvents` mutation per minute carrying a `minute-watched`
  event. The input must be `{data, repository: "twilight", encoding: "GZIP_B64"}`, and the event
  must include `player: "site"`.

That is all points need: no player, no segment requests, no `video-play`, no `Client-Integrity`, no
rufio beacon, and no presence status. A self-built event from a bare page earns +10 every 5
minutes. LurkLoot's `gql-v1` heartbeat already sends the right input but omits `player`, and that
single field is why it never earned points.

## How it was measured

- **Ground truth for points.** The viewer's balance on the watched channel, read through GQL
  every 30 s:
  `user(login:) { channel { self { communityPoints { balance } } } }`. A real, muted watch earns
  `+10` about 4–5 minutes in.
- **Push confirmation.** Hermes `community-points-user-v1.<user id>` delivers
  `points-earned` with `point_gain.reason_code: "WATCH"` when a watch earns. The extension's debug
  log names every channel-points push it ignores, with type, reason, points and channel, so a test
  run shows this directly.
- **Browser.** The DevTools MCP browser runs with automation flags, and Twitch refuses to log in
  there ("Your browser is not currently supported"). Instead, a normal Chrome was started by hand
  with a throwaway profile and `--remote-debugging-port`, the maintainer logged in themselves, and
  Playwright attached through `connectOverCDP`:
  - `navigator.webdriver` is `false` there, and nothing was spoofed.
  - The scripts read request bodies and received socket frames.
  - They never recorded request headers or anything the browser sent on a socket, so no tokens.
- **Subtractive runs.** `context.route` blocks or rewrites requests on the real player page,
  including the player's worker. `context.routeWebSocket` keeps Hermes and IRC from reaching
  Twitch. Each run lasted 6.5–8 minutes on a channel nothing else was watching.

## What the web player sends (logged in, 2026-10-12)

- **usher.** `GET usher.ttvnw.net/api/v2/channel/hls/<login>.m3u8`:
  - Parameters: `acmb` (base64 JSON with `AppVersion`, `ClientApp: "twilight"`, `URL`),
    `play_session_id` (32 hex), `p`, `platform=web`, `player_backend=mediaplayer`,
    `player_version`, `browser_*`, `os_*`, `cdm`, `enable_score`, `fast_bread`,
    `include_unavailable`, `lang`, `playlist_include_framerate`, `reassignments_supported`,
    `supported_codecs`, `transcode_mode`, `sig`, `token`.
  - Only the **v2** path returns `#EXT-X-SESSION-DATA`: `VIDEO-SESSION-ID`, `SERVING-ID`,
    `BROADCAST-ID`, cluster and node fields, and `C`/`E`.
  - `C` and `E` are the base64 of the rufio beacon URL. That URL is identical for every viewer
    and channel.
  - The v1 path (`/api/channel/hls/`) returns the same variants with no session data.
- **Playback token.** The `PlaybackAccessToken` value is JSON carrying `user_id` and
  `device_id`, provided the request sends `Authorization: OAuth`.
- **Segments.** The media playlist's segment URLs carry `?dna=`. Before each segment the player
  sends `GET <cdn host>/probe?dna=<same value>`. Blocking `probe` stalls playback.
- **Rufio** (`<x>.rufio.hls.live-video.net/v1/segment/<opaque>.ts`, from the worker):
  - Form-encoded `data=<base64 JSON>`, one object per POST, always answered `204`.
  - Events: `video-play` (once), `n_second_play` (`seconds_after_play: 5`, `player: "web"`),
    `minute-watched` every minute, `abs_stream_format_change` and `ivs_*`.
  - Only `video-play` carries `user_id`.
  - Rufio accepts any `Origin`, including foreign ones.
- **`player.stats.live-video.net`:** `video_init` and `master_manifest_ready`.
- **`spade.twitch.tv/track`:** page events only. Logged in, it got none at all.
- **GQL `mutation SendEvents($input: SendSpadeEventsInput!) { sendSpadeEvents(input: $input) { statusCode } }`:**
  - Batches of Spade events, sent as `data` = base64 of gzip, every few seconds, with the
    page's `Client-Integrity`.
  - The batches include `pageview`, `video-play`, `minute-watched` (about 157 properties,
    including `user_id`, `login`, `logged_in: true`, `game`, `game_id`, `channel`,
    `location: "channel"`, the same `play_session_id`/`video_session_id`, and
    `page_session_id`/`tab_session_id`/`app_session_id`), `player_state_update`,
    `play_session_tags`, `n_second_play`, and many UI events.
- **`ChannelPage_SetSessionStatus`:**
  - Sent with `{availability: "ONLINE", activity: null}`.
  - Once playback runs, sent again with
    `activity: {type: "WATCHING", userID: <channel id>}`. The response includes
    `setAgainInSeconds` (about 400).
- **Sockets:** Hermes (`hermes.twitch.tv/v1`) and IRC (`irc-ws.chat.twitch.tv`).

## Subtractive runs on the real page

| Removed from a real watch | Points |
|---|---|
| Nothing | Earned (+10 about 4–5 min in) |
| Rufio, `player.stats`, `spade.twitch.tv` | **Earned** |
| …plus `SetSessionStatus`, and Hermes and IRC sockets kept from Twitch | **Earned** |
| All GQL after the first 40 s | **None** |
| Only GQL `SendEvents` after the first 40 s | **None** |
| Video segments and `probe` (player never plays) | None |

So rufio, the presence status and both sockets are not needed. The page's GQL `SendEvents` is.
Without playback the page presumably stops sending `minute-watched`.

## Reproductions that earned nothing, and why

All of these ran from a bare `https://www.twitch.tv/robots.txt` page, with the viewer's cookies and
Origin and no Twitch page code. Each ran 7–8 minutes, and every request was accepted (`204`, or GQL
`statusCode: 204`):

- Segment `HEAD`s, `GET`s, and `probe?dna=` requests.
- Rufio `video-play`, `n_second_play` and `minute-watched`, with `device_id` and `play_session_id`.
- `ChannelPage_SetSessionStatus` with `activity: WATCHING`.
- GQL `minute-watched`: minimal, with copied `Client-Integrity`, and as the page's own captured
  event replayed.

The rufio and segment variants can never earn: points do not come from them. Every GQL variant
failed for one reason. Its `input` carried only `data`, without `repository: "twilight"` and
`encoding: "GZIP_B64"`, so Twitch accepted the gzipped payload with `204` and discarded it. The
extension build with HLS v2 and the rufio beacon earned nothing for the same first reason.

## Event-level bisection on the real page

Method: the real page keeps everything except what its `SendEvents` batches carry. Each batch is
gunzipped, filtered, re-gzipped and sent on.

| `SendEvents` content | Points |
|---|---|
| Only `minute-watched`, with `pageview`, `video-play` and about 175 other events dropped | **Earned** (+10 at about 4.5 min) |
| Only `minute-watched`, trimmed from 157 to the 36 fields the reproductions sent | **Earned** (+10 at about 4 min) |

The 36 fields: `broadcast_id`, `channel_id`, `device_id`, `domain`, `hidden`, `host`, `live`,
`muted`, `platform`, `play_session_id`, `protocol`, `quality`, `serving_id`, `stream_type`, `url`,
`video_session_id`, `backend`, `core_version`, `browser_family`, `os_name`, `client_app`,
`client_time`, `content_mode`, `time`, `channel`, `game`, `game_id`, `location`, `logged_in`,
`login`, `minutes_logged`, `player`, `player_state`, `playback_rate`, `user_id`, `is_live`.

So no other event is needed, and 36 fields of `minute-watched` are enough. (The reproductions'
36-field events failed for a different reason, the missing input fields described above.)

## Forwarding and replay tests

These keep a real page playing, intercept its `minute-watched` and send it from the bare page.

| Test | Points |
|---|---|
| The page's own event, sent from the bare page with its headers | **Earned** |
| …with `play_session_id`/`video_session_id`/`serving_id` replaced by random values | **Earned** (sessions are not checked) |
| …retargeted to a different live channel B that nothing plays | **Earned on B** (playback of the channel is not checked) |
| …with only `Authorization`, `Client-Id`, `X-Device-Id` | **Earned** (`Client-Integrity` and `Content-Type` not needed) |
| …with every player statistic frozen at the first minute's values | **Earned** |
| A captured event replayed by a self-built request with `input: {data}` only, in any combination of counter, `batch_time` and a player running elsewhere | None |

The page's request object turned out to be
`{query: "mutation SendEvents…", variables: {input: {data, repository: "twilight", encoding: "GZIP_B64"}}}`.
Adding the two missing fields fixed the self-built request.

## Self-built requests with the right input

From the bare page, with no player, no `Client-Integrity`, and one GQL request per minute:

| Event sent | Points |
|---|---|
| 36 fields (the list above), plus `video-play` at the start and segment `HEAD`s | **Earned** (+10, then +10 five minutes later) |
| The same, with no segment requests | **Earned** |
| The same, with `minutes_logged` fixed at 1 | **Earned** |
| The same, with no `video-play` (only `minute-watched`) | **Earned** |
| LurkLoot `gql-v1`'s 13-field event, unchanged | None (on two channels, 7 minutes each) |
| `gql-v1` event + `player`, `location`, `login`, `device_id`, `time`, `platform`, `client_app` | **Earned** |
| `gql-v1` event + `player`, `location`, `login` | **Earned** |
| `gql-v1` event + `player: "site"` | **Earned** |
| `gql-v1` event, unchanged, on the same channel straight after | None |

`gql-v1`'s fields: `broadcast_id`, `channel_id`, `channel`, `client_time`, `game`, `game_id`,
`hidden`, `is_live`, `live`, `logged_in`, `minutes_logged`, `muted`, `user_id`.

## Conclusions

- **Drops:** HLS segment requests credit progress (#752). A `minute-watched` alone does not.
- **Points:** a GQL `sendSpadeEvents` `minute-watched` once a minute. It needs
  `input.repository: "twilight"`, `input.encoding: "GZIP_B64"` with gzipped base64 `data`, and
  `player: "site"` in the event, besides `user_id`, `channel_id`, `broadcast_id`, `channel`,
  `game`/`game_id` and `logged_in`. Not needed: segments, rufio, `video-play`, `Client-Integrity`,
  session IDs, `SetSessionStatus`, and Hermes or IRC.
- **Rufio is player telemetry, not a Spade replacement.** The logged-in page sends Spade only
  through GQL. HLS heartbeat v2 (the rufio branch) earns nothing extra.
- **For tabless farming of both drops and points,** keep the HLS heartbeat and send this
  `minute-watched` once a minute through GQL. `gql-v1`'s `buildMinuteWatchedEvent` plus
  `player: "site"` is enough.
- **Not yet verified:** the same request sent from the extension's service worker. The run that
  earned came from a twitch.tv page. The extension's existing GQL transport adds `Origin`
  (rewritten by DNR on the Origin branch, otherwise `chrome-extension://`) and its own headers.

## Working notes

- Do not trust a `204` from rufio, Spade or `sendSpadeEvents`. All three accept events that credit
  nothing. GQL `sendSpadeEvents` returns `statusCode: 204` even when it cannot decode `data`.
- Check that a test channel is live and has `communityPointsSettings.isEnabled` before reading a
  zero as a result. Several runs had to be thrown out because their channel went offline.
- Points accrue in 5-minute steps per channel, so a channel with recent valid minutes can earn
  sooner. A failing run never earns, so "earned within about 7 minutes" versus "nothing" is the
  signal.
- The scripts used for this spike were throwaway and are not committed. Each new run is a fresh
  capture: the gzipped event batches hold the viewer's IDs and should not be stored in the
  repository.
