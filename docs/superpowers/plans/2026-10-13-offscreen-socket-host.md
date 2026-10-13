# Offscreen Socket Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every platform WebSocket the extension opens presents the platform's own site `Origin` (`https://www.twitch.tv`, `https://kick.com`) instead of `chrome-extension://` or `moz-extension://`. On Chrome, a single offscreen document becomes the extension's socket host and replaces the kick.com relay frame (#754, #771). Firefox rewrites the same handshakes with blocking `webRequest`. Tracked in #792.

**Architecture:** Core keeps its `WebSocketFactory` contract unchanged. On Chrome, the extension passes core a factory whose sockets live in the offscreen document. The worker talks to that document over a single multiplexed runtime port. The document decides each socket's profile (allowed URL, frame filter) from its URL. A dynamic declarativeNetRequest rule that matches only `websocket` requests sets the `Origin`. Firefox has no offscreen API, but its background is an event page whose sockets blocking `webRequest` can rewrite, so there it keeps plain sockets plus a header listener.

**Tech Stack:** TypeScript, WXT, Chrome offscreen + declarativeNetRequest, Firefox webRequest (blocking), Vitest.

**Branch:** `feat/offscreen-socket-host`, stacked on `feat/platform-request-origin` (#797). Retarget to `develop` once #797 merges.

## Measured facts this plan rests on (2026-10-13)

Measured with probe extensions against a local ws/wss server that logs the handshake `Origin`, in Chromium 153 and 154 and Firefox 157. Full table in #792.

| Context | DNR `modifyHeaders` on the socket | Blocking webRequest |
|---|---|---|
| Chrome service worker | never applied (even static rules; `testMatchOutcome` lies) | n/a in MV3 |
| Chrome offscreen document | applied | n/a |
| Chrome dedicated `Worker` inside the offscreen document | applied | n/a |
| Chrome extension page | applied | n/a |
| Firefox background event page | not applied | applied |

- Both browsers need a `wss://` host permission for the socket host. An `https://` grant alone does nothing: in Chrome the rule doesn't fire, and Firefox's listener never sees the request.
- A WebSocket handshake is a GET. The HTTP rules in #797 exclude GET/HEAD, so sockets need their own rule.
- Worker lifetime: with an idle port, Chrome kills the worker every 30 s and the port disconnects. The offscreen document and its sockets survive. A port message every 20 s keeps the worker alive.
- Kick's Centrifugo server returns 403 to any non-kick.com `Origin`. That makes it a free live check: if it connects without the frame, the rewrite works.

## Global constraints

- Fail closed. A platform socket never opens with the extension `Origin`. If the rule or permission is missing, the socket does not open; a diagnostic says why and the caller's existing reconnect/backoff applies.
- The offscreen document opens sockets only to an allowlisted, bundled set of URLs. It reads no cookies or credentials and never sends chat. The worker still mints every token.
- Rewrite only `Origin`, only on sockets the extension initiates, and only to the platforms' domains.
- `packages/core` stays browser-free. The CLI is untouched.
- Diagnostics are English literals.

## Decisions (recommended defaults; confirm with the maintainer)

1. **Pusher.** Kick's fallback provider lives on `ws-*.pusher.com`, a host we don't hold. Adding it would be a privilege increase. **Recommended:** stop accepting Pusher; Centrifugo becomes reachable on both browsers. Alternative: keep Pusher and add `wss://*.pusher.com/*`, which re-prompts every user.
2. **Firefox in the same PR.** **Recommended:** yes. It's one top-level listener, and Firefox gains Kick realtime presence for the first time. It needs `webRequestBlocking`.
3. **Fortnite socket** (`exmggames.com`, optional third-party host, real-site `Origin` is the extension frame's `*.ext-twitch.tv`). **Recommended:** phase 2. The host's profile table is built so it can be added later.
4. **Offscreen reason.** **Recommended:** `WORKERS`, with the sockets running in a dedicated Worker spawned by the document. That makes the reason literally true; Chrome Web Store review has rejected us before. The document itself only relays.

## Architecture

```
core (unchanged)                 extension worker                         offscreen document (Chrome)
TwitchChannelPointsPush ─┐       createSocketHostFactory(): WebSocketFactory   socketHost.html
TwitchChatPresence ──────┤──url──▶  RemoteSocket ── port "socket-host" ──▶     └ socketHost worker (Worker)
KickRealtimeConnection ──┤       ◀── open/message/close events ──               new WebSocket(url)
KickWatch viewer socket ─┘                                                     profile(url): allow + filter
                                  platformRequestOrigin: HTTP rules (#797) + socket rule ─▶ Origin set on handshake
```

### Socket profiles (`packages/extension/src/core/socketProfiles.ts`)

Each profile has a URL pattern, an `Origin` (documentation only; DNR sets it), and a frame filter. Only these URLs may be opened:

| Profile | URL | Origin | Frame filter |
|---|---|---|---|
| `twitch-hermes` | `wss://hermes.twitch.tv/v1?clientId=…` | `https://www.twitch.tv` | none |
| `twitch-irc` | `wss://irc-ws.chat.twitch.tv/` | `https://www.twitch.tv` | Split on `\r\n` and keep only `PING`, `PONG`, `001`, `JOIN`, `USERSTATE`, `366`, `NOTICE`, `RECONNECT`. Drops `PRIVMSG`, `USERNOTICE`, `CLEARCHAT` and the rest, so a busy chat never wakes the worker. |
| `kick-realtime` | `wss://realtime.<region>.platform.kick.com/connection/websocket` | `https://kick.com` | existing `relayForwardedData` Centrifugo rule (drops chat pushes, keeps `drops_*`) |
| `kick-viewer` | `wss://websockets.kick.com/viewer/v1/connect?token=…` | `https://kick.com` | none |

Unknown URL → immediate `close` with code 1006 and a diagnostic.

### Port protocol (replaces `RelayRequest` / `RelayEvent`)

- One long-lived port named `socket-host`. The document connects to the worker.
- The worker accepts it only if `sender.url` is the extension's own `socketHost.html` and `sender.tab` is absent. Content scripts on twitch.tv and kick.com can call `runtime.connect` too, so this check is essential.
- Worker → document: `{type:"open", id, url}`, `{type:"send", id, data}`, `{type:"close", id}`.
- Document → worker: `{type:"open", id}`, `{type:"message", id, data}` (after filtering), `{type:"close", id, code}`, and `{type:"keepalive"}` every 20 s while any socket is open.
- The document relays between the port and its Worker with `postMessage`. Only the Worker touches `WebSocket`.

### Lifetime (Option A: the worker stays alive while sockets are open)

- While at least one socket is open, the document sends a keepalive every 20 s. The worker stays as alive as it is today; today the IRC idle PING and Hermes traffic happen to keep it alive.
- If the port disconnects anyway (worker crash or update), the document closes every socket and every `RemoteSocket` gets a close with code 1006. Core's existing reconnect logic takes over. This is the same as the current relay.
- The document closes itself 10 s after the last socket is released, as `RELAY_IDLE_CLOSE_MS` does now.
- Option B, where sockets survive worker restarts and the worker re-attaches, is deliberately not built. It would need socket state handed over between workers, and keepalives already make it unnecessary.

### Origin rules (`platformRequestOrigin.ts`, extended)

- Add rule ids `9103` (Twitch) and `9104` (Kick):
  - `resourceTypes: ["websocket"]`
  - `initiatorDomains: [extension host]`
  - `requestDomains`: `twitch.tv` or `kick.com`
  - no method exclusion
- `installPlatformOriginRules` becomes the readiness gate. The socket host factory awaits it before creating the document. If it rejects, sockets fail closed.
- Firefox (`platformSocketOrigin.firefox.ts`):
  - Register `webRequest.onBeforeSendHeaders` **synchronously at the top level** of the background, with `["blocking", "requestHeaders"]` and URL patterns `wss://*.twitch.tv/*` and `wss://*.kick.com/*`.
  - Rewrite `Origin` only when `details.originUrl` starts with the extension's own `moz-extension://<uuid>/`, so a real Twitch or Kick tab's sockets are never touched.
  - Firefox also needs `webRequestBlocking`.

### Permissions (`wxt.config.ts`, `platformHosts.ts`)

- Add `wss://*.twitch.tv/*` and `wss://*.kick.com/*` to `host_permissions`.
- Chrome host warnings are per host, not per scheme, so these should not re-prompt. That is still unproven: **the release gate is a real update test** (Task 7), not `getPermissionWarningsByManifest`.
- Firefox MV3 may not grant new host permissions on update. Check with `permissions.contains` at socket-open time. If missing, fail closed with a diagnostic, and surface it through the existing missing-permission prompt if there is one (find it during Task 5; otherwise add a minimal popup notice).
- Chrome permissions: `offscreen` stays. The offscreen reason becomes `WORKERS`.

### Removals

- `entrypoints/kickRealtime/index.html`
- `entrypoints/kickRealtimeRelay.content.ts`
- `src/core/kickRealtimeRelay.ts`; its filter moves into `socketProfiles.ts`
- In `background.ts`: the `kickOrigin` flag and the `acceptedProviders` branching (always `["centrifugo"]` if decision 1 is accepted)
- In core: the Pusher endpoint parsing, if decision 1 is accepted, with tests updated

---

### Task 1: Socket profiles and frame filters

**Files:**
- Create: `packages/extension/src/core/socketProfiles.ts`
- Test: `packages/extension/tests/socketProfiles.test.ts`

- [ ] `socketProfileFor(url)` returns the profile or `undefined`. Test every allowed URL shape and near-misses (wrong host, `ws://`, extra path, `#` fragment, uppercase tricks).
- [ ] `filterFrame(profile, data)` returns the forwarded string or `undefined`. IRC tests:
  - a multi-line frame that mixes PING and PRIVMSG keeps only PING;
  - a PRIVMSG-only frame returns `undefined`;
  - USERSTATE, 366 and RECONNECT pass.
- [ ] Move the Kick Centrifugo filter and its tests from `kickRealtimeRelay` unchanged.

### Task 2: Offscreen socket host (document and Worker)

**Files:**
- Create: `packages/extension/entrypoints/socketHost/index.html` (Chrome only: `manifest.exclude`), `packages/extension/entrypoints/socketHost/main.ts`, and the Worker entry, bundled by WXT as a worker script
- Create: `packages/extension/src/core/socketHost.ts`, with a pure `startSocketHost(deps)` that has injected `connect`, `createWebSocket` and timers
- Test: `packages/extension/tests/socketHost.test.ts`

- [ ] `startSocketHost` connects the port. It opens a socket only for an allowed profile, forwards filtered frames, sends `send` only when `readyState === 1`, and closes all sockets on port disconnect.
- [ ] Keepalive every 20 s while any socket is open; none when there are no sockets.
- [ ] The document-to-Worker relay is a thin `postMessage` bridge; its logic lives in the testable module.
- [ ] Confirm WXT bundles a `new Worker(new URL(...), {type:"module"})` entry from an unlisted page. If not, emit it as an unlisted script.

### Task 3: Worker-side factory

**Files:**
- Create: `packages/extension/src/core/socketHostFactory.ts`, generalized from `createKickRealtimeRelay`
- Test: `packages/extension/tests/socketHostFactory.test.ts` (port the existing relay tests, then add new ones)

- [ ] Same `RemoteSocket` semantics as today's `RelaySocket`.
- [ ] Sender check: own `socketHost.html` and no tab.
- [ ] Awaits the readiness gate (the Origin rules are installed) before creating the document. If the gate rejects, every socket closes with 1006 and one diagnostic.
- [ ] Ignores `keepalive` messages; receiving them is enough to keep the worker alive.
- [ ] Creates the document with reason `WORKERS` and a justification such as "Runs the extension's platform connections in a worker."

### Task 4: Origin rules for sockets

**Files:**
- Modify: `packages/extension/src/core/platformRequestOrigin.ts` and `packages/extension/tests/platformRequestOrigin.test.ts`

- [ ] Add rules 9103 and 9104 as specified above. Unit-test their shape.
- [ ] `installPlatformOriginRules` returns a promise the factory can await. Install it once at the background's top level and share the promise.

### Task 5: Wire into the background; Firefox listener; permissions

**Files:**
- Modify: `packages/extension/entrypoints/background.ts`, `packages/extension/wxt.config.ts`, `packages/extension/src/core/platformHosts.ts`, `packages/extension/tests/manifestPermissions.test.ts`
- Create: `packages/extension/src/core/platformSocketOrigin.ts` (Firefox listener), with tests

- [ ] On Chrome, give the socket host factory to the Twitch adapter (`webSocketFactory`, `chatWebSocketFactory`), to `KickRealtimeConnection` and to the Kick adapter's viewer socket. Fortnite stays on `new WebSocket` (phase 2).
- [ ] On Firefox, register the listener at the top level synchronously and keep plain sockets.
- [ ] Before opening a socket on Firefox, check `permissions.contains` for the `wss://` grant. If it's missing, fail closed with a diagnostic and surface the missing grant.
- [ ] Add the two `wss://` host permissions, and `webRequestBlocking` on Firefox. Update the manifest permission tests.

### Task 6: Remove the kick.com relay; Pusher (per decision 1)

- [ ] Delete the relay entrypoints and module listed under Removals. Remove the `kickOrigin` and `acceptedProviders` branching.
- [ ] If Pusher is dropped: remove the Pusher endpoint parsing and the Pusher filter from core and update their tests. Otherwise keep it and add the host.

### Task 7: Verification (not CI; record results in the PR)

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm verify`.
- [ ] Wire probe script (kept under `scripts/` or in the PR description, not in CI):
  - Chromium loads the built extension, and a local wss server mapped to `hermes.twitch.tv`, `irc-ws.chat.twitch.tv`, `realtime.x.platform.kick.com` and `websockets.kick.com` (`--host-resolver-rules`) logs every handshake `Origin`.
  - Expected: `https://www.twitch.tv` and `https://kick.com`, never `chrome-extension://`.
  - Run it again in Firefox with `web-ext-run` and a profile that trusts a probe CA.
- [ ] Live, Chrome:
  - Kick Centrifugo connects without the frame (it returns 403 otherwise).
  - Twitch Hermes subscribes and IRC joins.
  - The Kick viewer socket stays connected.
- [ ] Live, Firefox: Kick Centrifugo connects (first time ever on Firefox).
- [ ] Soak: 30 minutes or more on a busy Twitch chat and a Kick channel. Compare against `develop`:
  - reconnect and rejoin counts;
  - worker restarts;
  - `points-earned` pushes still arrive.
- [ ] Update test, Chrome:
  - Pack v(N) without the `wss://` hosts and install it from the .crx with a fixed key.
  - Bump the version, add the hosts, repack with the same key, and let Chrome update.
  - The extension must stay enabled with no re-approval. **If it's disabled, stop and re-plan.**
- [ ] Update test, Firefox: check whether `wss://` hosts are granted after an update. If not, confirm the fail-closed notice appears.

### Task 8: Docs

- [ ] `AGENTS.md`: replace the kick.com relay exception.
  - All platform sockets run in the offscreen socket host and present the platform's `Origin` through declarativeNetRequest; on Firefox, blocking `webRequest` does it.
  - The host enforces the allowlist and filters. It reads no cookies or credentials and never sends chat.
  - Rewriting other identity headers stays forbidden.
- [ ] `docs/architecture.md`: socket host section.
- [ ] Update `docs/chrome-web-store-submission.md` if it explains the offscreen justification.

## Risks

- **Chrome re-prompting for `wss://`:** gated by the update test in Task 7.
- **Firefox not granting the new hosts on update:** fail-closed notice. Firefox sockets would be off until the user grants them.
- **Offscreen review wording:** decision 4; the reason is honest because sockets do run in a Worker.
- **Worker keepalive:** worker uptime matches today's while sockets are open. It doesn't increase it, because the document stops sending keepalives when no sockets remain.
