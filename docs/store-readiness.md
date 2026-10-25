# Store Readiness

Lurkloot is designed as a normal-session WebExtension:

- It opens or reuses normal browser watch tabs, pins them, and mutes them. Same-origin API helper tabs, when no suitable existing tab is available, are inactive and muted but not pinned watch tabs.
- It can optionally farm in tabless low-resource mode by sending platform watch heartbeats; if those heartbeats stop earning, it falls back to visible muted tabs.
- It never asks the user for a password or exports cookies. Session credentials authorize direct requests to their own platforms; separately opted-in Twitch Extension providers receive only their channel-scoped viewer authorization. It reads the user's existing Twitch (`auth-token`, `unique_id`) and Kick (`session_token`) session values on-device only to authenticate requests to those platforms' own APIs as the logged-in user.
- It reads Kick's `session_token` cookie only inside Kick's own page context to authorize same-session requests to `web.kick.com`; the token is never persisted, logged, exported, or sent anywhere except Kick's API.
- It captures and stores Twitch's short-lived `Client-Integrity` bundle locally so claim mutations can replay the same page-issued headers; the bundle expires and is not exported.
- It does not run Selenium, hidden browser profiles, CAPTCHA handling, or anti-detection bypasses.
- It limits required host permissions to Twitch, Kick, Twitch's video CDN (`ttvnw.net`, used by the default HLS watch heartbeat), Twitch's static CDN (`jtvnw.net`), Twitch CDN (`twitchcdn.net`, including Kasada at `k.twitchcdn.net`), Amazon IVS (`live-video.net`, Kick livestream playback and Twitch player device-config), and Twitch Extensions hosts (`ext-twitch.tv`). Platform features can move between first-party service subdomains, so domain wildcards prevent farming from breaking whenever either platform changes that internal layout.
- It stores local extension settings, scheduler state, campaign metadata, a compact local event log, and the transient Twitch integrity bundle described above.
- The popup is the only public extension surface. It does not expose diagnostics, acceptance reports, settings import/export, cookies, tokens, or credentials.
- Platform failures use per-platform retry backoff so a broken Twitch or Kick API path is not hammered every scheduler tick.
- Firefox currently declares `required: ["none"]`. Store disclosures must be checked against the documented optional vendor authorization flow before publication; local settings/log storage must not be described as meaning no outbound service communication.

## Chrome Web Store listing

- **Single purpose:** Lurkloot automates collecting Twitch and Kick viewer drops within the user's own logged-in browser session.
- **Summary (≤132 chars):** Farm Twitch and Kick drops through normal browser sessions, visible muted tabs, and optional low-resource mode.
- **Category:** Productivity.
- **Detailed description:** Lurkloot farms Twitch and Kick viewer drops for you using your normal, already-logged-in browser session. By default it opens a visible, pinned, muted watch tab on the channel that earns the drop you want, switches channels as campaigns complete, and claims eligible rewards automatically. An optional tabless low-resource mode sends platform watch heartbeats instead of keeping a tab open, and automatically falls back to a visible muted tab if progress stalls. It never asks for your password, never exports cookies or tokens, and keeps settings and logs on your device. Optional NoPixelV and Fortnite reward providers run without Twitch tabs and receive scoped viewer authorization directly only when enabled. The popup lets you enable each platform, prioritize campaigns and games, manage per-platform watchlists and excluded channels, and toggle auto-claim and notifications.
- **Privacy policy URL:** the policy in `privacy-policy.md` must be published at a public URL (e.g. GitHub Pages or a gist) and that URL entered in the dashboard. A file in the repository is not sufficient.
- **Remote code:** No. All code ships inside the installed package.
- **Data usage:** No user data is sold, used for purposes unrelated to the single purpose, or used to determine creditworthiness/lending. Settings and logs stay local. Normal platform authorization goes directly to its platform, and optional provider-scoped viewer authorization goes directly to the enabled reward provider; LurkLoot operates no relay or analytics collection.

## Permission justifications

Paste-ready justifications for the Chrome Web Store privacy tab. Each maps to actual usage in the codebase.

- **`alarms`** — Schedules the periodic scheduler tick and the watch heartbeat that drive drops farming. The watch alarm runs every minute, and every 30 seconds only while tabless Twitch watching requests video segments between its one-minute health checks. (`entrypoints/background.ts`)
- **`storage`** — Persists user settings, scheduler/campaign state, the diagnostic event log, and the short-lived Twitch integrity bundle locally. (`packages/extension/src/core/storage.ts`)
- **`tabs`** — Opens, pins, mutes, retargets, queries, and closes the extension's own watch tabs and temporary same-origin API tabs; managed tab ids are tracked so only extension-created tabs are touched. (`packages/extension/src/core/tabs.ts`, `packages/core/src/core/tabs.ts`)
- **`scripting`** — Runs a self-contained `fetch` in the page's MAIN world (same-origin to Twitch/Kick) so platform API calls happen inside the user's logged-in session instead of a cross-origin background request. (`packages/extension/src/core/tabs.ts`)
- **`notifications`** — Shows optional, user-toggleable local notifications when a reward is earned or a platform has no drops left. (`packages/core/src/background/controller.ts`, `packages/extension/entrypoints/background.ts`)
- **`cookies`** — Reads the user's Twitch `auth-token` and `unique_id` cookies — which are httpOnly and therefore only readable via this API — to authorize Twitch GQL requests as the logged-in user, mirroring the Twitch web client. The cookies are never stored or exported; the Twitch auth token is used only to authorize direct Twitch requests. (`packages/extension/src/core/tabs.ts`)
- **`offscreen`** (Chrome only) — Creates one hidden extension document whose dedicated worker opens the extension's Twitch and Kick realtime connections (Twitch's push and chat-presence connections, Kick's realtime and viewer connections). Chrome applies the extension's request rules to connections opened there, so they carry the platform's own origin. The document opens only a fixed list of platform connection addresses, sends no chat messages, drops chat content unread, and reads no cookies or credentials; the extension's background mints every connection token through the platforms' own APIs. It closes when no connection needs it. (`packages/extension/entrypoints/socketHost/`, `packages/extension/src/core/socketHost.ts`, `packages/extension/src/core/socketProfiles.ts`)
- **`declarativeNetRequestWithHostAccess`** — Sets the `Origin` header of the extension's own requests and connections to Twitch and Kick to the platform's site (`https://www.twitch.tv`, `https://kick.com`), as the platforms' own pages send it. No other header is changed, and the rules act only on requests the extension itself makes to hosts it already has access to. (`packages/extension/src/core/platformRequestOrigin.ts`)
- **`webRequest`** — Observes outgoing request headers on `https://gql.twitch.tv/*` to capture the `Client-Integrity` token the user's own Twitch page already sends, so authenticated drop-claim mutations can replay it. Headers are only read, never modified or blocked. (`packages/extension/entrypoints/background.ts`, `packages/core/src/core/twitchIntegrity.ts`)

## Host permission justifications

Paste-ready for the Chrome Web Store host-permission field (under 1000 characters when joined). Each line is one host.

- **`https://*.twitch.tv/*`** — Twitch watch pages, campaign/reward APIs, session auth, and farming signals on first-party subdomains.
- **`https://*.kick.com/*`** — Kick watch pages, campaign/reward APIs, session auth, and farming signals on first-party subdomains.
- **`https://*.ttvnw.net/*`** — Twitch video CDN for tabless HLS playlist/segment checks (outside `*.twitch.tv`).
- **`wss://*.twitch.tv/*`, `wss://*.kick.com/*`** — Platform realtime sockets; Chrome needs the `wss://` grant to set Origin.
- **`wss://*.pusher.com/*`** — Kick fallback realtime provider, used with Kick's own origin.
- **`https://*.jtvnw.net/*`** — Twitch static CDN for campaign art, emotes, and thumbnails.
- **`https://*.twitchcdn.net/*`** — Twitch CDN (incl. Kasada); CLI credential-export cookie read only, never while farming.
- **`https://*.live-video.net/*`** — Amazon IVS for Kick playback and Twitch player device config.
- **`https://*.ext-twitch.tv/*`** — Twitch Extensions CDN/supervisor; provider backends stay separate optional grants.

Existing Chrome users may need to approve the expanded site access after updating. Required access stays limited to Twitch, Kick, and the CDN/IVS/extension hosts above, for drop farming only.

## Release verification

```bash
pnpm verify
pnpm zip
pnpm zip:firefox
```

Manual acceptance remains required with real logged-in Twitch and Kick sessions before publishing because both platforms can change private API and page behavior without notice. Use the popup to enable each platform, verify that visible tab mode opens pinned watch tabs through the user's normal browser session, verify tabless mode falls back when unhealthy, and confirm rewards progress on the platform inventory pages.

## Optional reward-provider host justifications

These grants are separate from required first-party hosts. Both providers are off by default. Access is requested directly when the user enables a provider; denial leaves it off and revocation terminates its resources. No Twitch channel tab or overlay frame is required.

- **`https://nopixel.streamingtoolsmith.com/*`** — Allows the opted-in NoPixelV provider to initialize its normal viewer session, read daily card-pack watchtime and channel giveaway state, join an open giveaway, read unopened packs and reveal their cards through a separate default-off automatic-opening opt-in. Its backend receives the channel-scoped Twitch Extension viewer authorization, not the user's Twitch session cookie. Giveaway activity is emitted only after the backend confirms membership.
- **`https://backend.p-n6412w7dsu.exmggames.com/*`** — Allows the opted-in Fortnite provider to connect to its normal secure WebSocket `/handler`, authenticate the scoped viewer, join the selected channel, read competition/collection/reward state and capture announced sprites. Takeovers require a separate default-off opt-in and server eligibility. Vendor-issued session/device properties remain in privileged memory and are never exported or persisted.
- **`wss://backend.p-n6412w7dsu.exmggames.com/*`** (optional, requested with the line above) — The same Fortnite backend's WebSocket host. Chrome sets a connection's origin only for hosts granted with the `wss://` scheme, so the provider's connection carries the Fortnite extension's own Twitch frame origin rather than the extension's.

Chromium requires Chrome 116 or newer so ordinary WebSocket ping traffic can maintain the MV3 background worker. Firefox uses its persistent MV2 background. Neither grant enables remote code execution or changes required permissions.
