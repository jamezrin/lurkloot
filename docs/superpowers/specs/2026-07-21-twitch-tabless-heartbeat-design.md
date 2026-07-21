# Twitch Tabless Heartbeat Recovery Design

## Problem

The extension's recommended Twitch web compatibility profile uses the Spade
heartbeat. A heartbeat first fetches the selected Twitch channel page, reads the
referenced settings bundle, extracts Twitch's Spade or beacon endpoint, and
posts the minute-watched event there.

The extension currently grants host access only to `www.twitch.tv` and
`gql.twitch.tv`. Twitch serves the settings bundle from `assets.twitch.tv` and
the extracted endpoints from `spade.twitch.tv` or `beacon.twitch.tv`. Browser
extension fetches to those hosts therefore fail. The failure is reduced to the
browser's generic `Failed to fetch` message, so three consecutive heartbeat
failures trigger the intended muted-tab fallback without explaining the real
cause.

## Goals

- Restore the recommended Twitch Spade heartbeat in Chromium and Firefox.
- Keep new host permissions limited to the exact Twitch services the heartbeat
  consumes.
- Make destination discovery and heartbeat delivery failures identify their
  stage and safe hostname.
- Never log request paths, query strings, headers, cookies, tokens, or payloads.
- Preserve the existing retry limit and managed watch-tab fallback when a real
  heartbeat failure occurs.

## Non-goals

- Change the compatibility profile or make the legacy GraphQL heartbeat the
  default.
- Change scheduler retry counts or tab fallback policy.
- Address Kick page-context tabs or settings-session pausing in this branch;
  those form the second deliverable after this regression fix.
- Add wildcard Twitch host access.

## Design

### Exact host permissions

Add these entries to the extension manifest:

- `https://assets.twitch.tv/*` for the settings bundle referenced by channel
  pages.
- `https://spade.twitch.tv/*` for the primary web heartbeat endpoint.
- `https://beacon.twitch.tv/*` for the supported fallback endpoint.

Do not use `https://*.twitch.tv/*`: the broader permission is unnecessary and
would weaken the extension's stated least-privilege policy.

### Stage-aware transport errors

The extension-owned heartbeat transports will wrap browser fetch failures with
safe context before returning them to the core heartbeat strategy:

- Page or settings-bundle fetch: `Twitch Spade destination fetch failed for
  <hostname>: <cause>`.
- Heartbeat POST: `Twitch Spade heartbeat POST failed for <hostname>: <cause>`.
- Non-success page responses retain their HTTP status and hostname.

Only `new URL(url).hostname` is exposed. If URL parsing unexpectedly fails, use
`unknown Twitch host`. The original error message is retained because browser
errors such as `Failed to fetch` are useful once the stage and hostname are
known.

The `TwitchHeartbeatPost` contract will carry a transport error rather than
collapsing it to `false`. The Spade strategy will return that contextual message
as its failed `HeartbeatResult`. Unexpected HTTP status remains distinguishable
from a thrown network error.

### Diagnostic behavior

The controller continues to publish only the first failure in a consecutive
failure run at warning level, avoiding once-per-minute log spam. Existing debug
events still show the channel and broadcast selected for the heartbeat. A user
will therefore see a causal sequence such as:

1. `Heartbeat for example (broadcast ..., channel ...)`
2. `Twitch Spade destination fetch failed for assets.twitch.tv: Failed to fetch`
3. After the configured retry limit, `Tabless watch heartbeat keeps failing;
   falling back to a watch tab`

Successful heartbeats and recovery behavior remain unchanged.

## Testing

- Manifest coverage test asserts all three exact hosts are present and the
  wildcard Twitch permission is absent.
- Spade strategy tests cover contextual destination-fetch failure, contextual
  POST failure, and unchanged success behavior.
- Extension transport tests verify safe hostname formatting and ensure paths,
  query strings, and credentials do not appear in errors.
- Existing tabless-controller tests continue to verify retry counting and the
  managed-tab fallback.
- Run `pnpm test`, `pnpm typecheck`, and both extension production builds because
  host permissions are browser-manifest output.

## Release and user-facing documentation

The pull request must call out the three added Twitch host permissions and why
each is required. No new user setting is introduced. Store-listing permission
notes should be updated if the existing documentation enumerates individual
Twitch hosts.
