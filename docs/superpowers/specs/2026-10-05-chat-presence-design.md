# Chat presence for Twitch and Kick

This spec tracks #683 (milestone v1.15.1). It adds one subsystem that joins the chat of the channel being watched. The trigger is either a Twitch Extension provider that needs chat presence to credit rewards, or the user choosing "Always enter channel chat".

## Problem

NoPixel V Companion credits daily watch time only while the viewer is connected to the channel's chat. The evidence:

- In #683, the original report and a v1.15.0 diagnostics export from 2026-10-04 both show healthy tabless farming on connected channels, with successful heartbeats, while the counter never grows.
- On 2026-10-04 the maintainer ran an A/B test. During tabless farming, the counter started climbing as soon as `https://www.twitch.tv/popout/<channel>/chat` was opened. That page joins chat without loading the extension panel.
- The vendor client (1.1.2 and 1.1.3) has no presence heartbeat. It sends `/ping` once and polls progress only while the cards view is open. Its own copy says the streamer "needs to connect their Twitch account to the Extension for you to start earning card packs". Helix Get Chatters is the only Twitch API that lists who is in a channel, and the streamer's token can call it.

LurkLoot never connects to Twitch or Kick chat, so a tabless viewer never shows up in a chatter list. Its NoPixelV lane reports `farming` while it cannot earn.

## Goal

- Join the watched channel's chat whenever a watch source needs it or the user opted in. Follow the watch from channel to channel, and leave when the watch ends.
- When LurkLoot does join, behave exactly as the official web client does for that part of the client: the same protocol, the same sequence, and nothing the official client wouldn't send.
- Make a failed presence visible. In particular, a provider must not appear to be earning while its chat presence is down.

## Non-goals

- **Making automation harder to detect.** Video segments, extra Hermes topics, chat history and current-viewer requests, and any timing or behavior chosen only to look like a person are out of scope. They are ruled out by the "Functional only" decision and by the CLAUDE.md rule against bypassing platform detection.
- **Sending anything to chat:** messages, whispers, commands or reactions.
- **CLI support.** The engine code is browser-free, but only the extension host enables it in this version.

## Decisions

| Question | Decision |
| --- | --- |
| Scope of "organic" | Functional only: presence exists to make crediting work. Where LurkLoot acts, it matches the official client's protocol. |
| Platforms | Twitch and Kick, both in this version. |
| Consent | Provider-triggered presence is implied by enabling the provider, and the provider's setting description says so. "Always enter channel chat" is a separate per-platform setting, off by default. |
| Hosts | The engine lives in core. Only the extension enables it; the CLI declares the capability absent. |
| Providers | Each provider declares `needsChatPresence`: NoPixelV `true`, Fortnite `false` until a live A/B test shows otherwise. |
| Architecture | A per-platform observer in core, reconciled after tick commits like the channel-points push (approach A). |
| Quiet Twitch channels | After 20 s without IRC traffic, send an IRC `PING` so Chromium keeps the MV3 worker alive. |
| Kick providers | Advertise `pusher` and `centrifugo` as the web client does, and implement both. |

## What the official clients do

These are anonymous Playwright captures of live channel pages from 2026-10-04. Logged-in Twitch differs only in `PASS oauth:<token>` and `NICK <login>`. Third-party chat content from the captures is not recorded here.

**Twitch chat.** The page opens one `wss://irc-ws.chat.twitch.tv/` socket and sends:
1. `CAP REQ :twitch.tv/tags twitch.tv/commands` (no membership capability)
2. `PASS`
3. `NICK`
4. `USER <nick> 8 * :<nick>`
5. `JOIN #channel`

After that it only receives the channel's chat. It sent nothing else in 3 minutes. Navigating to another channel in the same page keeps the socket and sends `JOIN #next` and then `PART #prev`.

**Kick realtime.** The Pusher code in the kcik-tv-app reference is no longer what the web client uses. The page:
1. Calls `POST web.kick.com/api/v1/realtime/connection` with `{client:{id,type:"web"}, capabilities:{accepted_providers:[{provider:"pusher"},{provider:"centrifugo"}]}}`. The response is `{data:{connections:[{provider, credentials:{url}}], mode:"websocket"}}`, and the server chose `centrifugo`.
2. Calls `POST /api/v1/realtime/auth/connection` with `{client_id}` and receives a JWT. When anonymous, its `sub` was `guest:<uuid>`.
3. Calls `POST /api/v1/realtime/channels/<channelId>/chat/connection` with the same body shape as step 1.
4. Opens a Centrifugo socket (`realtime.us-west-2.platform.kick.com/connection/websocket`, server version 6.9.6 PRO) and sends `{"connect":{"token":…,"name":"js"},"id":1}`.
5. Subscribes `channel_<id>`, `channel.<id>`, `chatroom_<room>`, `chatrooms.<room>`, `drops_category_<cat>` and `chatrooms.<room>.v2`, each with `flag: 1`.

The server sends a ping every 25 s, and the client answers `{}`.

LurkLoot's Kick discovery signals subscribe to `drops_category_<cat>` over the legacy Pusher endpoint (`kick/discoverySignals.ts`).

## Architecture

### Contract

The status types are read by the popup, so they live in `@lurkloot/shared/models`:

```ts
export type ChatPresenceState = "left" | "joining" | "joined" | "error" | "blocked";
export type ChatPresenceBlockReason = "auth" | "origin-rejected" | "unsupported-provider" | "capability-absent";
export interface ChatPresenceStatus {
  state: ChatPresenceState;
  channel?: string;
  reason?: ChatPresenceBlockReason;
}
```

The client contract is engine-only and lives in `packages/core/src/core/chatPresence.ts`:

```ts
export interface ChatPresenceTarget {
  username: string;            // channel login or slug
  channelId?: string;          // platform channel id when known
}
export interface ChatPresenceClient extends SlotObserver {   // stop() + drainEvents()
  // Join `target`, switch to it, or leave when undefined. Resolves once the
  // command is issued, not when the join is confirmed; status() reports that.
  follow(target: ChatPresenceTarget | undefined): Promise<void>;
  status(): ChatPresenceStatus;
}
```

`PlatformAdapter` gains `createChatPresenceClient?(): ChatPresenceClient`, next to `createChannelPointsPushController`.

### Twitch client (`packages/core/src/platforms/twitch/chatPresence.ts`)

- **Connect** through the core WebSocket port to `wss://irc-ws.chat.twitch.tv/` and send the sequence above in order. The token is the in-memory `auth-token` the GQL transport already uses, and the login comes from a `CurrentUserLogin` GQL query, resolved once per client.
- **Joined:** presence counts as joined once both our own `JOIN` echo and `USERSTATE` for the channel arrive.
- **Switching:** `follow(next)` sends `JOIN #next`, then `PART #prev`. `follow(undefined)` sends `PART` and closes the socket.
- **Server messages:**
  - `PING :tmi.twitch.tv` gets `PONG :tmi.twitch.tv`.
  - `RECONNECT` or a close means reconnect with backoff: 1 s, doubling to 60 s, reset after 60 s of stable connection. Then rejoin the current target.
  - `NOTICE * :Login authentication failed` (or the improperly-formatted-auth variant) moves to `blocked: auth`. There is no retry until credentials change.
  - A room not confirmed 30 s after the socket opens or a `JOIN` is sent (a hung handshake, a suspended channel, a `JOIN` Twitch ignores) drops the connection and retries with backoff. A `NOTICE` for that channel received meanwhile is quoted in the warning.
  - Every other line is dropped after a prefix check. Chat content is never parsed into objects, stored, emitted or logged.
- **Idle keepalive:** after 20 s with no frame in either direction, send `PING :tmi.twitch.tv`. The server's `PONG` counts as traffic; an idle `PING` unanswered for 10 s means a half-open socket, which is dropped and retried with backoff. This is a documented deviation from the web client, for MV3 worker lifetime: pages are never suspended, service workers are.
- **Allowlist:** the client sends only `CAP REQ`, `PASS`, `NICK`, `USER`, `JOIN`, `PART`, `PING` and `PONG`.

### Kick realtime (`packages/core/src/platforms/kick/realtime.ts`)

A shared, provider-neutral connection owned by subscription owners.

- **Negotiation.**
  - `POST /api/v1/realtime/connection` with `client.type: "web"`, `accepted_providers: [pusher, centrifugo]`, and an in-memory UUID `client.id` for each connection.
  - Use the first returned connection whose `provider` is implemented, together with its `credentials.url`.
  - Any other provider, or none, moves to `blocked: unsupported-provider`.
- **Authentication:** `POST /api/v1/realtime/auth/connection` with `{client_id}`, through the existing Kick fetcher (session bearer, page-context rules). The JWT stays in memory.
- **Centrifugo transport.**
  - Send `{"connect":{"token":jwt,"name":"js"},"id":n}`.
  - Server pings (`{}`) get `{}`.
  - Track `ttl` from the connect reply. Before it lapses, fetch a new token and send `{"refresh":{"token":jwt},"id":n}`.
  - Subscribe with `{"subscribe":{"channel":name,"flag":1},"id":n}` and unsubscribe with `{"unsubscribe":{"channel":name},"id":n}`.
- **Pusher transport.**
  - Wait for `pusher:connection_established`, which carries the socket id.
  - Subscribe public channels with `{"event":"pusher:subscribe","data":{"auth":"","channel":name}}`.
  - Answer `pusher:ping` with `pusher:pong`, and ping the server when idle as `discoverySignals.ts` does today.
  - Its frame handling moves from `discoverySignals.ts` into this transport. Discovery signals keep their current socket until the follow-up that moves them onto this connection.
- **Owners** request channel names through `subscribe(name)` and `unsubscribe(name)` and never see provider frames. The connection keeps the union of owned subscriptions and replays it after a reconnect. Reconnection uses the same backoff as the Twitch client.

### Kick origin relay (`packages/extension/src/core/kickRealtimeRelay.ts`)

The step 1 spike (2026-10-09, recorded on #754) found that Kick's realtime server accepts only a kick.com origin or none. It refuses `chrome-extension://`, `moz-extension://` and `null` with 403. On Chromium 153, declarativeNetRequest never sees the extension's own WebSocket, so no header rule can change the origin. The maintainer chose to keep extension origins off Kick's sockets and accepted the `offscreen` permission for it.

- The extension creates an offscreen document (`kickRealtime.html`, reason `IFRAME_SCRIPTING`) that frames `https://kick.com/robots.txt`. This is plain text, so no Kick script runs there.
- The `kickRealtimeRelay` content script runs only in that frame, checked with `location.ancestorOrigins`. It opens sockets to Kick's realtime hosts only, and forwards their frames over one runtime Port. The handshake carries `Origin: https://kick.com`.
- The relay drops chat publications by prefix, unparsed: Centrifugo `push` lines, and non-`pusher` Pusher events. Busy chats therefore never wake the worker. Since #755 it forwards drop channels: Centrifugo pushes on `drops_*` channels, and Pusher's plain snake_case events such as `drops_campaign_started`.
- Since #755 the extension keeps one Kick realtime connection, shared by chat presence and discovery signals. On Chrome it goes through the relay and accepts Centrifugo and Pusher; on Firefox it uses plain sockets and accepts Pusher only. Each owner leaves only its own channels, and the connection closes once no owner is left.
- The worker accepts the Port only from that frame, never from a tab. It mints every token itself, through the Kick fetcher.
- When the worker's Port disconnects, the frame closes its sockets. A new worker replaces a document an earlier one left behind. The document closes after 10 s with no socket.
- Hosts without the relay (Firefox, which has no offscreen API, and the CLI) get no Kick chat presence. `alwaysEnterChat` on Kick warns once there.

### Kick chat presence (`packages/core/src/platforms/kick/chatPresence.ts`)

For each target:
1. Resolve `channelId` and the chatroom id from `kick.com/api/v2/channels/<slug>` through the Kick fetcher. The candidate's `channelId` is used when present.
2. Call `POST /api/v1/realtime/channels/<channelId>/chat/connection` with the negotiation body. If the response names a different provider or URL than the shared connection uses, reconnect the shared connection to it before subscribing.
3. Subscribe `channel_<id>`, `channel.<id>`, `chatroom_<room>`, `chatrooms.<room>` and `chatrooms.<room>.v2`.

On a switch it subscribes the new set and then unsubscribes the old one. `drops_category_<cat>` belongs to discovery signals. The client never calls any chat send endpoint.

### Service (`packages/core/src/background/chatPresence.ts`)

- One `ObserverSlot<ChatPresenceClient>` per platform, `failedStart: "discard"`, in the shape of `channelPoints.ts`.
- `transaction.onTickConcluded` reconciles each ticked platform against `tick.state`, using a new `tick.observerEpochs.chatPresence` read where the state is committed.
- Settings changes, manual-watch pauses and `reconcileStartup` also reconcile.
- A commit that leaves the platform's auth unhealthy stops the client before any await. That covers logout, a rejected or unavailable probe, and an account change being checked. This is the `transaction.onCommit` hook the channel-points push uses (#595), so an account change always ends the old viewer's presence, and the next healthy reconcile rejoins as the new identity. A manual pause also stops the client before any await.
- `reconcile` creates the client when it is wanted and absent, calls `follow(target)`, and stops the client when it is not wanted.

**The rule**, evaluated only against committed state:

```
wanted(p) = capabilities.chatPresence
         && settings.platform[p].enabled
         && state.authHealth[p].status === "healthy"
         && !state.manualClosePause?.[p] && !pausedForManualWatch(settings, state, p, now)
         && session.status === "watching"
         && session.watchMode === "tabless"
         && session.channel !== undefined
         && (settings.platform[p].alwaysEnterChat
             || (p === "twitch" && twitchExtensionProvider(session.supplementalWatch?.id)?.needsChatPresence === true))
target(p) = { username: session.channel.username, channelId: session.channel.channelId }
```

- **Tab watches never use presence.** The page already joins chat, so a second connection would duplicate it. A tabless watch that falls back to a tab stops presence the same way.
- **Presence never touches heartbeat health,** no-progress rotation or tab fallback.

### Host capability

- `HostCapabilities.chatPresence` is `true` in `EXTENSION_CAPABILITIES` and `false` in `CLI_CAPABILITIES`. No new port is needed: the clients use the adapters' existing WebSocket factory and fetchers.
- On a host without the capability, `alwaysEnterChat: true` produces the existing one-time "unsupported on this host" English diagnostic, and the service never starts.
- A NoPixelV watch on such a host cannot occur, because supplemental sources are extension-only.

### Settings (`@lurkloot/shared/settings`)

- `platform.twitch.alwaysEnterChat` and `platform.kick.alwaysEnterChat` are booleans, default `false`, normalized with `booleanOr`.
- No migration is needed, because missing means `false`.
- The CLI config accepts the key and warns as above.

### Provider declaration (`packages/core/src/extensions/types.ts`, `registry.ts`)

`TwitchExtensionProviderDescriptor.needsChatPresence: boolean`: NoPixelV `true`, Fortnite `false`.

### Popup (`@lurkloot/popup-ui`)

- **Settings.** Each platform section gets an **"Always enter channel chat"** toggle with the description: *"Join the chat of each channel being watched. Streamers and moderators can see you in the chat's viewer list. Messages are never sent."*
- **NoPixelV description.** It adds that earning watch time joins the watched channel's chat, which makes the user visible in its viewer list.
- **Watch card.** While presence is wanted, the platform's watch card shows "In chat", "Joining chat…", or "Chat unavailable" with a reason.
- **NoPixelV provider card.** It shows a `chat-presence` pending item: `done` when joined, `blocked` otherwise.
- **Localization.** All of these are new locale keys in every catalog. They are user copy, not diagnostics.

**Snapshot.**
- `SchedulerState` gains `chatPresence?: Partial<Record<Platform, ChatPresenceStatus>>`. It is attached to snapshots the way `twitchExtensions` summaries are, and is never persisted or restored.
- The popup derives the NoPixelV `chat-presence` item from `chatPresence.twitch` when the provider summary's channel matches. The Twitch Extensions host and the NoPixel driver stay unchanged.

## Error handling

- **`error`:** a socket close, 5xx, timeout, or failed negotiation or auth call that is not a 401/403. Retry with backoff. The status shows "Chat unavailable" until joined again.
- **`blocked`:** no retry until a credential change, a settings change or a restart.
  - `auth`: the Twitch auth NOTICE, or a Kick 401/403 on a realtime call.
  - `origin-rejected`: the Kick socket or negotiation refused the extension origin. This shows as a handshake failure with 403, or a close before connect.
  - `unsupported-provider`: no implemented provider in the negotiation response.
  - `capability-absent`: not reachable on the extension, but listed for completeness.
- **Stopping during start:** `stop()` during `joining` aborts negotiation and closes the socket. A start that completes after its slot epoch moved stops itself (ObserverSlot semantics).

## Diagnostics

All diagnostics are English literals from the platform clients and the service, and never include tokens, JWTs, socket ids, client ids or chat content.

- `debug`: `Twitch chat presence joined <channel>`, `Twitch chat presence switched <a> → <b>`, `Twitch chat presence left <channel>`, and the same for Kick.
- `warn` on entering `error` or `blocked`, with the reason. Each distinct warning is logged once until the client joins or leaves, so a retry loop does not repeat it.
- `info`, once per presence session started for a provider, logged once the service keeps a client for it: `Joining <channel>'s chat because <provider> needs chat presence to earn watch time`. Any stop ends the session, so the next one is announced again.
- `warn`, once per platform per controller, when `alwaysEnterChat` asks for presence on a platform with no client yet: `Chat presence is not available for <Platform>, so platform.<p>.alwaysEnterChat has no effect`.

## Security and privacy

- Credentials and vendor tokens stay in memory, inside the transport and client call, as for the existing GQL and Kick bearer transports. No stored credential is added.
- No new permission is needed:
  - The Kick HTTP calls (`web.kick.com`, `kick.com`) fall under the existing `https://*.kick.com/*` host permission.
  - WebSocket connections are not gated by host permissions. The existing Pusher, Hermes and Kick viewer sockets already rely on that.
  - The implementation must confirm this on both browser builds and document any manifest change in the PR.
- Presence is visible to streamers and moderators in chatter lists. The settings copy says so, and enabling NoPixelV is the consent for its own presence.
- Nothing is ever sent to chat. Tests enforce this with the send allowlists.

## Testing

Vitest, in `packages/extension/tests/`, with a fake WebSocket factory, fake fetcher and fake timers.

- **Twitch client (`twitchChatPresence.test.ts`):**
  - exact handshake order, and JOIN-then-PART switching
  - `PONG` replies
  - `RECONNECT` followed by a rejoin
  - auth NOTICE → `blocked: auth`, with no reconnect loop
  - idle `PING` after 20 s of silence, and none while frames flow
  - the send allowlist
  - the `PASS` line never appears in drained events
- **Kick realtime (`kickRealtime.test.ts`):**
  - negotiation body, and per-response provider choice
  - Centrifugo connect, subscribe, unsubscribe, pong and token refresh before `ttl`
  - Pusher `connection_established`, subscribe and ping/pong
  - subscriptions replayed after a reconnect
  - unsupported provider and origin rejection → `blocked`
- **Kick presence (`kickChatPresence.test.ts`):**
  - chatroom resolution, and the per-channel chat-connection call
  - the five subscriptions
  - switching subscribes the new set before unsubscribing the old
  - a provider change from the chat-connection response
- **Service (`chatPresenceService.test.ts`):**
  - a truth table for `wanted`: capability, enabled, auth health, manual pause, tab vs tabless, each trigger
  - the committed target is followed
  - the epoch race: a stop between reading state and starting
  - credential change and manual pause stop the client before any await
  - CLI capability absence plus `alwaysEnterChat` produces the one-time diagnostic
- **Settings:** normalization defaults.
- **Popup:** the toggle, the watch-card status line, and the NoPixelV `chat-presence` item.
- **Regression:** the existing `discoverySignals` and `coreBoundary` tests pass unchanged.

## Live acceptance (release gate)

1. NoPixelV's daily counter climbs during tabless farming with every Twitch tab closed. This is the A/B result from #683, now produced by LurkLoot itself.
2. The Kick origin probe passes for both providers from an extension-origin page.
3. On Chromium, a quiet Twitch channel keeps presence for 15 minutes with the channel-points push disabled.
4. Disabling the platform, logging out, starting a manual watch and restarting the worker each end presence promptly. Re-enabling, logging back in, ending the manual watch and the next tick after the restart each restore it.

## Implementation order

1. **Spike, throwaway.** Open the Kick negotiation, auth and both provider sockets from an extension-origin page; record only status codes, provider names and close codes. If the origin is rejected, stop and revise the Kick section to run the Kick client through the `pageContexts` port.
2. Contract, settings, capability and provider flag.
3. The Twitch client, the service and popup wiring. This alone fixes #683 for NoPixelV.
4. Kick realtime, with the Pusher transport moved out of `discoverySignals.ts`, then Kick presence.

## Risks

- **Kick origin policy:** handled by the spike in step 1.
- **Kick identity:** an anonymous capture cannot show whether a logged-in realtime token is user-bound, or which step Kick reads as presence. The client follows the full official sequence so it does not depend on that answer. A logged-in check that prints only the token's `sub` prefix can confirm it during the spike.
- **Chat volume:** very busy Twitch channels push many lines per second. The prefix-check discard keeps the cost to socket reads.
- **Worker lifetime on Kick:** the 25 s Centrifugo server ping sits close to Chrome's 30 s window. Live acceptance item 3 is repeated on Kick.

## Follow-ups (separate issues)

Kick chat presence itself, plan 2 above, is #754.

- Kick viewer-socket conformance. The web client sends the tracking event every 120 s with `vod_id`, the handshake every 15 s and the ping every 30 s. LurkLoot sends the tracking event every 60 s without `vod_id`, and alternates handshake and ping every 13 s (#756).
- Move Kick discovery signals onto `kick/realtime.ts` as a subscription owner, and off the legacy Pusher endpoint (#755).
- NoPixelV giveaway start and end over the extension's Hermes broadcast topic, replacing per-minute `/channel/giveaway` polling (#757).
- Kick drop progress from `drops_category_<cat>` pushes (#758; a public category channel can't carry one viewer's progress, so it starts as an investigation).
- Twitch live and offline from the `video-playback-by-id` Hermes topic (#759).
- Enable chat presence on the CLI host, including a check of the chat scope on device-login tokens (#760).
- Re-test Fortnite with a chat-presence A/B, and flip `needsChatPresence` if its rewards depend on chat (#761).
