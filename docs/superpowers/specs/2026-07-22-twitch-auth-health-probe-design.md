# Twitch Authentication Health Probe Design

## Scope

This specification implements issue #202 only. It replaces the Twitch adapter's placeholder authentication-health result with an explicit authenticated identity probe and safe classification. Scheduler-wide suspension, degraded operational state, and account-operation gating remain in issue #204.

## Goals

- Treat the extension-owned `auth-token` cookie check as a preflight, not proof of authentication.
- Mark Twitch healthy only after a successful authenticated GQL response contains a non-null `currentUser`.
- Distinguish rejected credentials from network and Twitch availability failures.
- Keep Twitch Client-Integrity availability independent from authentication health.
- Preserve existing Twitch inventory, heartbeat, channel-points, and reward-claim behavior.

## Probe Architecture

`TwitchAdapter.checkAuthHealth()` will send the existing inline `CurrentUser` query through the adapter's authenticated Twitch GQL transport. The query requests only `currentUser { id }`; public data and anonymous query success cannot satisfy the probe.

The controller remains responsible for credential availability. When the extension credential provider reports that `auth-token` is missing, the controller returns `missing_credentials` without constructing or invoking the Twitch adapter. When a cookie is present, the adapter probe decides whether Twitch accepts it.

The probe will not call `ensureIntegrity`, request an integrity token, or interpret integrity availability as login health. No credential value or authenticated response content will enter scheduler state, activity events, diagnostics, or logs.

## Classification

Every completed probe result includes an ISO timestamp in `checkedAt` and the safe message key corresponding to its status and reason.

| Observation | Health result |
| --- | --- |
| Credential preflight reports no `auth-token` | `missing_credentials` / `credentials_missing` (controller-owned existing behavior) |
| GQL response has a non-null `currentUser` object | `healthy` |
| GQL response completes but `currentUser` is null or absent | `invalid_credentials` / `credentials_rejected` |
| Twitch explicitly rejects authentication | `invalid_credentials` / `credentials_rejected` |
| Request fails at the network/transport boundary | `unavailable` / `network_unavailable` |
| Twitch returns a non-authentication service or GQL failure | `unavailable` / `platform_unavailable` |

Classification uses structured response observations at the probe boundary. It does not infer authentication from inventory data, public Twitch fields, diagnostic strings, or Client-Integrity state.

## Recovery

Cookie changes already invalidate platform authentication health and schedule a debounced platform-only recheck. A later successful `CurrentUser` response therefore transitions the stored Twitch health from `missing_credentials`, `invalid_credentials`, or `unavailable` to `healthy` without changing the user's enabled-platform setting. Running or suppressing account automation based on that stored health remains #204.

## Error Handling

The probe catches its own expected request failures and returns the shared safe health contract rather than throwing raw transport or Twitch errors into controller state. Authentication rejection is classified separately from availability. Returned health contains no raw exception message, response body, request URL, headers, token, cookie, or user identifier.

Existing Twitch operations continue to use their current GQL transport behavior. Any helper introduced for probe classification remains focused on the probe and does not refactor inventory, heartbeat, channel-points, or claim execution.

## Testing

Focused deterministic adapter and controller tests will cover:

- a present credential and non-null `currentUser` producing `healthy`;
- null or absent `currentUser` producing `invalid_credentials`;
- an explicit Twitch credential rejection producing `invalid_credentials`;
- network/transport failure producing `unavailable` with `network_unavailable`;
- non-authentication Twitch failure producing `unavailable` with `platform_unavailable`;
- a public or anonymous response never producing `healthy`;
- missing-cookie preflight avoiding adapter invocation;
- recovery from unhealthy state to `healthy` on a later successful recheck;
- the probe never requesting Client-Integrity;
- existing inventory, heartbeat, channel-points, and reward-claim suites remaining green.

Tests use mocked fetchers and fixed expectations; they make no live Twitch requests.

## Delivery Boundary

Issue #202 is complete when Twitch authentication probing and classification replace the adapter placeholder, focused classification and recovery tests pass, and existing Twitch behavior remains covered. It does not alter scheduler execution, platform enabled settings, popup rendering, or Kick authentication.
