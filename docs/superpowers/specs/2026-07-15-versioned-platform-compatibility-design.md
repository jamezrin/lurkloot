# Versioned Platform Compatibility Profiles

**Date:** 2026-07-15

## Purpose

LurkLoot depends on undocumented Twitch and Kick behavior that can change independently of the public product. Recent reference-project changes show three examples:

- Twitch stopped crediting tabless watch progress through the GraphQL `SendEvents` mutation while continuing to return successful responses.
- Twitch introduced another persisted-query hash and inventory response shape used by a maintained client.
- Kick may reveal an external-account link requirement only when a reward claim fails, even when campaign progress previously appeared linked.

These implementation details need explicit versions, safe rollback, reproducible diagnostics, and configuration in both the CLI and extension Advanced Settings. All compatibility definitions are bundled with a LurkLoot release. LurkLoot will not download compatibility profiles or executable configuration between releases.

## Goals

- Version unstable Twitch and Kick integration capabilities independently.
- Select a recommended bundled profile automatically for each runtime host.
- Allow expert rollback and diagnostic overrides in the CLI and extension UI.
- Prevent unsupported or unsafe low-level combinations.
- Include effective compatibility versions in diagnostics and bug reports.
- Keep endpoint trust, credential handling, and claim-expiry protection as immutable security invariants.

## Non-goals

- Remotely updating compatibility profiles.
- Accepting user-defined endpoints, client IDs, headers, GraphQL documents, hashes, or host allowlists.
- Making every internal constant configurable.
- Adding GrubDrops' persistent ghost-skip behavior without evidence that LurkLoot has the same scheduler failure mode.
- Moving compatibility decisions into the scheduler.

## Considered Approaches

### Independent low-level settings

Expose each transport, endpoint, encoding, query hash, parser, and retry rule separately. This is maximally flexible but permits combinations LurkLoot has never tested and makes support reports difficult to reproduce.

### One global compatibility version

Select a single repository-wide compatibility version. This is simple but couples unrelated Twitch and Kick behavior, forcing unnecessary profile churn.

### Per-platform profiles with capability overrides

Maintain versioned Twitch and Kick profiles composed from independently versioned capabilities. Profiles provide tested combinations, while expert overrides select another bundled capability implementation. This is the selected approach.

## Architecture

`@lurkloot/core` owns an immutable compatibility registry and resolver. The registry contains profile metadata, capability implementations, compatibility constraints, lifecycle status, and recommended defaults. A host supplies runtime facts when it constructs adapters:

- Host kind: extension or CLI.
- Twitch identity class: web or Android.
- Available network transport and proxy behavior.
- Capabilities that are meaningful for that host.

The resolver combines normalized stored settings, runtime facts, and the bundled registry into an immutable effective compatibility configuration. Platform adapters receive resolved strategies through construction options. The scheduler continues to consume only the stable `PlatformAdapter` contract and does not know about endpoints, encodings, query versions, or profile selection.

```text
stored compatibility settings
          +
runtime host facts
          +
bundled compatibility registry
          |
          v
resolved immutable configuration
          |
          v
platform adapter strategies
          |
          v
structured diagnostics and effective-version UI
```

## Settings Contract

The shared settings model gains platform compatibility selections. Exact TypeScript placement may follow existing model boundaries, but the persisted shape is:

```ts
interface CompatibilitySettings {
  twitch: {
    profile: "auto" | TwitchCompatibilityProfileId;
    heartbeatTransport: "auto" | TwitchHeartbeatCapabilityId;
    inventoryQueryVersion: "auto" | TwitchInventoryCapabilityId;
  };
  kick: {
    profile: "auto" | KickCompatibilityProfileId;
    claimLinkHandling: "auto" | KickClaimCapabilityId;
  };
}
```

Profile and capability identifiers are stable, descriptive strings such as `twitch-2026-07`, `twitch-heartbeat-spade-v1`, and `kick-claim-v2`. Dates may identify profile releases; capability identifiers use explicit semantic implementation versions.

`auto` is the default for profiles and every override. It resolves to the newest recommended bundled combination compatible with the current host. An explicit capability selection overrides only that capability within the selected or automatic profile.

The resolver validates the resulting combination. An explicit selection that is unknown, removed, or incompatible is replaced with `auto`, and a visible warning records the original value and resolved replacement. Farming continues with the recommended compatible configuration rather than failing completely.

The CLI JSONC template documents the profile selectors and expert overrides. The extension exposes the same settings in Advanced Settings.

## Profile Registry

Every platform profile records:

- Stable profile identifier.
- Human-readable title and description.
- Lifecycle: `recommended`, `legacy`, or `experimental`.
- Supported host and identity constraints.
- Capability identifiers selected by the profile.
- Optional replacement profile for migration messaging.

Capability implementations are registered separately so a profile can compose them without duplicating behavior. The registry exposes metadata to settings normalization and UI code but does not expose credentials or mutable network destinations.

Old profiles remain available for a limited rollback window. Removal is allowed in a major release. Removed settings normalize to `auto` with a migration warning rather than remaining as inert identifiers.

## Twitch Heartbeat Capability

Initial bundled capability implementations are:

- `twitch-heartbeat-gql-v1`: the legacy gzip/base64 `SendEvents` GraphQL mutation.
- `twitch-heartbeat-spade-v1`: the web Spade beacon transport.
- `twitch-heartbeat-trowel-v1`: the Android Trowel transport.

The recommended Twitch profile resolves heartbeat behavior by runtime identity:

- Extension using the Twitch web identity: `twitch-heartbeat-spade-v1`.
- CLI using the Twitch Android identity: `twitch-heartbeat-trowel-v1`.

The legacy GraphQL implementation remains bundled temporarily for rollback and comparison. A heartbeat capability owns its complete request contract: payload fields, serialization, encoding, headers, response validation, cache behavior, and retry policy. Those details are not separately configurable.

### Spade v1

Spade v1 resolves the beacon URL from the Twitch channel page or its referenced settings bundle, caches it per channel, and evicts and resolves it once after a failed send. Before sending any authenticated request, it requires HTTPS and validates that the destination hostname is `twitch.tv` or a subdomain of `twitch.tv`. Test-only endpoints are injected through test construction and never accepted from persisted settings.

The beacon body uses the transport's tested plain-base64 form encoding and validates the expected no-content response. Browser requests use an extension-safe fetch adapter; CLI requests honor the configured proxy if this capability is ever selected there.

### Trowel v1

Trowel v1 is available only to an Android Twitch identity. It posts the tested base64 event payload as `text/plain` to the fixed Twitch Trowel endpoint through the host's configured transport. It must not claim to be Android when the OAuth token and client identity do not match the Android client.

### Health semantics

An accepted HTTP response proves only transport acceptance. It does not prove that Twitch credited watch progress. Existing progress reconciliation remains the source of accrual evidence. Silent non-accrual contributes to the existing unhealthy-heartbeat behavior and tab fallback where a host supports tabs.

## Twitch Inventory Capability

An inventory capability bundles all mutually dependent details:

- Persisted-query hash.
- Variables.
- Inline fallback document.
- Expected response schema.
- Parser or parser mode.
- Stable capability identifier.

Initial versions are:

- `twitch-inventory-v1`: the current `d86775d0...` persisted hash and current LurkLoot parser.

The unrelated TwitchDropsBot Postman hash is intentionally ignored. No additional inventory capability is bundled, selectable, or advertised until independent real response evidence verifies its schema under LurkLoot's parser requirements.

A persisted-query miss may use the inline fallback belonging to the same capability version. It must not silently combine one version's hash with another version's parser or document. A response that violates the selected schema produces a versioned diagnostic and follows the existing discovery failure behavior.

## Kick Claim Capability

Initial versions are:

- `kick-claim-v1`: determines account-link state only from campaign/progress metadata.
- `kick-claim-v2`: also recognizes account-link requirements returned by the claim endpoint.

The recommended Kick profile selects `kick-claim-v2`. It parses `connect_url` and `connectUrl` from both top-level and nested `data` error objects. A claim rejection containing one of these fields is an actionable link requirement, not a transient platform failure.

The adapter records session-scoped suppression keyed by campaign and reward. Later automatic claim sweeps skip that reward instead of repeatedly posting and logging. A successful progress refresh that provides affirmative changed link evidence clears suppression. Process restart may retry once and relearn the link requirement; this avoids durable stale suppressions without losing the anti-spam behavior during normal operation.

The returned link is stored only as campaign/reward guidance, emitted in a structured diagnostic, and displayed in the popup when relevant. LurkLoot never opens it automatically. The existing host-permission policy still governs whether the extension may navigate to it.

## Non-configurable Safety Behavior

The following remain invariants outside all compatibility profiles:

- HTTPS for authenticated platform requests.
- Fixed source-controlled endpoints and strict destination hostname validation.
- Source-controlled Twitch client identities and headers.
- No arbitrary user-provided query text, hash, endpoint, header, or allowlist.
- Claim-window expiry checks.
- Credential storage and transport boundaries.
- Existing prohibition on cookie export or platform-detection bypasses.

TwitchDropsBot's expired-claim guard therefore requires no new capability or setting because LurkLoot already enforces `claimUntil` before claiming.

GrubDrops' persistent ghost-skip behavior is not incorporated. If LurkLoot later demonstrates the same failure, it will be designed as a scheduler reconciliation capability with its own evidence and lifecycle, not folded into a network compatibility profile.

## Advanced Settings UI

Advanced Settings shows one compatibility profile selector for Twitch and one for Kick. `Automatic` is the recommended default. Each selector displays the profile lifecycle and a concise description.

An initially collapsed Expert Overrides area contains only the capabilities valid for that platform. It shows:

- Stored profile selection.
- Effective resolved profile for the current host.
- Effective capability identifiers.
- `Recommended`, `Legacy`, or `Experimental` badges.
- A warning whenever an explicit override is active.
- A `Restore automatic compatibility` action.

The extension never renders editable text fields for endpoints, hashes, GraphQL documents, client IDs, headers, or host allowlists. Host-inapplicable selections are disabled or omitted. For example, Trowel is not selectable for the web extension identity.

## Diagnostics

Startup emits one concise resolved-configuration diagnostic for each enabled platform. Compatibility-related events include structured context equivalent to:

```ts
interface CompatibilityDiagnosticContext {
  compatibilityProfile: string;
  compatibilityCapability: string;
  compatibilityVersion: string;
}
```

Existing human-readable messages remain useful without inspecting raw context. Settings migration, invalid overrides, legacy selection, request rejection, schema mismatch, beacon refresh, and fallback behavior identify the effective capability version.

Diagnostics must not include OAuth tokens, cookies, complete authenticated response bodies, or other credentials.

## Error Handling

- Unknown or removed persisted identifiers resolve to `auto` and emit a migration warning.
- Host-incompatible explicit overrides resolve to the host's recommended capability and emit a warning.
- Failed Spade sends evict the cached destination and retry one fresh resolution before reporting failure.
- Failed Trowel sends follow the existing heartbeat health and fallback policy without switching transport versions implicitly.
- Inventory persisted-query misses use only the selected version's inline fallback.
- Inventory schema mismatches report the capability version and preserve existing last-known state where applicable.
- Kick link-required claims become guidance plus suppression, not platform-wide backoff.
- Unexpected Kick claim errors keep existing error behavior.

The resolver never changes an explicit valid selection solely because a request failed. Automatic transport switching across profile versions would make failures difficult to reproduce and is outside this design.

## Testing

### Registry and settings

- Resolve automatic Twitch profiles for extension/web and CLI/Android hosts.
- Resolve automatic Kick profiles for both hosts.
- Apply expert overrides without changing unrelated capabilities.
- Normalize unknown, removed, and host-incompatible identifiers to `auto` with warnings.
- Preserve valid explicit legacy selections.
- Verify CLI JSONC and extension settings round trips.

### Heartbeats

- Assert each capability's URL, method, headers, payload fields, encoding, and success status.
- Verify Spade page and settings-bundle resolution, per-channel caching, eviction, and one retry.
- Reject deceptive hosts such as `twitch.tv.example.com`, user-info URL tricks, non-HTTPS URLs, and unrelated domains.
- Verify Trowel is available only for a matching Android identity and honors CLI transport/proxy injection.
- Confirm accepted transport responses do not independently mark progress as earned.
- Preserve legacy GQL behavior behind its explicit capability identifier.

### Inventory

- Pair every bundled persisted hash with its own variables, inline fallback, and fixtures.
- Parse the captured v1 response under its matching capability version; add another version only after independent real response evidence exists.
- Reject or diagnose mismatched schemas without silently switching parser versions.
- Verify inline fallback remains within the selected version.

### Kick claims

- Parse top-level and nested snake-case and camel-case link fields.
- Suppress repeated automatic claim attempts within a process.
- Clear suppression only after affirmative refreshed link evidence.
- Preserve unexpected-error propagation.
- Surface safe link guidance through diagnostics and popup models.

### Boundaries and UI

- Keep `@lurkloot/core` browser-free by injecting host facts and transports.
- Show effective capability versions and lifecycle badges.
- Hide or disable host-inapplicable capabilities.
- Restore all platform compatibility fields to `auto` in one action.
- Never render raw endpoint or query editors.

## Delivery Slices

Implementation is divided into independently reviewable slices:

1. Compatibility registry, resolver, shared/CLI/extension settings, diagnostics metadata, and Advanced Settings UI.
2. Twitch heartbeat capabilities and migration of the existing watcher to the resolved strategy. This is the urgent functional correction.
3. Twitch inventory v1 capability and Kick claim-link v2 behavior.

Each slice must retain passing workspace typechecks and focused tests. The final change should pass `pnpm verify`.

## Success Criteria

- Extension/web automatic mode uses Spade v1; CLI/Android automatic mode uses Trowel v1.
- Users can select bundled legacy or expert capability versions from both CLI configuration and Advanced Settings without supplying arbitrary implementation text.
- Effective profile and capability identifiers appear in diagnostics and the UI.
- Twitch inventory hashes cannot be separated from their matching fallback document and parser contract.
- Kick link-required claim responses stop repeated attempts and expose actionable guidance.
- Invalid or obsolete settings safely return to automatic behavior with a visible warning.
- Security invariants cannot be disabled through compatibility configuration.
