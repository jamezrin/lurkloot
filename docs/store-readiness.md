# Store Readiness

Lurkloot is designed as a normal-session WebExtension:

- It opens or reuses normal browser watch tabs, pins them, and mutes them. Same-origin API helper tabs, when no suitable existing tab is available, are inactive and muted but not pinned watch tabs.
- It can optionally farm in tabless low-resource mode by sending platform watch heartbeats; if those heartbeats stop earning, it falls back to visible muted tabs.
- It never asks the user for a password, and it does not export or transmit credentials or cookies. It reads the user's existing Twitch (`auth-token`, `unique_id`) and Kick (`session_token`) session values on-device only to authenticate requests to those platforms' own APIs as the logged-in user.
- It reads Kick's `session_token` cookie only inside Kick's own page context to authorize same-session requests to `web.kick.com`; the token is never persisted, logged, exported, or sent anywhere except Kick's API.
- It captures and stores Twitch's short-lived `Client-Integrity` bundle locally so claim mutations can replay the same page-issued headers; the bundle expires and is not exported.
- It does not run Selenium, hidden browser profiles, CAPTCHA handling, or anti-detection bypasses.
- It limits host permissions to Twitch, Twitch GQL, Kick, Kick web API, and Kick WebSocket origins.
- It stores local extension settings, scheduler state, campaign metadata, a compact local event log, and the transient Twitch integrity bundle described above.
- The popup is the only public extension surface. It does not expose diagnostics, acceptance reports, settings import/export, cookies, tokens, or credentials.
- Platform failures use per-platform retry backoff so a broken Twitch or Kick API path is not hammered every scheduler tick.
- Firefox data collection disclosure is set to `required: ["none"]` because the extension does not transmit collected user data outside the browser/visited platform APIs.

## Chrome Web Store listing

- **Single purpose:** Lurkloot automates collecting Twitch and Kick viewer drops within the user's own logged-in browser session.
- **Summary (≤132 chars):** Farm Twitch and Kick drops through normal browser sessions, visible muted tabs, and optional low-resource mode.
- **Category:** Productivity.
- **Detailed description:** Lurkloot farms Twitch and Kick viewer drops for you using your normal, already-logged-in browser session. By default it opens a visible, pinned, muted watch tab on the channel that earns the drop you want, switches channels as campaigns complete, and claims eligible rewards automatically. An optional tabless low-resource mode sends platform watch heartbeats instead of keeping a tab open, and automatically falls back to a visible muted tab if progress stalls. It never asks for your password, never exports cookies or tokens, and keeps all of its data on your device. The popup lets you enable each platform, prioritize campaigns and games, manage per-platform watch queues and excluded channels, and toggle auto-claim and notifications.
- **Privacy policy URL:** the policy in `privacy-policy.md` must be published at a public URL (e.g. GitHub Pages or a gist) and that URL entered in the dashboard. A file in the repository is not sufficient.
- **Remote code:** No. All code ships inside the installed package.
- **Data usage:** No user data is sold, used for purposes unrelated to the single purpose, or used to determine creditworthiness/lending. No collected data is transmitted off-device.

## Permission justifications

Paste-ready justifications for the Chrome Web Store privacy tab. Each maps to actual usage in the codebase.

- **`alarms`** — Schedules the periodic scheduler tick and the one-minute watch heartbeat that drive drops farming; without it there is no farming loop. (`entrypoints/background.ts`)
- **`storage`** — Persists user settings, scheduler/campaign state, the diagnostic event log, and the short-lived Twitch integrity bundle locally. (`src/core/storage.ts`)
- **`tabs`** — Opens, pins, mutes, retargets, queries, and closes the extension's own watch tabs and temporary same-origin API tabs; managed tab ids are tracked so only extension-created tabs are touched. (`src/core/tabs.ts`)
- **`scripting`** — Runs a self-contained `fetch` in the page's MAIN world (same-origin to Twitch/Kick) so platform API calls happen inside the user's logged-in session instead of a cross-origin background request. (`src/core/tabs.ts`)
- **`notifications`** — Shows optional, user-toggleable local notifications when a reward is earned or a platform has no drops left. (`src/background/controller.ts`)
- **`cookies`** — Reads the user's Twitch `auth-token` and `unique_id` cookies — which are httpOnly and therefore only readable via this API — to authorize Twitch GQL requests as the logged-in user, mirroring the Twitch web client. The cookies are never stored or transmitted off-device. (`src/core/tabs.ts`)
- **`webRequest`** — Observes outgoing request headers on `https://gql.twitch.tv/*` to capture the `Client-Integrity` token the user's own Twitch page already sends, so authenticated drop-claim mutations can replay it. Headers are only read, never modified or blocked. (`entrypoints/background.ts`, `src/core/twitchIntegrity.ts`)

## Host permission justifications

- **`https://www.twitch.tv/*`** — Playback telemetry/control content script on watch tabs, opening and managing watch tabs, same-origin page-context API fetches, and reading the Twitch session cookies above.
- **`https://gql.twitch.tv/*`** — Twitch's GraphQL API for campaign discovery, progress, channel validation, and drop/channel-point claims, plus the read-only `Client-Integrity` header capture.
- **`https://kick.com/*`** — Kick content script, watch tabs, and the `kick.com` channel API (v2) for channel validation.
- **`https://web.kick.com/*`** — Kick's drops and livestream JSON APIs (campaigns, progress, claim, livestreams).
- **`https://websockets.kick.com/*`** — Kick's viewer WebSocket used by tabless low-resource mode to send watch events.

## Release verification

```bash
pnpm verify
pnpm zip
pnpm zip:firefox
```

Manual acceptance remains required with real logged-in Twitch and Kick sessions before publishing because both platforms can change private API and page behavior without notice. Use the popup to enable each platform, verify that visible tab mode opens pinned watch tabs through the user's normal browser session, verify tabless mode falls back when unhealthy, and confirm rewards progress on the platform inventory pages.
