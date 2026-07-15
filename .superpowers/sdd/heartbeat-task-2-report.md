# Heartbeat Task 2 Report: Secure Spade v1

## Status

Implemented secure Spade v1 strategy and helpers without selection/wiring changes.

## RED evidence

- `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts -t Spade`
  - Exit 1: 14 Spade tests failed because `createSpadeHeartbeat` and `isAllowedTwitchUrl` did not exist.
- `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts -t "first post rejects"`
  - Exit 1: the first implementation returned `{ ok: false }` after a rejected post instead of refreshing and retrying once.

## GREEN evidence

- `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts coreBoundary.test.ts`
  - Exit 0: 24 files, 448 tests passed.
- `pnpm --filter @lurkloot/core typecheck`
  - Exit 0.
- `pnpm --filter @lurkloot/extension typecheck`
  - Exit 0 after correcting test mock signatures.

## Coverage and review

- Inline `spade_url` and Twitch-owned settings-bundle `beacon_url` resolution.
- HTTPS-only exact `twitch.tv` or `.twitch.tv` suffix validation, with userinfo and deceptive-host rejection.
- URL validation before authenticated page/settings fetches and beacon posts.
- Plain standard-base64 minute-watched payload in form-urlencoded `data` body; only status 204 succeeds.
- Per-normalized-channel cache, eviction, fresh resolution, and exactly one retry for non-204 or rejected posts.
- Injected text-fetch and post functions preserve the browser-free core boundary.

## Concerns

- Strategy selection and host adapter wiring are intentionally deferred to Task 4.

## Security review follow-up: redirect fail-closed

- Added `redirect: "error"` to the authenticated channel-page GET, settings-bundle GET, and Spade beacon POST so Fetch cannot follow a validated Twitch URL to an untrusted origin with credentials or request body.
- Added focused coverage asserting all three request initializers forbid redirects and that rejected redirect fetches remain failures after the existing single refresh retry.

### RED evidence

- `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts -t "redirect"`
  - Exit 1: `forbids redirects on authenticated page, settings, and beacon requests` failed because the page request init lacked `redirect: "error"` (449 passed, 1 failed across 24 files).

### GREEN evidence

- `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts -t "redirect"`
  - Exit 0: 24 files, 450 tests passed.
- `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts coreBoundary.test.ts`
  - Exit 0: 24 files, 450 tests passed.
- `pnpm --filter @lurkloot/extension test`
  - Exit 0: 24 files, 450 tests passed.
- `pnpm --filter @lurkloot/core typecheck`
  - Exit 0 (`tsc --noEmit`).
- `pnpm --filter @lurkloot/extension typecheck`
  - Exit 0 (`tsc --noEmit`).

### Concerns

- None for this follow-up; cache eviction and exactly-one-refresh retry semantics are unchanged.
