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
- Grant required first-party Twitch and Kick wildcard access now, while the
  install base is small, so future service-subdomain additions require no
  permission migration.
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
- Avoid the browser's one-time expanded-access approval on this release. This
  migration intentionally accepts that rollout cost.

## Design

### Required platform wildcard permissions

Replace all exact Twitch and Kick host entries with these two required
`host_permissions`:

- `https://*.twitch.tv/*`
- `https://*.kick.com/*`

WebExtension match patterns cover each base domain and its subdomains, so the
existing `www.twitch.tv`, `gql.twitch.tv`, `kick.com`, `web.kick.com`, and
`websockets.kick.com` entries are redundant. Do not retain them and do not
declare `optional_host_permissions` or Firefox MV2 `optional_permissions`.

This intentionally causes Chrome to treat the update as an expanded-access
migration. Chrome may disable the extension until the user approves the new
access. The project accepts that one-time attrition risk at the current small
install base to avoid repeating the migration after the audience grows.

Remove the provider permission actions and all supporting adapter APIs, runtime
messages, diagnostics, localized copy, state management, and tests. There is no
consent state or fallback behavior specific to permissions after this change;
normal heartbeat failure fallback remains unchanged.

### Stage-aware transport errors

The extension-owned heartbeat transports will wrap browser fetch failures with
safe context before returning them to the core heartbeat strategy:

- Page or settings-bundle fetch: `Twitch Spade destination fetch failed for
  <hostname>: <cause>`.
- Heartbeat POST: `Twitch Spade heartbeat POST failed for <hostname>: <cause>`.
- Non-success page responses retain their HTTP status and hostname.

Only `new URL(url).hostname` is exposed. If URL parsing unexpectedly fails, use
`unknown Twitch host`. Only generic browser failures and extension-created HTTP
status messages are retained; arbitrary exception text is replaced with a fixed
cause so paths, query values, or credentials cannot appear in diagnostics.
Messages such as `Failed to fetch` remain useful once the stage and hostname are
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

- Manifest coverage tests assert the two required wildcards are present, exact
  platform hosts are absent, and neither optional-permission key is configured.
- Remove popup adapter, settings consent, and permission-result routing tests
  with the production behavior they covered.
- Spade strategy tests cover contextual destination-fetch failure, contextual
  POST failure, and unchanged success behavior.
- Extension transport tests verify safe hostname formatting and ensure paths,
  query strings, and credentials do not appear in errors.
- Existing tabless-controller tests continue to verify retry counting and the
  managed-tab fallback.
- Run `pnpm test`, `pnpm typecheck`, and both extension production builds because
  host permissions are browser-manifest output.

## Release and user-facing documentation

The pull request and store-readiness notes must explain why required first-party
wildcards are necessary and warn that existing Chrome users may need to approve
expanded access after updating. The patch changelog continues to describe the
Twitch tabless farming fix; package versions remain unchanged because the
release workflow owns the patch version bump.
