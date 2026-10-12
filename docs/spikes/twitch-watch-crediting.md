# Spike: what makes Twitch credit a watch (October 2026)

Tracking issues: [#744](https://github.com/jamezrin/lurkloot/issues/744) (tabless watching stopped
crediting; later, no channel points in tabless mode), [#792](https://github.com/jamezrin/lurkloot/issues/792)
(the extension's origin).

**Outcome so far:** drop progress is credited by HLS segment requests (#752, shipped in 1.16.0).
Passive channel points are credited by one event: the `minute-watched` the real page sends through
the GQL `sendSpadeEvents` mutation. No other event and none of the player's telemetry is needed.
The same event built outside the real page has not yet earned. Kept so that the dead ends are not
walked again.

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

## Reproductions that earned nothing

All of these ran from a bare `https://www.twitch.tv/robots.txt` page. It had the viewer's cookies
and Origin, and no Twitch page code. Each ran 7–8 minutes, and every request was accepted
(`204`, or GQL `statusCode: 204`):

- usher v2 with `play_session_id`, and segment `HEAD`s every 10 s. This is the extension's HLS
  heartbeat, plus the v2 session parameters.
- The above with segment `GET`s (full downloads), and with `probe?dna=` before each segment.
- Rufio `video-play` (with `user_id`), `n_second_play`, and `minute-watched` sharing the usher
  play session, with `device_id` from the playback token.
- `ChannelPage_SetSessionStatus` with `activity: WATCHING` every minute.
- GQL `SendEvents` with a minimal gzipped `minute-watched` that includes `user_id`/`login`/`game`.
- The same with the real page's `Client-Integrity`, `Client-Session-Id` and `Client-Version`
  headers.
- The page's own captured `video-play` and `minute-watched` (about 150 properties) replayed with
  channel, broadcast, play session and timestamps swapped, with `Client-Integrity`, alongside
  segment downloads and probes.

The extension build with HLS v2 and the rufio beacon (`video-play`, `device_id`, `play_session_id`,
`Origin` rewritten to `www.twitch.tv`) also earned nothing in four live runs of 8–18 minutes.

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

So no other event is needed, and the content of `minute-watched` is not why the reproductions
failed. The difference is how the event arrives: either the request (the sending page, its
headers, its own `Client-Integrity`), or the play session it refers to. The reproductions
referred to their own usher session; the real page's refers to the session of a playing player.

## Conclusions

- **Drops:** HLS segment requests credit progress (#752). This holds for a `HEAD`, from the
  extension, on the v1 usher path.
- **Points:** they need what the page sends through GQL `sendSpadeEvents`. The rufio beacon,
  `SetSessionStatus` and the Hermes and IRC sockets are irrelevant to them.
- **Content is not the issue:** the page's `minute-watched` alone, trimmed to 36 fields, earns.
  The same event built outside the page, even with copied `Client-Integrity` and the page's own
  values, does not. What still has to be found is the request context or the play session.
- **Rufio is not a Spade replacement for watch time.** The logged-in page sends Spade only through
  GQL. The rufio events are player telemetry.

## Open leads

1. **The request.** Forward the real page's own `minute-watched` body from another page, with
   the same and then with reduced headers. If that still earns, the sending page and its headers
   do not matter.
2. **The play session.** Swap the page's `play_session_id`/`video_session_id` for a session opened
   by a reproduction. If points stop, Twitch checks that the referenced session belongs to a
   player that is actually playing, and the next question is what marks a session as playing
   (usher parameters such as `acmb` and `player_version`, MSE playback, or the `probe` requests).
3. **`Client-Integrity` from the sending page.** Every replay used a token taken from a different
   page.

## Working notes

- Do not trust a `204` from rufio, Spade or `sendSpadeEvents`. All three accept events that credit
  nothing.
- The scripts used for this spike were throwaway and are not committed. Each new run is a fresh
  capture: the gzipped event batches hold the viewer's IDs and should not be stored in the
  repository.
