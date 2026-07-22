# Platform Authentication Health Contracts Design

## Scope

This specification implements issue #200, the browser-neutral foundation for the extension authentication-health epic in #199. It defines safe shared state, normalization, adapter and controller boundaries, and durable transition events. It does not read browser cookies, probe Twitch or Kick, gate scheduler work, or render popup status; those behaviors remain in issues #201 through #205.

## Goals

- Represent Twitch and Kick authentication health explicitly without exposing credentials or authenticated response content.
- Give adapters and the controller a host-neutral contract that does not import WXT or browser globals into `@lurkloot/core`.
- Preserve safe authentication health in scheduler state and normalize older or malformed persisted documents.
- Distinguish missing credentials, rejected credentials, security-policy blocking, credential lookup failures, platform outages, and network failures.
- Produce durable, non-diagnostic activity events for meaningful authentication transitions.

## Shared Contract

`@lurkloot/shared/models` will define:

```ts
export type PlatformAuthStatus =
  | "checking"
  | "healthy"
  | "missing_credentials"
  | "invalid_credentials"
  | "blocked"
  | "unavailable";

export type PlatformAuthReasonCode =
  | "credentials_missing"
  | "credentials_rejected"
  | "security_policy_blocked"
  | "credential_lookup_failed"
  | "platform_unavailable"
  | "network_unavailable";

export type PlatformAuthMessageKey =
  | "authChecking"
  | "authHealthy"
  | "authMissingCredentials"
  | "authInvalidCredentials"
  | "authSecurityPolicyBlocked"
  | "authCredentialLookupFailed"
  | "authPlatformUnavailable"
  | "authNetworkUnavailable";

export interface PlatformAuthMessage {
  key: PlatformAuthMessageKey;
  values?: Partial<Record<"reference", string | number>>;
}

export interface PlatformAuthHealth {
  status: PlatformAuthStatus;
  checkedAt?: string;
  reasonCode?: PlatformAuthReasonCode;
  message?: PlatformAuthMessage;
}
```

`SchedulerState` will gain `authHealth: Record<Platform, PlatformAuthHealth>`. Both platforms default to `{ status: "checking" }`, regardless of whether the platform is enabled. This means “not checked” without asserting that a disabled platform is healthy or unhealthy. The optional `checkedAt` timestamp appears only after an actual health result.

The reason/status combinations are constrained as follows:

| Status | Permitted reason codes |
| --- | --- |
| `checking` | none |
| `healthy` | none |
| `missing_credentials` | `credentials_missing` |
| `invalid_credentials` | `credentials_rejected` |
| `blocked` | `security_policy_blocked` |
| `unavailable` | `credential_lookup_failed`, `platform_unavailable`, `network_unavailable` |

Messages are presentation metadata, not arbitrary error text. A message key must be one of the enumerated keys and must correspond to the status/reason pair. The only initial interpolation field is `reference`, reserved for a platform-supplied safe troubleshooting identifier such as Kick's security-policy reference. Message values are limited to finite numbers and bounded strings; objects, arrays, and arbitrary field names are rejected.

## Normalization and Persistence

`@lurkloot/core/defaults` will own a pure `normalizePlatformAuthHealth` function and use it from `mergeSchedulerState`. This keeps normalization browser-free and shared by extension and CLI storage hosts.

Normalization constructs a fresh allowlisted object instead of spreading persisted input. It accepts only:

- a known status;
- a valid status/reason combination;
- a real ISO-8601 timestamp that round-trips through `Date`;
- a known message key compatible with the normalized health result;
- allowlisted primitive message values within explicit size limits.

Unknown statuses or structurally invalid records fall back to `{ status: "checking" }`. Invalid optional fields are omitted without discarding an otherwise valid status. Extra fields—including token, cookie, headers, response, URL, and arbitrary diagnostic properties—are never copied. Existing installations with no `authHealth` slice receive the two default `checking` records on load. Saving the normalized state persists this canonical shape through the existing storage path; no separate schema version is needed for scheduler state.

## Adapter and Controller Boundaries

`PlatformAdapter` will add:

```ts
checkAuthHealth(): Promise<PlatformAuthHealth>;
```

The method accepts no credentials. Each host retains credential access inside its adapter construction boundary; the shared result contains only normalized safe metadata. Twitch and Kick implementations are deliberately deferred to #202 and #203. Until those issues land, existing adapters return `checking`, preserving behavior while making the contract compile across all hosts and tests.

The controller will expose a focused state-transition helper that:

1. normalizes the adapter result;
2. compares semantic fields (`status`, `reasonCode`, and safe message metadata) with the previous health record;
3. saves the updated scheduler state, including a newer `checkedAt` when supplied; and
4. emits a durable activity event only when semantic health changes.

Timestamp-only refreshes update state but do not create activity noise. The helper is independent of scheduler gating; #204 will decide when probes run and when account-dependent automation is suspended.

## Durable Activity Events

`@lurkloot/shared/events` will add:

```ts
type AuthHealthChangedData = {
  from: PlatformAuthStatus;
  to: PlatformAuthStatus;
  reason?: PlatformAuthReasonCode;
};

type AuthHealthChangedEvent = {
  category: "activity";
  code: "auth_health_changed";
  level: "info" | "warn" | "error";
  platform: Platform;
  message?: never;
  data: AuthHealthChangedData;
};
```

The level is `info` for transitions to `checking` or `healthy`, `warn` for missing/invalid credentials or temporary unavailability, and `error` for security-policy blocking. The event excludes message interpolation values, troubleshooting references, raw error text, response data, and timestamps. Existing activity persistence records it even when diagnostic logging is disabled.

## Security Invariants

- No token, cookie value, password, authorization header, authenticated response body, or complete request URL may enter `SchedulerState`, runtime snapshots, activity events, diagnostics, or logs through this contract.
- Normalization is an allowlist reconstruction, not a blacklist or object spread.
- Adapter inputs do not carry credentials through core APIs.
- Troubleshooting references are bounded, plain scalar values and are omitted from durable activity events.
- `@lurkloot/core` remains free of WXT imports and browser globals.

## Testing

Focused deterministic tests will cover:

- defaults for new and existing scheduler documents;
- valid health records round-tripping through `mergeSchedulerState`;
- fallback for unknown statuses and malformed records;
- removal of invalid reason/status combinations, timestamps, message keys, message values, and extra fields;
- representative secret-bearing fields being absent from normalized/serialized state;
- the adapter method's browser-neutral return contract;
- one durable transition event for status or reason changes;
- no event for timestamp-only refreshes;
- event levels and the absence of message values, references, and diagnostic content;
- continued enforcement of the existing core browser-boundary test.

Tests use fixed timestamps and in-memory mocked storage/adapters. They make no live Twitch, Kick, cookie, or browser calls.

## Delivery Boundary

Issue #200 is complete when the shared contracts, safe state normalization/defaults, adapter/controller transition boundary, activity event, and focused tests are merged. The platform-specific implementations may still report `checking`; operational probing and recovery begin in #201–#204, and user-facing rendering begins in #205.
