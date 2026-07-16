# Twitch Heartbeat Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace automatic Twitch tabless watching with bundled Spade v1 for web/extension and Trowel v1 for Android/CLI while retaining the current GQL implementation as an explicit legacy rollback.

**Architecture:** A small heartbeat strategy interface isolates transport-specific payload and request behavior from `TwitchWatcher`. The compatibility resolver selects a strategy; host fetch adapters perform requests so browser restrictions and CLI proxy behavior remain outside strategy logic.

**Tech Stack:** TypeScript, Fetch API, Vitest, WXT extension runtime, Node CLI transports.

## Global Constraints

- Requires the completed compatibility-profile foundation plan.
- Fixed bundled Twitch endpoints only; no user-provided destinations or headers.
- Spade authenticated destinations require HTTPS and `twitch.tv`/`*.twitch.tv` host validation.
- Trowel is valid only with the Android Twitch identity.
- HTTP acceptance does not prove accrual; existing progress reconciliation remains authoritative.
- Preserve GQL v1 only as an explicit legacy capability.

---

### Task 1: Extract the heartbeat strategy boundary

**Files:**
- Create: `packages/core/src/platforms/twitch/heartbeat/types.ts`
- Move/Modify: `packages/core/src/platforms/twitch/watch.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/twitchHeartbeat.test.ts`

**Interfaces:**
- Produces: `TwitchHeartbeatStrategy.tick(context): Promise<HeartbeatResult>`.
- Produces: `TwitchHeartbeatContext` containing channel, stream, viewer, identity, and injected request functions.

- [ ] **Step 1: Write a failing delegation test**

Inject a fake strategy into `TwitchAdapterOptions`, start a tabless channel, tick it, and assert the strategy receives broadcast, channel, game, and viewer identifiers exactly once.

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts`

Expected: FAIL because `TwitchHeartbeatStrategy` and injection do not exist.

- [ ] **Step 3: Extract the interface without changing legacy behavior**

Define:

```ts
export interface TwitchHeartbeatContext {
  channel: ChannelCandidate;
  broadcastId: string;
  channelId: string;
  userId: string;
  gameId?: string;
  gameName?: string;
}
export interface TwitchHeartbeatStrategy {
  readonly id: string;
  tick(context: TwitchHeartbeatContext): Promise<HeartbeatResult>;
}
```

Move current `buildMinuteWatchedEvent` helpers under `heartbeat/`, wrap the existing GQL call as `twitch-heartbeat-gql-v1`, and make `TwitchWatcher` delegate after resolving fresh stream metadata.

- [ ] **Step 4: Run heartbeat and adapter tests**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts adapters.test.ts`

Expected: PASS with legacy behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch packages/extension/tests/twitchHeartbeat.test.ts
git commit -m "refactor(twitch): isolate heartbeat strategies"
```

### Task 2: Implement secure Spade v1

**Files:**
- Create: `packages/core/src/platforms/twitch/heartbeat/spade.ts`
- Create: `packages/core/src/platforms/twitch/heartbeat/hosts.ts`
- Modify: `packages/core/src/platforms/twitch/heartbeat/types.ts`
- Test: `packages/extension/tests/twitchHeartbeat.test.ts`

**Interfaces:**
- Produces: `createSpadeHeartbeat(options): TwitchHeartbeatStrategy`.
- Produces: `isAllowedTwitchUrl(rawUrl): boolean`.

- [ ] **Step 1: Write failing request, cache, retry, and security tests**

Cover inline `spade_url`, settings-bundle fallback, form-urlencoded plain base64 body, expected 204, per-channel cache, eviction plus one resolution retry, and rejection of non-HTTPS/deceptive hosts including `twitch.tv.example.com` and `twitch.tv@evil.example`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts -t Spade`

Expected: FAIL because Spade v1 does not exist.

- [ ] **Step 3: Implement minimal secure Spade behavior**

Resolve only `spade_url`/`beacon_url` values and Twitch-owned settings bundles. Validate every followed URL before sending authentication. Encode `JSON.stringify(buildMinuteWatchedEvent(context))` with standard base64 and send `data=${encodeURIComponent(encoded)}` using `application/x-www-form-urlencoded`. Cache by normalized channel login and retry one fresh resolution after a failed post.

- [ ] **Step 4: Run Spade and boundary tests**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts coreBoundary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch/heartbeat packages/extension/tests/twitchHeartbeat.test.ts
git commit -m "fix(twitch): add secure Spade heartbeats"
```

### Task 3: Implement Android Trowel v1

**Files:**
- Create: `packages/core/src/platforms/twitch/heartbeat/trowel.ts`
- Modify: `packages/cli/src/transport/http.ts`
- Modify: `packages/cli/src/transport/impersonate.ts`
- Test: `packages/extension/tests/twitchHeartbeat.test.ts`
- Test: `packages/cli/tests/transport.test.ts`

**Interfaces:**
- Produces: `createTrowelHeartbeat(options): TwitchHeartbeatStrategy`.
- Consumes injected CLI fetch/transport; it does not construct a separate unproxied client.

- [ ] **Step 1: Write failing Trowel tests**

Assert a standard-base64 event array is posted as `text/plain` to the fixed Trowel endpoint, 2xx is accepted, non-2xx is unhealthy, Android identity is required, and the injected CLI transport performs the request.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts -t Trowel && pnpm --filter @lurkloot/cli test -- transport.test.ts`

Expected: FAIL because Trowel v1 is absent.

- [ ] **Step 3: Implement Trowel through injected transport**

Use the fixed `https://trowel.twitch.tv/track` destination. Reject construction unless host facts say Android. Post `btoa(JSON.stringify(events))` or its runtime-safe shared equivalent as the raw `text/plain` body. Return an unhealthy `HeartbeatResult` on transport rejection without automatically switching capability versions.

- [ ] **Step 4: Run Trowel and CLI tests**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts && pnpm --filter @lurkloot/cli test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch/heartbeat/trowel.ts packages/cli/src/transport packages/extension/tests/twitchHeartbeat.test.ts packages/cli/tests/transport.test.ts
git commit -m "fix(twitch): add Android Trowel heartbeats"
```

### Task 4: Select strategies from resolved compatibility

**Files:**
- Create: `packages/core/src/platforms/twitch/heartbeat/factory.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/cli/src/transport/http.ts`
- Modify: `packages/cli/src/transport/impersonate.ts`
- Test: `packages/extension/tests/twitchHeartbeat.test.ts`

**Interfaces:**
- Produces: `createTwitchHeartbeat(capabilityId, options)` exhaustive factory.
- Consumes resolved `compatibility.twitch.heartbeat` from the foundation.

- [ ] **Step 1: Write failing automatic and rollback selection tests**

Assert extension automatic uses Spade, CLI automatic uses Trowel, and explicit `twitch-heartbeat-gql-v1` uses only GQL. Assert unsupported identifiers cannot reach the factory after resolution.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts`

Expected: FAIL because selection is not wired.

- [ ] **Step 3: Implement exhaustive factory and host wiring**

Use a `switch` over the three registered IDs with a `never` exhaustiveness guard. Pass browser page fetch and beacon fetch adapters to Spade; pass the configured CLI request transport to Trowel; preserve current GQL transport only for legacy selection.

- [ ] **Step 4: Run focused and full verification**

Run: `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts adapters.test.ts backgroundController.test.ts && pnpm verify`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch packages/extension/entrypoints/background.ts packages/cli/src/transport packages/extension/tests
git commit -m "feat(twitch): select versioned heartbeat transports"
```
