# Twitch Inventory Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind the verified Twitch Inventory v1 hash to its variables, inline fallback, schema validation, and parser mode.

**Architecture:** An inventory capability object owns the complete query/parser contract. `TwitchAdapter` asks the selected capability to fetch and parse inventory; it never combines constants from different versions.

**Tech Stack:** TypeScript, GraphQL request bodies, Vitest fixtures.

## Global Constraints

- Requires the compatibility-profile foundation plan.
- `twitch-inventory-v1` remains recommended initially.
- The unrelated TwitchDropsBot Postman hash is intentionally ignored until independent real response evidence exists; no v2 capability is bundled or planned from that source.
- A persisted-query miss may use only the selected version's inline fallback.
- No free-form hashes or GraphQL documents in settings.

---

### Task 1: Capture the verified inventory fixture

**Files:**
- Create: `packages/extension/tests/fixtures/twitch-inventory-v1.json`
- Modify: `packages/extension/tests/parsers.test.ts`

**Interfaces:**
- Produces a sanitized, credential-free fixture containing owned rewards, active progress, claimable state, account linking, and nullable dates.

- [ ] **Step 1: Add fixture-driven failing assertions**

Load the v1 fixture and assert normalized `DropCampaign` invariants: stable campaign/reward IDs, claim instance IDs, owned benefits, account linking, and nullable date tolerance.

- [ ] **Step 2: Run parser tests and verify the fixture contract**

Run: `pnpm --filter @lurkloot/extension test -- parsers.test.ts`

Expected: PASS for the existing verified parser contract.

- [ ] **Step 3: Commit the evidence fixture separately**

```bash
git add packages/extension/tests/fixtures packages/extension/tests/parsers.test.ts
git commit -m "test(twitch): capture inventory v1 fixture"
```

### Task 2: Implement the inventory capability contract

**Files:**
- Create: `packages/core/src/platforms/twitch/inventory/types.ts`
- Create: `packages/core/src/platforms/twitch/inventory/v1.ts`
- Create: `packages/core/src/platforms/twitch/inventory/factory.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`
- Test: `packages/extension/tests/parsers.test.ts`

**Interfaces:**
- Produces `TwitchInventoryCapability`:

```ts
interface TwitchInventoryCapability {
  readonly id: "twitch-inventory-v1";
  readonly hash: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly inlineQuery: string;
  parse(response: unknown): DropCampaign[];
}
```

- [ ] **Step 1: Write failing pairing and fallback tests**

Capture the v1 outgoing hash, variables, and inline fallback; assert a persisted-query miss retries with that same object's document and parsed fixture. Assert malformed schema reports the selected capability ID.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts parsers.test.ts`

Expected: FAIL because Inventory constants are global rather than capability-bound.

- [ ] **Step 3: Move the verified v1 behavior**

Move the current `d86775d0...` hash, variables, inline query, and current parser into v1 without semantic changes. Do not add another version without independent real response evidence, guess missing fields, or broaden unrelated parsing.

- [ ] **Step 4: Run inventory tests**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts parsers.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch/inventory packages/core/src/platforms/twitch/index.ts packages/extension/tests
git commit -m "feat(twitch): version inventory query contracts"
```

### Task 3: Wire resolved selection and lifecycle metadata

**Files:**
- Modify: `packages/core/src/compatibility/registry.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/compatibility.test.ts`
- Test: `packages/extension/tests/adapters.test.ts`

- [ ] **Step 1: Write failing selection tests**

Assert automatic selects v1 and unverified inventory selections warn and resolve to v1.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts adapters.test.ts`

Expected: FAIL because adapter selection is not wired.

- [ ] **Step 3: Construct the selected capability once per adapter**

Pass `resolvedCompatibility.twitch.inventory` to the exhaustive inventory factory and keep v1 `recommended`.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts adapters.test.ts parsers.test.ts && pnpm verify`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/compatibility/registry.ts packages/core/src/platforms/twitch/index.ts packages/extension/tests
git commit -m "feat(twitch): select inventory compatibility versions"
```
