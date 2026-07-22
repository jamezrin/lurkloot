# Kick Authentication and Page-Context Error Design

## Goal

Implement issue #203 by making Kick authentication health authoritative and by preserving safe diagnostics when Kick or its security policy rejects either the extension service worker or its fallback page context.

Authentication must be based on an authenticated account identity, never on public campaign discovery or the mere presence of a completed `kick.com` document.

## Existing Context

The controller already checks whether the browser has a `session_token` before calling the platform adapter. A missing cookie therefore maps to `missing_credentials` without exposing the cookie value. The shared authentication-health contract already supports `healthy`, `invalid_credentials`, `blocked`, and `unavailable`, including a bounded troubleshooting `reference`.

The remaining gaps are:

- `KickAdapter.checkAuthHealth()` currently returns `checking` without probing Kick.
- background and page-context fetch failures lose structured HTTP metadata;
- page-context acquisition accepts any completed document on the correct origin, including a JSON security-policy response;
- the current background fetch treats every HTTP 403 as a WAF block and discards Kick's safe reference.

## Authentication Probe

`KickAdapter.checkAuthHealth()` will request `GET https://kick.com/api/v1/user` through its injected `PageFetcher`. This is an authenticated account endpoint and is independent of public drops campaign discovery.

A successful response reports `healthy` only when it contains a non-empty identity. Accepted identity evidence is a finite/string `id` or a non-empty `username`/`slug`, either at the response root or in a nested `user` object. A 2xx JSON response without identity is not healthy; it is classified as rejected credentials because it does not prove an authenticated account.

The controller remains responsible for the preflight cookie-presence distinction:

- no `session_token`: `missing_credentials` with `credentials_missing`;
- cookie present and authenticated identity returned: `healthy`;
- cookie present but rejected, expired, or response lacks identity: `invalid_credentials` with `credentials_rejected`;
- security-policy rejection: `blocked` with `security_policy_blocked` and an optional safe reference;
- network failure or ordinary platform failure: `unavailable` with `network_unavailable` or `platform_unavailable`.

All completed probe results include `checkedAt`.

## Sanitized Fetch Failures

Introduce a shared error representation in the browser-free core fetch layer. It carries only:

- a bounded numeric HTTP status when available;
- a normalized, bounded reason suitable for classification;
- a bounded string or finite numeric reference when Kick provides one;
- a coarse failure kind such as authentication rejection, security-policy block, HTTP failure, invalid response, or network failure.

The error must not carry request headers, cookies, tokens, authorization values, URLs containing query secrets, or complete response bodies. Its human-readable message is generated from the safe fields.

Both `fetchKickInBackgroundWith` and the injected page-fetch path will convert failures to this representation. The injected function cannot throw a custom class across the browser serialization boundary reliably, so it will return a serializable success/error envelope. The extension-side wrapper reconstructs the typed error before returning to the adapter.

The exact response

```json
{
  "error": "Request blocked by security policy.",
  "reference": "9e4db7e3"
}
```

is classified as a security-policy block and retains only `9e4db7e3`. HTTP status and status text may be retained as sanitized metadata, but the complete body is discarded.

An HTTP 401 is an authentication rejection. An HTTP 403 is a security-policy block only when the sanitized response reason indicates Kick's security policy or blocking; otherwise it remains an authentication/HTTP rejection as appropriate. Network/CORS rejection from the service worker still triggers the existing page fallback, but if the page path also fails, its final structured failure determines authentication guidance.

## Page-Context Validation

Origin and load completion remain necessary but are no longer sufficient to reuse a Kick page context. Before accepting a completed `kick.com` tab, the browser adapter will execute a bounded validation in that tab which confirms it is an HTML Kick application context rather than a JSON error document or challenge response.

Validation is intentionally independent of login: a legitimate logged-out Kick page is a usable page context, while authentication is decided only by `/api/v1/user`. This preserves the distinction between:

- usable page context plus no credentials: login guidance;
- unusable/security-policy-blocked browser profile: browser/profile security guidance.

If a retained or user tab fails validation, acquisition forgets or closes managed state using the existing lifecycle rules and opens/retries a replacement context. A later valid document can be accepted, allowing successful recovery without restarting the extension.

## Data Flow

1. The controller checks `session_token` availability.
2. If present, it calls `KickAdapter.checkAuthHealth()`.
3. The adapter probes `/api/v1/user` through `createKickFetcher`.
4. The service-worker request either succeeds, yields a sanitized failure, or triggers page fallback.
5. Page acquisition validates the Kick document before executing the request.
6. The injected request returns either JSON data or a sanitized error envelope.
7. The wrapper reconstructs a typed safe error.
8. The adapter maps identity or error classification to `PlatformAuthHealth`.
9. Existing normalization and UI localization render distinct login, invalid-session, blocked-profile, and unavailable guidance.

## Testing

Focused deterministic Vitest coverage will include:

- controller preflight maps a missing `session_token` to `missing_credentials` without calling the adapter;
- `/api/v1/user` with root or nested valid identity reports `healthy`;
- 401, expired/rejected token responses, and identity-free 2xx JSON report `invalid_credentials`;
- the exact security-policy JSON reports `blocked` and preserves `9e4db7e3`;
- public campaign responses cannot produce `healthy`;
- background and page fetch paths retain safe status, reason, and reference metadata while excluding secrets and full bodies;
- a completed JSON error document is rejected as a Kick page context;
- a blocked context followed by a valid Kick document recovers successfully;
- existing page-context retention, lifecycle, and fallback tests remain passing.

Repository verification will run focused tests during development, then `pnpm typecheck`, `pnpm test`, and the broader verification appropriate to the changed extension/core boundary.

## Scope Boundaries

This change does not persist or log Kick credentials, export cookies, add browser permissions, alter public campaign parsing, or change Twitch authentication. It does not attempt to bypass Kick's security policy. It only detects the condition, retains safe troubleshooting metadata, and gives the user accurate guidance.
