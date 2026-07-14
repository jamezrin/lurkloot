# Foundation Task 3 Report

## Status

Implemented host-specific compatibility resolution and structured effective-compatibility diagnostics without changing heartbeat, inventory, or claim behavior.

## RED

### Controller construction and diagnostic contract

Added controller tests that require adapter construction to receive the loaded settings and return both adapters and the resolver result. Added assertions for:

- Extension/web resolution (`twitch-heartbeat-spade-v1`).
- One structured diagnostic per enabled platform.
- No duplicate diagnostic on unchanged subsequent ticks.
- A new diagnostic when the effective Twitch heartbeat selection changes.
- No credential-like `auth-token` content in emitted events.

Command:

```text
pnpm --filter @lurkloot/extension test -- compatibility.test.ts backgroundController.test.ts
```

Observed failure: exit 1. The controller invoked the factory without settings and expected a raw adapter record, causing `Cannot read properties of undefined (reading 'compatibility')`; the structured diagnostic assertions also failed. This confirmed the new contract was absent.

### Paused startup diagnostic

Added a separate test requiring startup diagnostics even when farming is paused.

Command:

```text
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Observed failure: exit 1. `handleStartup()` published no events, confirming paused startup did not report effective compatibility.

## GREEN

- Extended `DiagnosticEvent` with optional `compatibilityProfile`, `compatibilityCapability`, and `compatibilityVersion` fields.
- Changed controller adapter construction to return adapters plus `CompatibilityResolution` for the current settings load.
- Added controller-level de-duplication keyed by effective profile/capability and restricted diagnostics to enabled platforms.
- Published compatibility diagnostics during startup, including paused startup, and when adapter construction observes an effective selection change.
- Resolved extension settings with `{ host: "extension", twitchIdentity: "web" }`.
- Resolved both CLI transports with `{ host: "cli", twitchIdentity: "android" }` and forwarded engine settings through the CLI runtime.
- Added CLI transport coverage asserting automatic Android selection resolves to `twitch-heartbeat-trowel-v1`.
- Kept selected versions as metadata only; no heartbeat, inventory, or claim implementation branches were added.

Final verification:

```text
pnpm --filter @lurkloot/extension test -- compatibility.test.ts backgroundController.test.ts
# 22 files passed; 426 tests passed

pnpm --filter @lurkloot/cli test -- transport.test.ts impersonate.test.ts
# 8 files passed; 70 tests passed

pnpm typecheck
# all 7 workspace package typechecks passed

git diff --check
# passed
```

## Self-review

- Diagnostics contain only source-controlled profile/capability identifiers and a fixed message; no credentials, headers, cookies, or response bodies are referenced.
- Unchanged effective selections are reported once per controller lifetime; enabling a previously disabled platform or changing an effective selection emits its diagnostic.
- Host resolution occurs once for each adapter construction using the already loaded settings passed by the controller.
- Existing static CLI `adapters` remain available for discovery commands and use default automatic settings; runtime adapter construction uses the actual engine settings.
- Scope expanded only where required by the contract: shared event typing, CLI transport interface/runtime forwarding, and CLI transport coverage.

## Concerns

The original implementation did not emit resolver warnings; this review finding is addressed below.

## Review Fixes

- Resolver warnings now emit deduplicated warning diagnostics using fixed platform/field wording and only the bundled resolved identifier. Arbitrary persisted `requested` text is never interpolated.
- Twitch effective-change dedupe now includes profile, heartbeat, and inventory; diagnostics carry the complete capability list. Kick dedupe continues to include profile and claim.
- `TwitchAdapterOptions` and the Kick adapter construction boundary now accept typed resolved compatibility metadata. The extension, HTTP CLI transport, and impersonated CLI transport resolve first and inject their platform selections without switching runtime behavior.
- Added regressions for hostile unknown selections, host-incompatible selections, inventory-only changes, extension option injection, and both CLI transport injection paths.

### Review-fix RED evidence

```text
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
# exit 1: 2 failed, 426 passed
# inventory-only change expected 2 Twitch compatibility diagnostics but received 1
# credential-safe warning assertion found no resolver warning event
```

### Review-fix final verification

```text
pnpm --filter @lurkloot/extension test -- compatibility.test.ts backgroundController.test.ts
# 22 files passed; 430 tests passed

pnpm --filter @lurkloot/cli test -- transport.test.ts impersonate.test.ts
# 8 files passed; 71 tests passed

pnpm typecheck
# all 7 workspace package typechecks passed

git diff --check
# passed
```

### Review-fix concerns

None blocking. Compatibility metadata remains observational only; capability-based request behavior is intentionally deferred.
