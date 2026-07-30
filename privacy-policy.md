# Lurkloot Privacy Policy

Last updated: July 26, 2026

Lurkloot does not collect, transmit, sell, or share user data.

## Local Storage

The extension stores its settings, scheduler state, campaign progress, managed-tab identifiers, and a compact diagnostic event log locally in the user's browser using extension storage. It also stores a short-lived Twitch "Client-Integrity" token bundle so it can replay the same page-issued headers Twitch requires when claiming a drop; this bundle expires and is refreshed from the user's own Twitch page traffic. All of this data remains on the user's device and is not sent to the developer or to any third-party or analytics service.

The diagnostic event log records the extension's own activity — campaign and reward names and ids, channel names, managed-tab identifiers, reason codes and timings — so a problem can be diagnosed after the fact. It is bounded and pruned automatically, it never contains passwords, cookies or session tokens, and it can be turned off or cleared at any time in the extension. The extension never uploads it. The activity view offers a "Copy log" button that places its contents on the user's clipboard; where the user then pastes it is entirely the user's choice.

## Platform Access

Lurkloot accesses Twitch and Kick only to provide its core drops-farming functionality: detecting campaigns, checking progress, managing visible muted watch tabs, and claiming eligible rewards. It acts entirely within the user's existing logged-in browser session.

To authorize requests inside that session, the extension reads certain session values on the user's own device:

- On Twitch, it reads the `auth-token` and `unique_id` cookies and attaches them to Twitch's own API (`gql.twitch.tv`) requests, exactly as the Twitch web client does. It also captures the short-lived `Client-Integrity` token that the user's logged-in Twitch page already sends, and replays it when claiming drops.
- On Kick, it reads the `session_token` from the Kick page context and uses it as a bearer token for Kick's own API (`web.kick.com`).

These values are used only to talk to each platform's own API as the logged-in user. The extension never asks for the user's password, and it never sends cookies, tokens, credentials, or any other personal data to the developer or to any third party. The Kick session token is not persisted; the Twitch integrity bundle is stored only transiently and expires.

## Remote Code

The extension does not use remote code. All extension code is included in the installed extension package.

## Contact

For privacy questions about Lurkloot, contact the developer at jaime@jamezrin.name.
