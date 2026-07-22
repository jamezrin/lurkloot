# Platform Session Credential Observation Design

## Scope

This specification implements issue #201, the extension-owned browser credential-observation layer for the authentication-health epic in #199. It builds on the safe shared health contracts from #200 and prepares the inputs and recovery trigger needed by the Twitch probe (#202), Kick probe (#203), and scheduler gating (#204).

This issue does not decide whether a present credential is valid, mark a session healthy, interpret authenticated platform responses, or suspend account automation. Credential presence is only a preflight. The later platform probes establish authenticated health, and #204 makes scheduler work depend on that health.

## Goals

- Detect whether Twitch's required `auth-token` and Kick's required `session_token` cookie are available without exposing either value outside the extension boundary.
- Treat `unique_id` as optional Twitch metadata, never as proof of login.
- Distinguish a missing required cookie from a browser cookie lookup failure.
- Invalidate only the affected platform's cached authentication health when a relevant cookie changes.
- Coalesce repeated changes and trigger one platform-only scheduler cycle so later authentication probes and gating can recover automatically.
- Ignore unrelated cookie changes and preserve `@lurkloot/core` as browser-free.

## Credential Availability Contract

The browser-neutral controller dependency will accept a platform and return a value-only result with no credential material:

```ts
type CredentialAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unavailable" };

checkCredentialAvailability?(platform: Platform): Promise<CredentialAvailability>;
```

The contract deliberately uses `unavailable` for lookup failure and contains no error object or arbitrary text. The controller maps these results to the shared authentication-health vocabulary:

| Availability | Controller behavior |
| --- | --- |
| `available` | Continue to `adapter.checkAuthHealth()`; presence alone never yields `healthy`. |
| `missing` | Persist `missing_credentials` with `credentials_missing`; do not call the adapter probe. |
| `unavailable` | Persist `unavailable` with `credential_lookup_failed`; do not call the adapter probe. |

Hosts that omit the dependency preserve the current behavior and call the adapter directly. This keeps the CLI independent of browser cookie observation and avoids forcing browser concepts into core.

The controller applies availability and adapter results through the existing normalization and transition path, so timestamps and durable activity events retain the safe behavior established by #200.

## Extension Credential Provider

`packages/extension/src/core/credentialAvailability.ts` will own the browser implementation behind a small injectable cookie-reader interface. Production wiring passes `browser.cookies.get`; tests pass a deterministic fake.

The provider performs exactly one required lookup per platform:

- Twitch: `https://www.twitch.tv`, cookie name `auth-token`.
- Kick: `https://kick.com`, cookie name `session_token`.

A returned cookie with a non-empty value is `available`. A missing cookie or empty value is `missing`. A rejected lookup is `unavailable`. The provider never returns, stores, logs, hashes, serializes, or attaches the value to an error. It does not read Twitch `unique_id`, because that cookie cannot establish credential availability.

The existing confirm-gated CLI export remains separate. It may continue reading the credential values for its explicitly authorized export operation; the health provider cannot call or reuse the export blob builder.

## Cached-Health Invalidation

The controller will expose `invalidateAuthHealth(platform)`. Under the existing state-mutation lock, it loads current state and replaces only the selected platform's health with `{ status: "checking" }`. Other scheduler state and the other platform's health remain unchanged.

Invalidation is a cache-state change, not a platform-health conclusion. It emits the normal safe authentication transition only when the semantic state changes. Repeated invalidations while already `checking` remain quiet. The method performs no platform request and does not start scheduler work itself.

## Cookie Change Observation

`packages/extension/src/core/credentialObserver.ts` will contain a testable observer coordinator. It receives:

- a cookie-change event source;
- `invalidateAuthHealth(platform)`;
- `recheckPlatform(platform)`;
- injectable timeout functions and debounce duration.

The observer recognizes only these exact pairs:

| Platform | Cookie | Accepted domains |
| --- | --- | --- |
| Twitch | `auth-token` | `twitch.tv` and subdomains represented with or without the cookie API's leading dot |
| Kick | `session_token` | `kick.com` and subdomains represented with or without the leading dot |

Cookie name alone is insufficient: a same-named cookie on an unrelated domain is ignored. Twitch `unique_id`, unrelated Twitch/Kick cookies, and all other domains are ignored.

For each relevant added, removed, or replaced cookie event, the observer immediately invalidates that platform's cached health. It then resets a short per-platform debounce timer. When the timer expires, it calls `controller.tickAndHandOff([platform])`. The scheduler call is platform-scoped and intentionally follows the normal scheduler path: #202/#203 will supply the authenticated probes and #204 will perform health checking and gating within that cycle.

Timers are independent per platform. A burst of Twitch changes becomes one Twitch cycle; a simultaneous Kick burst becomes one separate Kick cycle. A failure from invalidation or the eventual scheduler cycle is contained by the existing controller reporting path and must not create an unhandled rejection in the browser event listener.

The observer returns a disposer that removes its cookie listener and clears pending timers. `background.ts` creates it once for the service-worker lifetime and registers disposal with the WXT background invalidation lifecycle when available.

## Data Flow

```text
browser.cookies.onChanged
  -> exact credential cookie/domain filter
  -> controller.invalidateAuthHealth(platform)
  -> reset that platform's debounce timer
  -> controller.tickAndHandOff([platform])
       -> later #204 invokes controller.checkAuthHealth(platform)
            -> extension credential availability preflight
                 missing / lookup failed -> safe terminal health
                 available -> later #202 or #203 authenticated probe
```

The cookie value is inspected only inside the provider to decide whether it is empty. Cookie-change handling uses only event metadata required for filtering and never reads or forwards `cookie.value`.

## Error Handling and Security

- Cookie lookup rejection maps to `credential_lookup_failed`, not `credentials_missing`.
- No raw lookup error is persisted or reported, because browser error text could contain unexpected details.
- Observer callbacks attach rejection handlers so browser event dispatch cannot produce unhandled promise rejections.
- No credential value enters adapter arguments, controller state, snapshots, activity events, diagnostics, or logs.
- The existing `cookies` permission and Twitch/Kick host permissions are sufficient; this issue adds no permissions.
- The core package receives only the browser-neutral availability enum and imports no WXT or browser globals.

## Testing

Focused deterministic tests will cover:

1. Twitch `auth-token` and Kick `session_token` presence returning `available` without exposing values.
2. Missing and empty required cookies returning `missing`.
3. Cookie lookup rejection returning `unavailable` and mapping to `credential_lookup_failed`.
4. Twitch `unique_id` alone not satisfying the required-credential check.
5. The controller skipping adapter probes for missing credentials and lookup failures, while continuing to the probe for available credentials.
6. Login, logout, and token replacement events invalidating the correct platform.
7. Exact domain/name filtering, including leading-dot domains and unrelated same-name cookies.
8. Repeated changes coalescing into one platform-only scheduler cycle.
9. Independent Twitch and Kick debounce timers.
10. Disposal removing listeners and cancelling pending work.
11. Serialized state, events, diagnostics, and callback arguments containing no credential values.

The implementation will run focused Vitest suites during development, followed by the repository's full `pnpm verify` before completion.

## Out of Scope

- Twitch authenticated GQL classification (#202).
- Kick account probing and security-policy response classification (#203).
- Scheduler blocking, degraded operational state, and automatic resume rules (#204).
- Popup authentication-health presentation (#205).
- CLI authentication-health behavior (#206).
