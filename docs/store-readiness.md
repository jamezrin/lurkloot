# Store Readiness

Lurkloot is designed as a normal-session WebExtension:

- It opens or reuses normal browser watch tabs, pins them, and mutes them. Same-origin API helper tabs, when no suitable existing tab is available, are inactive and muted but not pinned watch tabs.
- It can optionally farm in tabless low-resource mode by sending platform watch heartbeats; if those heartbeats stop earning, it falls back to visible muted tabs.
- It never asks the user for a password or exports cookies. Session credentials authorize direct requests to their own platforms; separately opted-in Twitch Extension providers receive only their channel-scoped viewer authorization. It reads the user's existing Twitch (`auth-token`, `unique_id`) and Kick (`session_token`) session values on-device only to authenticate requests to those platforms' own APIs as the logged-in user.
- It reads Kick's `session_token` cookie only inside Kick's own page context to authorize same-session requests to `web.kick.com`; the token is never persisted, logged, exported, or sent anywhere except Kick's API.
- It captures and stores Twitch's short-lived `Client-Integrity` bundle locally so claim mutations can replay the same page-issued headers; the bundle expires and is not exported.
- It does not run Selenium, hidden browser profiles, CAPTCHA handling, or anti-detection bypasses.
- It limits required host permissions to Twitch and Kick first-party domains. Platform features can move between first-party service subdomains, so domain wildcards prevent farming from breaking whenever either platform changes that internal layout.
- It stores local extension settings, scheduler state, campaign metadata, a compact local event log, and the transient Twitch integrity bundle described above.
- The popup is the only public extension surface. It does not expose diagnostics, acceptance reports, settings import/export, cookies, tokens, or credentials.
- Platform failures use per-platform retry backoff so a broken Twitch or Kick API path is not hammered every scheduler tick.
- Firefox currently declares `required: ["none"]`. Store disclosures must be checked against the documented optional vendor authorization flow before publication; local settings/log storage must not be described as meaning no outbound service communication.

## Chrome Web Store listing

- **Single purpose:** Lurkloot automates collecting Twitch and Kick viewer drops within the user's own logged-in browser session.
- **Summary (≤132 chars):** Farm Twitch and Kick drops through normal browser sessions, visible muted tabs, and optional low-resource mode.
- **Category:** Productivity.
- **Detailed description:** Lurkloot farms Twitch and Kick viewer drops for you using your normal, already-logged-in browser session. By default it opens a visible, pinned, muted watch tab on the channel that earns the drop you want, switches channels as campaigns complete, and claims eligible rewards automatically. An optional tabless low-resource mode sends platform watch heartbeats instead of keeping a tab open, and automatically falls back to a visible muted tab if progress stalls. It never asks for your password, never exports cookies or tokens, and keeps settings and logs on your device. Optional NoPixelV and Fortnite reward providers run without Twitch tabs and receive scoped viewer authorization directly only when enabled. The popup lets you enable each platform, prioritize campaigns and games, manage per-platform idle watchlists and excluded channels, and toggle auto-claim and notifications.
- **Privacy policy URL:** the policy in `privacy-policy.md` must be published at a public URL (e.g. GitHub Pages or a gist) and that URL entered in the dashboard. A file in the repository is not sufficient.
- **Remote code:** No. All code ships inside the installed package.
- **Data usage:** No user data is sold, used for purposes unrelated to the single purpose, or used to determine creditworthiness/lending. Settings and logs stay local. Normal platform authorization goes directly to its platform, and optional provider-scoped viewer authorization goes directly to the enabled reward provider; LurkLoot operates no relay or analytics collection.

## Permission justifications

Paste-ready justifications for the Chrome Web Store privacy tab. Each maps to actual usage in the codebase.

- **`alarms`** — Schedules the periodic scheduler tick and the one-minute watch heartbeat that drive drops farming; without it there is no farming loop. (`entrypoints/background.ts`)
- **`storage`** — Persists user settings, scheduler/campaign state, the diagnostic event log, and the short-lived Twitch integrity bundle locally. (`packages/extension/src/core/storage.ts`)
- **`tabs`** — Opens, pins, mutes, retargets, queries, and closes the extension's own watch tabs and temporary same-origin API tabs; managed tab ids are tracked so only extension-created tabs are touched. (`packages/extension/src/core/tabs.ts`, `packages/core/src/core/tabs.ts`)
- **`scripting`** — Runs a self-contained `fetch` in the page's MAIN world (same-origin to Twitch/Kick) so platform API calls happen inside the user's logged-in session instead of a cross-origin background request. (`packages/extension/src/core/tabs.ts`)
- **`notifications`** — Shows optional, user-toggleable local notifications when a reward is earned or a platform has no drops left. (`packages/core/src/background/controller.ts`, `packages/extension/entrypoints/background.ts`)
- **`cookies`** — Reads the user's Twitch `auth-token` and `unique_id` cookies — which are httpOnly and therefore only readable via this API — to authorize Twitch GQL requests as the logged-in user, mirroring the Twitch web client. The cookies are never stored or exported; the Twitch auth token is used only to authorize direct Twitch requests. (`packages/extension/src/core/tabs.ts`)
- **`webRequest`** — Observes outgoing request headers on `https://gql.twitch.tv/*` to capture the `Client-Integrity` token the user's own Twitch page already sends, so authenticated drop-claim mutations can replay it. Headers are only read, never modified or blocked. (`packages/extension/entrypoints/background.ts`, `packages/core/src/core/twitchIntegrity.ts`)

## Host permission justifications

- **`https://*.twitch.tv/*`** — Supports Twitch watch pages, campaign and reward APIs, session authentication, and tabless farming signals. Twitch selects some of these services dynamically and may move them between its own subdomains; domain-wide first-party access keeps farming functional across those changes.
- **`https://*.kick.com/*`** — Supports Kick watch pages, campaign and reward APIs, session authentication, and tabless watch events. Kick uses multiple first-party service subdomains and may add or replace them as the platform evolves.

These required wildcards replace the previous exact-host list. Existing Chrome users may need to approve the expanded site access after updating before the extension is re-enabled. The access remains restricted to Twitch and Kick domains and is used only for the extension's drop-farming purpose.

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

Chromium requires Chrome 116 or newer so ordinary WebSocket ping traffic can maintain the MV3 background worker. Firefox uses its persistent MV2 background. Neither grant enables remote code execution or changes required permissions.
