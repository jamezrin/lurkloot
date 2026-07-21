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
- Prevent future Twitch or Kick service-subdomain additions from requiring a
  warning-triggering mandatory permission update.
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
- Remove the existing exact permissions required by working Twitch and Kick
  features.

## Design

### Optional platform wildcard permissions

Keep the currently shipped exact Twitch and Kick hosts in `host_permissions`.
This preserves all existing capabilities after the update and means declining
additional access never regresses Kick or Twitch's established GraphQL and
watch-tab behavior.

Declare `https://*.twitch.tv/*` and `https://*.kick.com/*` in
`optional_host_permissions`. Request each platform independently from an
explicit button in that platform's settings section. The broad optional grant
is justified because both services may move browser-session APIs and telemetry
to new first-party subdomains; granting it once prevents a later mandatory
permission expansion from disabling the extension during an update.

Chrome requires optional permission requests to originate from a user gesture.
The extension therefore checks grant state when settings opens but never opens
the browser prompt automatically. An already-enabled provider shows an action
to grant access. The Twitch action immediately makes Spade available; the Kick
action future-proofs Kick while its current exact hosts continue to work.

The three newly discovered Twitch hosts are not mandatory permissions. They are
covered by the optional Twitch wildcard after consent.

If a request is denied or dismissed, keep the action available and record a
safe diagnostic. Twitch retains the managed muted-tab fallback; Kick continues
on its exact current hosts. Never disable a provider because optional access was
declined.

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

- Manifest coverage tests assert both wildcards are optional, the three new
  Twitch hosts are not mandatory, and all previously shipped exact Twitch and
  Kick permissions remain mandatory.
- Popup adapter tests cover permission checks and independent requests for each
  platform.
- Settings tests cover granted, missing, pending, denied, and retry states.
- Spade strategy tests cover contextual destination-fetch failure, contextual
  POST failure, and unchanged success behavior.
- Extension transport tests verify safe hostname formatting and ensure paths,
  query strings, and credentials do not appear in errors.
- Existing tabless-controller tests continue to verify retry counting and the
  managed-tab fallback.
- Run `pnpm test`, `pnpm typecheck`, and both extension production builds because
  host permissions are browser-manifest output.

## Release and user-facing documentation

The pull request and store-readiness notes must explain both optional wildcard
permissions, their provider-specific user gesture, and the unchanged behavior
after denial. The patch changelog describes restoring Twitch tabless farming;
package versions remain unchanged because the release workflow owns the patch
version bump.
