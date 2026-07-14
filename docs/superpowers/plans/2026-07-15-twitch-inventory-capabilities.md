# Twitch Inventory Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind each Twitch Inventory persisted hash to its matching variables, inline fallback, schema validation, and parser mode, while keeping v1 recommended until v2 fixtures prove compatibility.

**Architecture:** An inventory capability object owns the complete query/parser contract. `TwitchAdapter` asks the selected capability to fetch and parse inventory; it never combines constants from different versions.

**Tech Stack:** TypeScript, GraphQL request bodies, Vitest fixtures.

## Global Constraints

- Requires the compatibility-profile foundation plan.
- `twitch-inventory-v1` remains recommended initially.
- `twitch-inventory-v2` remains experimental until fixtures verify its contract under relevant identities.
- A persisted-query miss may use only the selected version's inline fallback.
- No free-form hashes or GraphQL documents in settings.

---

### Task 1: Capture versioned inventory fixtures

**Files:**
- Create: `packages/extension/tests/fixtures/twitch-inventory-v1.json`
- Create: `packages/extension/tests/fixtures/twitch-inventory-v2.json`
- Modify: `packages/extension/tests/parsers.test.ts`

**Interfaces:**
- Produces sanitized, credential-free fixtures containing owned rewards, active progress, claimable state, account linking, and nullable dates.

- [ ] **Step 1: Add fixture-driven failing assertions**

Load both fixtures and assert the same normalized `DropCampaign` invariants: stable campaign/reward IDs, claim instance IDs, owned benefits, and nullable date tolerance.

- [ ] **Step 2: Run parser tests and verify v2 failure or missing capability**

Run: `pnpm --filter @lurkloot/extension test -- parsers.test.ts`

Expected: FAIL on the v2 fixture path or schema mismatch.

- [ ] **Step 3: Commit evidence fixtures separately**

```bash
git add packages/extension/tests/fixtures packages/extension/tests/parsers.test.ts
git commit -m "test(twitch): capture inventory version fixtures"
```

### Task 2: Implement the inventory capability contract

**Files:**
- Create: `packages/core/src/platforms/twitch/inventory/types.ts`
- Create: `packages/core/src/platforms/twitch/inventory/v1.ts`
- Create: `packages/core/src/platforms/twitch/inventory/v2.ts`
- Create: `packages/core/src/platforms/twitch/inventory/factory.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`
- Test: `packages/extension/tests/parsers.test.ts`

**Interfaces:**
- Produces `TwitchInventoryCapability`:

```ts
interface TwitchInventoryCapability {
  readonly id: "twitch-inventory-v1" | "twitch-inventory-v2";
  readonly hash: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly inlineQuery: string;
  parse(response: unknown): DropCampaign[];
}
```

- [ ] **Step 1: Write failing pairing and fallback tests**

For each capability, capture outgoing hash, variables, and inline fallback; assert a persisted-query miss retries with that same object's document and parsed fixture. Assert malformed schema reports the selected capability ID.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts parsers.test.ts`

Expected: FAIL because Inventory constants are global rather than capability-bound.

- [ ] **Step 3: Move v1 and implement verified v2 behavior**

Move the current `d86775d0...` hash, variables, inline query, and current parser into v1 without semantic changes. Add `8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404` to v2 and implement only schema adaptations demonstrated by the sanitized fixture. Do not guess missing fields or broaden unrelated parsing.

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

Assert automatic selects v1, explicit experimental v2 uses v2 hash/parser, and failures include `compatibilityCapability: "twitch-inventory-v2"` without switching back to v1.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts adapters.test.ts`

Expected: FAIL because adapter selection is not wired.

- [ ] **Step 3: Construct the selected capability once per adapter**

Pass `resolvedCompatibility.twitch.inventory` to the exhaustive inventory factory. Keep v2 lifecycle `experimental` and v1 `recommended` until separately approved production evidence justifies a profile change.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts adapters.test.ts parsers.test.ts && pnpm verify`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/compatibility/registry.ts packages/core/src/platforms/twitch/index.ts packages/extension/tests
git commit -m "feat(twitch): select inventory compatibility versions"
```
