# Store Readiness

StreamMaxxer is designed as a normal-session WebExtension:

- It opens or reuses normal browser watch tabs, pins them, and mutes them. Same-origin API helper tabs, when no suitable existing tab is available, are inactive and muted but not pinned watch tabs.
- It can optionally farm in tabless low-resource mode by sending platform watch heartbeats; if those heartbeats stop earning, it falls back to visible muted tabs.
- It does not import, export, ask the user for, log, or store raw credentials or cookies.
- It reads Kick's `session_token` cookie only inside Kick's own page context to authorize same-session requests to `web.kick.com`; the token is never persisted, logged, exported, or sent anywhere except Kick's API.
- It captures and stores Twitch's short-lived `Client-Integrity` bundle locally so claim mutations can replay the same page-issued headers; the bundle expires and is not exported.
- It does not run Selenium, hidden browser profiles, CAPTCHA handling, or anti-detection bypasses.
- It limits host permissions to Twitch, Twitch GQL, Kick, and Kick web API origins.
- It stores local extension settings, scheduler state, campaign metadata, a compact local event log, and the transient Twitch integrity bundle described above.
- The popup is the only public extension surface. It does not expose diagnostics, acceptance reports, settings import/export, cookies, tokens, or credentials.
- Platform failures use per-platform retry backoff so a broken Twitch or Kick API path is not hammered every scheduler tick.
- Firefox data collection disclosure is set to `required: ["none"]` because the extension does not transmit collected user data outside the browser/visited platform APIs.

Release verification:

```bash
pnpm verify
pnpm zip
pnpm zip:firefox
```

Manual acceptance remains required with real logged-in Twitch and Kick sessions before publishing because both platforms can change private API and page behavior without notice. Use the popup to enable each platform, verify that visible tab mode opens pinned watch tabs through the user's normal browser session, verify tabless mode falls back when unhealthy, and confirm rewards progress on the platform inventory pages.
