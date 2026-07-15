# Kick Claim Task 2 Report

## Status

Complete. Kick claim v2 now suppresses repeated link-required claims per adapter process, persists safe guidance in normalized campaign/reward state, and clears only after a progress response explicitly reports the campaign linked.

## RED

Initial lifecycle command:

```text
pnpm --filter @lurkloot/extension test -- adapters.test.ts backgroundController.test.ts -t "link-required"
```

Result: exit code 1. The new lifecycle test expected one POST, but two claim calls produced two POSTs because suppression was absent.

Affirmative-evidence regression command:

```text
pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "suppresses repeated link-required"
```

Result: exit code 1 after the test seeded stale `accountLinked: true`. An ambiguous refresh incorrectly cleared suppression and produced a second POST, proving normalized last-known state was not sufficient evidence.

## GREEN

Focused lifecycle/controller command:

```text
pnpm --filter @lurkloot/extension test -- adapters.test.ts backgroundController.test.ts -t "link-required"
```

Result: exit code 0; 24 test files passed, 473 tests passed.

Full requested adapter/controller command:

```text
pnpm --filter @lurkloot/extension test -- adapters.test.ts backgroundController.test.ts
```

Result: exit code 0; 24 test files passed, 473 tests passed.

Workspace typechecks:

```text
pnpm typecheck
```

Result: exit code 0 across shared, core, locales, CLI, popup UI, and extension packages.

## Implementation

- Made each `kick-claim-v2` capability instance own a private `${campaign.id}:${reward.id}` suppression map.
- Skips suppressed claims before network I/O and emits the actionable HTTPS diagnostic only when suppression is first learned.
- Stores safe link-required guidance on both campaign and reward state and restores it across ambiguous progress refreshes.
- Clears suppression and guidance only for campaign IDs whose current progress payload explicitly contains `user_app_connected: true`; absent fields and stale normalized `accountLinked` values do not clear it.
- Propagates explicit linked progress into `accountLinked: true` while preserving prior state when the field is absent.
- Lets a newly constructed adapter retry once because suppression is process scoped.
- Applies the same suppression lifecycle to explicit HTTP rejection when safe legacy campaign link metadata proves the account-link requirement.
- Keeps linked/unknown unexpected errors propagating and rejects unsafe legacy guidance URLs.

## Self-review

- Suppression is isolated per v2 capability/adapter; no module singleton leaks state between processes or tests.
- Only exact supported response fields and safe HTTPS URLs become guidance.
- No link is opened automatically and no raw response body is persisted.
- Clearing uses raw affirmative refresh evidence, not a missing field or carried-forward metadata.
- Adapter/controller coverage verifies one POST, one actionable diagnostic, persisted guidance, ambiguous refresh retention, explicit clear, new-process retry, and unexpected-error propagation.
- Compatibility-based v1/v2 adapter selection remains intentionally deferred to Task 4; Task 2 uses the recommended v2 policy directly.

## Concerns

None within Task 2. Task 4 must replace the temporary fixed v2 construction with the resolved compatibility selection without changing v2 instance/session lifetime.

## Blocking finding follow-up: host-scoped state

The original implementation owned suppression in each `KickClaimV2`. Production creates fresh adapters during controller operations, so that map was discarded between ticks even though the cached-adapter controller test remained green.

The fix introduces an injected `KickClaimState` boundary. The extension background host and both CLI transports create exactly one state per host/transport lifetime and pass it through every fresh `KickAdapter` and `createKickClaimCapability` call. Emitters remain adapter/operation scoped, so diagnostics continue to join the current controller event batch. The factory already accepts the state alongside the claim policy ID, allowing Task 4 to select a version without changing state ownership.

Updated regression coverage now:

- constructs fresh controller adapters on every factory call while sharing only `KickClaimState`;
- observes one claim POST and one link-required diagnostic across ambiguous-refresh ticks;
- confirms affirmative `user_app_connected: true` evidence clears shared suppression;
- confirms a separate state permits one retry;
- exercises repeated `createAdapters` calls for both HTTP and impersonated CLI transports.

Follow-up RED:

```text
pnpm --filter @lurkloot/extension test -- adapters.test.ts backgroundController.test.ts -t "link-required|shares link-required"
```

Result: exit code 1. Both new regressions failed with `KickClaimState is not a constructor`, demonstrating the missing injection boundary before production changes.

Follow-up GREEN:

```text
pnpm --filter @lurkloot/extension test -- adapters.test.ts backgroundController.test.ts
```

Result: exit code 0; 24 test files passed, 473 tests passed.

```text
pnpm --filter @lurkloot/cli test -- transport.test.ts impersonate.test.ts
```

Result: exit code 0; 8 test files passed, 81 tests passed.

```text
pnpm typecheck
```

Result: exit code 0 across all workspace typecheck packages.
