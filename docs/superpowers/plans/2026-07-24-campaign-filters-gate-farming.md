# Campaign Filters Gate Farming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the campaign filters decide what gets farmed, not just what is shown, renaming `campaignVisibility` to `campaignFilters` and moving it into the engine contract.

**Architecture:** One shared categorisation (`packages/shared/src/campaignFilters.ts`) feeds two predicates — a farming predicate the scheduler's `isEligible` calls, and a display predicate the popup calls. Only `notLinked` and `subscription` gate farming; `expired`, `finished`, `upcoming` and `excluded` stay display-only. A schema v1 → v2 migration renames the persisted key.

**Tech Stack:** TypeScript (strict, ESM), pnpm workspaces, Vitest, React (popup), WXT (extension shell).

**Spec:** `docs/superpowers/specs/2026-07-24-campaign-filters-gate-farming-design.md`

---

## Conventions for every task

- Work in the existing worktree `.worktrees/campaign-filters-gate-farming` on branch `feat/campaign-filters-gate-farming`. Do not work in the main checkout.
- Run commands from the worktree root unless a task says otherwise.
- Code style: strict TypeScript, ES modules, two-space indent, double quotes, semicolons, camelCase functions/variables, PascalCase types/components. `type` imports for types.
- `packages/core` must never import WXT or touch browser globals; `packages/extension/tests/coreBoundary.test.ts` enforces this.
- Commit after each task with Conventional Commits.
- Tests live in `packages/extension/tests/` even when they exercise `packages/shared` or `packages/core`.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/models.ts` | Split `CampaignFilterKey` into farming/display halves; move the setting into `EngineSettings` |
| `packages/shared/src/campaignFilters.ts` (new) | Categorisation plus the farming and display predicates — the single source of truth |
| `packages/shared/src/settings.ts` | Defaults, normalization, patch shape under the new name |
| `packages/shared/src/settingsSchema.ts` | v1 → v2 rename migration |
| `packages/core/src/core/scheduler.ts` | `isEligible` consults the farming predicate; new `noEligibleCampaignReason` branch |
| `packages/cli/src/settings.ts` | Stop rejecting the key as extension-only |
| `packages/cli/src/runtime/status.ts` | Name the filter when it suppresses campaigns |
| `packages/popup-ui/src/viewModels.ts` | Re-export the moved predicates; drop the local copies |
| `packages/popup-ui/src/constants.ts` | Split the pill list into farming and display groups |
| `packages/popup-ui/src/settingsControls.tsx` | Render the two labelled groups |
| `packages/popup-ui/src/settingsRegistry.tsx` | Renamed registry id and message keys |
| `packages/popup-ui/src/Popup.tsx` | Pass `settings.campaignFilters` to the display predicate |
| `packages/locales/messages/*.json` | Four new keys in all 11 catalogs |
| `docs/architecture.md` | Document the setting group and the new migration |

---

### Task 1: Split the filter key type

**Files:**
- Modify: `packages/shared/src/models.ts:198`
- Test: `packages/extension/tests/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/extension/tests/settings.test.ts`:

```ts
import { FARMING_FILTER_KEYS, DISPLAY_FILTER_KEYS } from "@lurkloot/shared/campaignFilters";

describe("campaign filter keys", () => {
  it("separates the keys that gate farming from the display-only ones", () => {
    expect(FARMING_FILTER_KEYS).toEqual(["notLinked", "subscription"]);
    expect(DISPLAY_FILTER_KEYS).toEqual(["upcoming", "expired", "excluded", "finished"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts -t "separates the keys"`
Expected: FAIL — cannot resolve `@lurkloot/shared/campaignFilters`.

- [ ] **Step 3: Split the type**

In `packages/shared/src/models.ts`, replace line 198:

```ts
export type CampaignFilterKey = "notLinked" | "subscription" | "upcoming" | "expired" | "excluded" | "finished";
```

with:

```ts
// Filter keys that gate farming: the engine's isEligible consults exactly these.
export type FarmingFilterKey = "notLinked" | "subscription";
// Filter keys that only decide what the Drops list shows. `excluded` is here
// deliberately: exclusion is already enforced for farming by excludedCampaignIds,
// so a farming key named `excluded` would have to mean "farm what I excluded".
export type DisplayFilterKey = "upcoming" | "expired" | "excluded" | "finished";
export type CampaignFilterKey = FarmingFilterKey | DisplayFilterKey;
```

- [ ] **Step 4: Create the key lists**

Create `packages/shared/src/campaignFilters.ts`:

```ts
import type { CampaignFilterKey, DisplayFilterKey, FarmingFilterKey } from "./models";

export const FARMING_FILTER_KEYS: FarmingFilterKey[] = ["notLinked", "subscription"];
export const DISPLAY_FILTER_KEYS: DisplayFilterKey[] = ["upcoming", "expired", "excluded", "finished"];
export const CAMPAIGN_FILTER_KEYS: CampaignFilterKey[] = [...FARMING_FILTER_KEYS, ...DISPLAY_FILTER_KEYS];
```

- [ ] **Step 5: Register the subpath export**

`@lurkloot/shared` has no barrel file — every module is reached through an explicit
subpath in its `exports` map, so the new file is unimportable until it is listed. In
`packages/shared/package.json`, add to `exports`, after `"./categories"`:

```json
    "./campaignFilters": "./src/campaignFilters.ts",
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts -t "separates the keys"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/campaignFilters.ts packages/shared/package.json packages/extension/tests/settings.test.ts
git commit -m "refactor(shared): split campaign filter keys by farming meaning"
```

---

### Task 2: Move the categorisation and predicates into shared

`campaignFilterCategories`, `isCampaignExpired` and `isCampaignFinished` currently live in `packages/popup-ui/src/viewModels.ts:22-50`. They move to `campaignFilters.ts` so the engine can use the same categorisation.

**Files:**
- Modify: `packages/shared/src/campaignFilters.ts`
- Modify: `packages/popup-ui/src/viewModels.ts:22-50`
- Test: `packages/extension/tests/campaignFilters.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/campaignFilters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  campaignFilterCategories,
  campaignPassesFarmingFilters,
  isCampaignVisible,
} from "@lurkloot/shared/campaignFilters";
import type { CampaignFilterKey, DropCampaign } from "@lurkloot/shared/models";

const ALL_ON: Record<CampaignFilterKey, boolean> = {
  notLinked: true,
  subscription: true,
  upcoming: true,
  expired: true,
  excluded: true,
  finished: true,
};

function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "campaign",
    platform: "kick",
    name: "Campaign",
    status: "active",
    rewards: [{
      id: "reward",
      name: "Reward",
      requiredMinutes: 30,
      requirement: "watch",
      isWatchBased: true,
      watchedMinutes: 0,
      status: "locked",
    }],
    connectionUrls: [],
    ...overrides,
  } as DropCampaign;
}

describe("campaignPassesFarmingFilters", () => {
  it("rejects an unlinked campaign when the notLinked filter is off", () => {
    const filters = { ...ALL_ON, notLinked: false };
    expect(campaignPassesFarmingFilters(campaign({ accountLinked: false }), filters)).toBe(false);
    expect(campaignPassesFarmingFilters(campaign({ accountLinked: true }), filters)).toBe(true);
  });

  it("ignores the display-only keys, including excluded", () => {
    const filters = { ...ALL_ON, expired: false, finished: false, upcoming: false, excluded: false };
    expect(campaignPassesFarmingFilters(campaign(), filters)).toBe(true);
  });

  it("does not inherit the claimable-reward escape hatch", () => {
    const claimable = campaign({
      accountLinked: false,
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimable",
      }],
    });
    const filters = { ...ALL_ON, notLinked: false };
    expect(isCampaignVisible(claimable, filters, new Set())).toBe(true);
    expect(campaignPassesFarmingFilters(claimable, filters)).toBe(false);
  });
});

describe("campaignFilterCategories", () => {
  it("tags an excluded campaign", () => {
    expect(campaignFilterCategories(campaign(), new Set(["campaign"]))).toContain("excluded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/campaignFilters.test.ts`
Expected: FAIL — `campaignPassesFarmingFilters` is not exported.

- [ ] **Step 3: Implement the module**

Append to `packages/shared/src/campaignFilters.ts`:

```ts
import type { DropCampaign } from "./models";
import { campaignHasSubscriptionRewards } from "./rewards";

// No campaign is excluded when the question is "may the engine farm this?" —
// exclusion is enforced separately by excludedCampaignIds in isEligible.
const NO_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

export function isCampaignExpired(campaign: DropCampaign): boolean {
  if (campaign.status === "expired") return true;
  return hasCampaignEnded(campaign);
}

// Shared with the scheduler so "has this ended" has one definition.
export function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

export function isCampaignFinished(campaign: DropCampaign): boolean {
  if (campaign.status === "completed") return true;
  return campaign.rewards.length > 0 && campaign.rewards.every((reward) => reward.status === "claimed");
}

export function campaignFilterCategories(campaign: DropCampaign, excludedIds: ReadonlySet<string>): CampaignFilterKey[] {
  const categories: CampaignFilterKey[] = [];
  if (excludedIds.has(campaign.id)) categories.push("excluded");
  if (campaign.accountLinked === false) categories.push("notLinked");
  if (campaignHasSubscriptionRewards(campaign)) categories.push("subscription");
  if (isCampaignFinished(campaign)) categories.push("finished");
  else if (isCampaignExpired(campaign)) categories.push("expired");
  else if (campaign.status === "upcoming") categories.push("upcoming");
  return categories;
}

// What the engine asks. Takes no excludedIds on purpose: the only keys it reads
// are notLinked and subscription, and isEligible rejects excluded campaigns on
// its own line. Threading exclusions through here would imply this filter has an
// opinion about them.
export function campaignPassesFarmingFilters(
  campaign: DropCampaign,
  filters: Record<CampaignFilterKey, boolean>,
): boolean {
  return campaignFilterCategories(campaign, NO_EXCLUSIONS)
    .filter((key): key is FarmingFilterKey => (FARMING_FILTER_KEYS as CampaignFilterKey[]).includes(key))
    .every((key) => filters[key]);
}

// What the popup asks. A claimable reward always stays visible so the user can
// claim it; that escape hatch must never reach the farming predicate.
export function isCampaignVisible(
  campaign: DropCampaign,
  filters: Record<CampaignFilterKey, boolean>,
  excludedIds: ReadonlySet<string>,
): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  return campaignFilterCategories(campaign, excludedIds).every((key) => filters[key]);
}
```

Merge the `import type` line at the top of the file so there is exactly one:

```ts
import type { CampaignFilterKey, DisplayFilterKey, DropCampaign, FarmingFilterKey } from "./models";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/campaignFilters.test.ts`
Expected: PASS

- [ ] **Step 5: Re-export from the popup and delete the local copies**

In `packages/popup-ui/src/viewModels.ts`, delete `isCampaignExpired`, `isCampaignFinished`, `campaignFilterCategories` and `isCampaignVisible` (lines 22-50), and add near the top:

```ts
export {
  campaignFilterCategories,
  isCampaignExpired,
  isCampaignFinished,
  isCampaignVisible,
} from "@lurkloot/shared/campaignFilters";
```

Then add an import for the two predicates `campaignLifecycleState` still calls:

```ts
import { isCampaignExpired, isCampaignFinished } from "@lurkloot/shared/campaignFilters";
```

- [ ] **Step 6: Run the popup suites**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/subscriptionDropsView.test.ts tests/dropsView.test.tsx`
Expected: FAIL — `isCampaignVisible` is called with `settings` rather than the filter record. Leave it failing; Task 7 fixes the call sites.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/campaignFilters.ts packages/popup-ui/src/viewModels.ts packages/extension/tests/campaignFilters.test.ts
git commit -m "refactor(shared): move campaign filter predicates into shared"
```

---

### Task 3: Move the setting into the engine contract

**Files:**
- Modify: `packages/shared/src/models.ts` (`EngineSettings`, `ExtensionSettings`)
- Modify: `packages/shared/src/settings.ts:5`, `:10-19`, `:85-92`, `:177`, `:215-217`, `:271-274`
- Test: `packages/extension/tests/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/extension/tests/settings.test.ts`:

```ts
import { DEFAULT_ENGINE_SETTINGS, mergeEngineSettings } from "@lurkloot/shared/settings";

describe("campaignFilters in the engine contract", () => {
  it("defaults every filter key on except expired and excluded", () => {
    expect(DEFAULT_ENGINE_SETTINGS.campaignFilters).toEqual({
      notLinked: true,
      subscription: true,
      upcoming: true,
      expired: false,
      excluded: false,
      finished: true,
    });
  });

  it("normalizes a partial filter record through the engine merge", () => {
    const merged = mergeEngineSettings({ campaignFilters: { notLinked: false } } as never);
    expect(merged.campaignFilters.notLinked).toBe(false);
    expect(merged.campaignFilters.subscription).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts -t "campaignFilters in the engine contract"`
Expected: FAIL — `campaignFilters` does not exist on `DEFAULT_ENGINE_SETTINGS`.

- [ ] **Step 3: Move the property between the interfaces**

In `packages/shared/src/models.ts`, delete this from `ExtensionSettings`:

```ts
  // Which campaign states are shown in the Drops list. See CampaignFilterKey.
  campaignVisibility: Record<CampaignFilterKey, boolean>;
```

and add to `EngineSettings`, after `excludedCampaignIds`:

```ts
  // Which campaign states are farmed and which are shown. FarmingFilterKey
  // entries gate eligibility; DisplayFilterKey entries only affect the UI.
  campaignFilters: Record<CampaignFilterKey, boolean>;
```

- [ ] **Step 4: Update defaults, normalization and the patch type**

In `packages/shared/src/settings.ts`:

Delete the local `CAMPAIGN_FILTER_KEYS` on line 5 and import the shared one:

```ts
import { CAMPAIGN_FILTER_KEYS } from "./campaignFilters";
```

Change `SettingsPatch` (lines 10 and 19):

```ts
export type SettingsPatch = Partial<Omit<ExtensionSettings, "platform" | "compatibility" | "campaignFilters">> & {
```

```ts
  campaignFilters?: Partial<ExtensionSettings["campaignFilters"]>;
```

Move the default block out of `DEFAULT_SETTINGS` and into `DEFAULT_ENGINE_SETTINGS`, keeping the values:

```ts
  campaignFilters: {
    notLinked: true,
    subscription: true,
    upcoming: true,
    expired: false,
    excluded: false,
    finished: true,
  },
```

In `mergeEngineSettings`, add after `excludedCampaignIds`:

```ts
    campaignFilters: normalizeCampaignFilters(value?.campaignFilters),
```

Delete the `campaignVisibility:` line from `mergeSettings`.

Rename the normalizer and point it at the engine defaults:

```ts
function normalizeCampaignFilters(value: Partial<Record<CampaignFilterKey, boolean>> | undefined): Record<CampaignFilterKey, boolean> {
  return Object.fromEntries(
    CAMPAIGN_FILTER_KEYS.map((key) => [key, booleanOr(value?.[key], DEFAULT_ENGINE_SETTINGS.campaignFilters[key])]),
  ) as Record<CampaignFilterKey, boolean>;
}
```

In `applySettingsPatch`, rename the spread block:

```ts
    campaignFilters: {
      ...current.campaignFilters,
      ...patch.campaignFilters,
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts -t "campaignFilters in the engine contract"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/extension/tests/settings.test.ts
git commit -m "feat(shared): move campaignFilters into the engine settings contract"
```

---

### Task 4: Migrate persisted settings v1 to v2

**Files:**
- Modify: `packages/shared/src/settingsSchema.ts:9`, `:67-69`
- Test: `packages/extension/tests/settingsMigrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/extension/tests/settingsMigrations.test.ts`:

```ts
describe("schema v2", () => {
  it("renames campaignVisibility to campaignFilters and reports it", () => {
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: { expired: true, notLinked: false },
    });

    expect(result.settings.campaignFilters).toEqual({ expired: true, notLinked: false });
    expect(result.settings.campaignVisibility).toBeUndefined();
    expect(result.toVersion).toBe(2);
    expect(result.changed).toBe(true);
    expect(result.diagnostics).toContainEqual({
      code: "deprecated_property",
      path: "campaignVisibility",
      replacement: "campaignFilters",
      message: "campaignVisibility is deprecated; use campaignFilters",
    });
  });

  it("leaves a document that never had the key alone", () => {
    const result = migrateSettings({ schemaVersion: 1, autoClaim: false });

    expect(result.settings.campaignFilters).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("lets an already-current key win over the legacy one", () => {
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: { expired: true },
      campaignFilters: { expired: false },
    });

    expect(result.settings.campaignFilters).toEqual({ expired: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settingsMigrations.test.ts -t "schema v2"`
Expected: FAIL — `toVersion` is 1 and `campaignFilters` is undefined.

- [ ] **Step 3: Add the migration**

In `packages/shared/src/settingsSchema.ts`, bump line 9:

```ts
export const CURRENT_SETTINGS_SCHEMA_VERSION = 2;
```

Register it:

```ts
const MIGRATIONS: SettingsMigration[] = [
  { to: 1, migrate: migrateToV1 },
  { to: 2, migrate: migrateToV2 },
];
```

Add the function directly below `migrateToV1`:

```ts
// Migration 2 renames campaignVisibility to campaignFilters. The setting stopped
// being display-only: FarmingFilterKey entries now gate eligibility, so the name
// had to stop saying "visibility". Values carry over untouched — no user's
// farming changes, because the only keys defaulting to false (expired, excluded)
// are not farming keys.
function migrateToV2(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  renameProperty(raw, "campaignVisibility", "campaignFilters", "", diagnose);
  return raw;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settingsMigrations.test.ts`
Expected: PASS, including the pre-existing v1 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/settingsSchema.ts packages/extension/tests/settingsMigrations.test.ts
git commit -m "feat(shared): migrate campaignVisibility to campaignFilters"
```

---

### Task 5: Gate farming on the filters

**Files:**
- Modify: `packages/core/src/core/scheduler.ts:66-90` (`isEligible`), `:96-100` (`hasCampaignEnded`), `:217-257` (`noEligibleCampaignReason`)
- Test: `packages/extension/tests/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/extension/tests/scheduler.test.ts`. Use the file's existing settings and campaign builders; the two cases below are the behaviours that actually change.

```ts
describe("campaign filters gate farming", () => {
  it("skips an unlinked Kick campaign when the notLinked filter is off", async () => {
    const campaigns = [kickCampaign({ id: "unlinked", accountLinked: false })];
    const settings = {
      ...DEFAULT_SETTINGS,
      campaignFilters: { ...DEFAULT_SETTINGS.campaignFilters, notLinked: false },
    };

    const decision = await chooseCampaignDecision("kick", campaigns, settings, adapterFor(campaigns));

    expect(decision.action).toBe("idle");
    expect(decision.reason).toContain("filter");
  });

  it("still farms an unlinked Kick campaign when the filter is on", async () => {
    const campaigns = [kickCampaign({ id: "unlinked", accountLinked: false })];

    const decision = await chooseCampaignDecision("kick", campaigns, DEFAULT_SETTINGS, adapterFor(campaigns));

    expect(decision.action).toBe("watch");
    expect(decision.campaign?.id).toBe("unlinked");
  });

  it("treats the display-only keys as no-ops for farming", async () => {
    const campaigns = [kickCampaign({ id: "active" })];
    const settings = {
      ...DEFAULT_SETTINGS,
      campaignFilters: {
        ...DEFAULT_SETTINGS.campaignFilters,
        upcoming: false,
        expired: false,
        finished: false,
        excluded: false,
      },
    };

    const decision = await chooseCampaignDecision("kick", campaigns, settings, adapterFor(campaigns));

    expect(decision.action).toBe("watch");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/scheduler.test.ts -t "campaign filters gate farming"`
Expected: FAIL — the first case returns `watch`, because nothing consults the filters yet.

- [ ] **Step 3: Consult the farming predicate in isEligible**

In `packages/core/src/core/scheduler.ts`, import the shared helpers:

```ts
import { campaignPassesFarmingFilters, hasCampaignEnded } from "@lurkloot/shared/campaignFilters";
```

Delete the local `hasCampaignEnded` (lines 96-100) — the shared one is identical.

In `isEligible`, add directly after the `excludedCampaignIds` line:

```ts
  // Campaign filters: FarmingFilterKey entries gate eligibility. Display-only
  // keys are not consulted, so hiding finished campaigns never stops farming.
  if (!campaignPassesFarmingFilters(campaign, settings.campaignFilters)) return false;
```

- [ ] **Step 4: Add the reason branch**

In `noEligibleCampaignReason`, add directly before the `priorityMode` branch:

```ts
  if (notExcluded.every((campaign) => !campaignPassesFarmingFilters(campaign, settings.campaignFilters))) {
    return "All campaigns are filtered out by your campaign filters";
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/scheduler.test.ts`
Expected: PASS, including the pre-existing scheduler cases.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "feat(scheduler): gate farming on the campaign filters"
```

---

### Task 6: Accept the setting in the CLI

**Files:**
- Modify: `packages/cli/src/settings.ts:110-123`
- Modify: `packages/cli/src/runtime/status.ts`
- Test: `packages/cli/test/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/settings.test.ts`, matching the file's existing `parseCliSettings` style:

```ts
it("accepts campaignFilters now that it gates farming", () => {
  const result = parseCliSettings({ campaignFilters: { notLinked: false } });

  expect(result.settings.campaignFilters.notLinked).toBe(false);
  expect(result.diagnostics).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lurkloot/cli exec vitest run test/settings.test.ts -t "accepts campaignFilters"`
Expected: FAIL — the key is rejected as extension-only.

- [ ] **Step 3: Stop rejecting it**

In `packages/cli/src/settings.ts`, delete the `"campaignVisibility",` entry from `EXTENSION_ONLY_KEYS`. Do not add `campaignFilters` — it is now a real CLI knob.

- [ ] **Step 4: Confirm the reason reaches the CLI log**

No code change is needed here, and it is worth knowing why rather than assuming. The
scheduler emits the decision reason as a diagnostic event (`emitDiagnostic(emit, platform,
decisionLevel, decision.reason)` in `packages/core/src/core/scheduler.ts`), at `warn` level
whenever the action is `idle`. The CLI pipes engine events to its logger through
`reportCliEvents(events, logger)` in `packages/cli/src/runtime/run.ts`. So the new string
from `noEligibleCampaignReason` surfaces automatically, with no `status.ts` change —
`status.ts` only formats campaigns and subscription waits, and has no reason handling.

Add a regression test to `packages/cli/test/run.test.ts` (or the file that already
exercises `reportCliEvents`) asserting the reason is logged:

```ts
it("logs why farming is idle when the campaign filters exclude everything", async () => {
  const logger = recordingLogger();

  reportCliEvents([{
    category: "diagnostic",
    platform: "kick",
    level: "warn",
    message: "All campaigns are filtered out by your campaign filters",
  }], logger);

  expect(logger.lines).toContainEqual(
    expect.stringContaining("All campaigns are filtered out by your campaign filters"),
  );
});
```

If `recordingLogger` does not exist in that file, build the logger inline from the same
shape the file's other tests use.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @lurkloot/cli exec vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(cli): accept campaignFilters as a farming knob"
```

---

### Task 7: Update the popup call sites

**Files:**
- Modify: `packages/popup-ui/src/Popup.tsx:454`
- Test: `packages/extension/tests/subscriptionDropsView.test.ts`, `packages/extension/tests/dropsView.test.tsx`

- [ ] **Step 1: Update the existing tests to the new signature**

In `packages/extension/tests/subscriptionDropsView.test.ts`, change every `isCampaignVisible(source, settings, excludedIds)` call to pass the filter record:

```ts
expect(isCampaignVisible(source, settings.campaignFilters, excludedIds)).toBe(true);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/subscriptionDropsView.test.ts`
Expected: FAIL — `settings.campaignFilters` is undefined until the call site and fixtures are updated.

- [ ] **Step 3: Update the popup call site**

In `packages/popup-ui/src/Popup.tsx`, line 454:

```ts
  const rawCampaigns = sortCampaignsForPopup(snapshot.state.campaigns[platform].filter((campaign) => isCampaignVisible(campaign, settings.campaignFilters, excludedIds)), settings);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/subscriptionDropsView.test.ts tests/dropsView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/Popup.tsx packages/extension/tests
git commit -m "refactor(popup): read campaignFilters for drops visibility"
```

---

### Task 8: Split the settings control into two groups

**Files:**
- Modify: `packages/popup-ui/src/constants.ts:59-66`
- Modify: `packages/popup-ui/src/settingsControls.tsx:152-184`
- Modify: `packages/popup-ui/src/settingsRegistry.tsx:178-183`
- Test: `packages/extension/tests/settingsView.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `packages/extension/tests/settingsView.test.tsx`, matching its existing render helpers:

```ts
it("groups the campaign filters by whether they change farming", async () => {
  const { findByText } = renderSettings();

  expect(await findByText("Campaign filters")).toBeTruthy();
  expect(await findByText("Farmed campaigns")).toBeTruthy();
  expect(await findByText("Shown in the Drops list")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settingsView.test.tsx -t "groups the campaign filters"`
Expected: FAIL — the row still renders "Visible campaigns".

- [ ] **Step 3: Split the pill lists**

In `packages/popup-ui/src/constants.ts`, replace `CAMPAIGN_FILTERS` (lines 59-66):

```ts
export const FARMING_CAMPAIGN_FILTERS: Array<{ key: FarmingFilterKey; label: string }> = [
  { key: "notLinked", label: "notLinked" },
  { key: "subscription", label: "subscriptionCampaigns" },
];

export const DISPLAY_CAMPAIGN_FILTERS: Array<{ key: DisplayFilterKey; label: string }> = [
  { key: "upcoming", label: "upcoming" },
  { key: "expired", label: "expired" },
  { key: "excluded", label: "excluded" },
  { key: "finished", label: "finished" },
];
```

Update the `import type` at the top of the file to pull `DisplayFilterKey` and `FarmingFilterKey` from `@lurkloot/shared/models`.

- [ ] **Step 4: Render the two groups**

In `packages/popup-ui/src/settingsControls.tsx`, replace `CampaignFilterSettingRow` (lines 152-184):

```tsx
// Two groups, because the halves have different power: the farming group changes
// what gets earned, the display group only changes what the list shows. Users
// previously had no way to tell them apart.
export function CampaignFilterSettingRow({ value, onChange }: { value: Record<CampaignFilterKey, boolean>; onChange(value: Record<CampaignFilterKey, boolean>): void | Promise<void> }) {
  const t = useT();
  const toggle = (key: CampaignFilterKey) => onChange({ ...value, [key]: !value[key] });
  const group = (filters: Array<{ key: CampaignFilterKey; label: string }>, labelKey: string) => (
    <div className="mt-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t(labelKey)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {filters.map(({ key, label }) => {
          const active = value[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold transition ${active
                ? "border-transparent text-white"
                : "border-zinc-200 text-zinc-400 dark:border-zinc-700"}`}
              style={active ? { backgroundColor: "var(--accent)" } : undefined}
              aria-pressed={active}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? "#ffffff" : "var(--accent)" }} />
              {t(label)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="py-2.5">
      <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("campaignFiltersTitle")}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        {t("campaignFiltersDescription")}
      </div>
      {group(FARMING_CAMPAIGN_FILTERS, "campaignFiltersFarmingGroup")}
      {group(DISPLAY_CAMPAIGN_FILTERS, "campaignFiltersDisplayGroup")}
    </div>
  );
}
```

Update the `CAMPAIGN_FILTERS` import in that file to `FARMING_CAMPAIGN_FILTERS, DISPLAY_CAMPAIGN_FILTERS`.

- [ ] **Step 5: Rename the registry entry**

In `packages/popup-ui/src/settingsRegistry.tsx`, replace lines 178-183:

```tsx
          {
            id: "general.drops.campaignFilters",
            titleKey: "campaignFiltersTitle",
            descriptionKey: "campaignFiltersDescription",
            render: () => <CampaignFilterSettingRow value={settings.campaignFilters} onChange={(campaignFilters) => void onSettingsChange({ campaignFilters }, { tickAfterSave: true })} />,
          },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settingsView.test.tsx tests/settingsRegistry.test.ts tests/settingsSearchView.test.tsx`
Expected: PASS. Task 9 must land before these can pass, since the new message keys do not exist yet — if they fail only on missing copy, do Task 9 and re-run.

- [ ] **Step 7: Commit**

```bash
git add packages/popup-ui/src
git commit -m "feat(popup): group campaign filters by farming and display"
```

---

### Task 9: Translate the new keys in all 11 catalogs

`packages/extension/tests/i18n.test.ts` asserts every catalog's key set exactly equals English's, so all 11 files change together.

**Files:**
- Modify: `packages/locales/messages/{ar,de,en,es,fr,hi,it,pt_BR,ru,tr,zh_CN}.json`
- Test: `packages/extension/tests/i18n.test.ts`

- [ ] **Step 1: Remove the old keys and add the new ones in English**

In `packages/locales/messages/en.json`, delete `visibleCampaignsTitle` and `visibleCampaignsDescription`, and add:

```json
  "campaignFiltersTitle": {
    "message": "Campaign filters"
  },
  "campaignFiltersDescription": {
    "message": "Choose which campaigns are farmed and which are visible in the Drops list. A campaign with a claimable reward always stays visible."
  },
  "campaignFiltersFarmingGroup": {
    "message": "Farmed campaigns"
  },
  "campaignFiltersDisplayGroup": {
    "message": "Shown in the Drops list"
  },
```

The description keeps the word "visible" on purpose: `settingsSearch` builds its haystack from the resolved title and description, so a user searching "visible" still finds the renamed row.

- [ ] **Step 2: Apply the same edit to every other catalog**

Delete `visibleCampaignsTitle` and `visibleCampaignsDescription` from each file and add the four keys with these translations.

**es.json**
```json
  "campaignFiltersTitle": { "message": "Filtros de campañas" },
  "campaignFiltersDescription": { "message": "Elige qué campañas se cultivan y cuáles son visibles en la lista de Drops. Una campaña con una recompensa reclamable siempre permanece visible." },
  "campaignFiltersFarmingGroup": { "message": "Campañas cultivadas" },
  "campaignFiltersDisplayGroup": { "message": "Mostradas en la lista de Drops" },
```

**fr.json**
```json
  "campaignFiltersTitle": { "message": "Filtres de campagnes" },
  "campaignFiltersDescription": { "message": "Choisissez quelles campagnes sont farmées et lesquelles sont visibles dans la liste des Drops. Une campagne avec une récompense réclamable reste toujours visible." },
  "campaignFiltersFarmingGroup": { "message": "Campagnes farmées" },
  "campaignFiltersDisplayGroup": { "message": "Affichées dans la liste des Drops" },
```

**it.json**
```json
  "campaignFiltersTitle": { "message": "Filtri campagne" },
  "campaignFiltersDescription": { "message": "Scegli quali campagne vengono farmate e quali sono visibili nell'elenco Drops. Una campagna con una ricompensa riscattabile resta sempre visibile." },
  "campaignFiltersFarmingGroup": { "message": "Campagne farmate" },
  "campaignFiltersDisplayGroup": { "message": "Mostrate nell'elenco Drops" },
```

**de.json**
```json
  "campaignFiltersTitle": { "message": "Kampagnenfilter" },
  "campaignFiltersDescription": { "message": "Lege fest, welche Kampagnen gefarmt werden und welche in der Drops-Liste sichtbar sind. Eine Kampagne mit einer einlösbaren Belohnung bleibt immer sichtbar." },
  "campaignFiltersFarmingGroup": { "message": "Gefarmte Kampagnen" },
  "campaignFiltersDisplayGroup": { "message": "In der Drops-Liste angezeigt" },
```

**pt_BR.json**
```json
  "campaignFiltersTitle": { "message": "Filtros de campanhas" },
  "campaignFiltersDescription": { "message": "Escolha quais campanhas são farmadas e quais ficam visíveis na lista de Drops. Uma campanha com recompensa resgatável permanece sempre visível." },
  "campaignFiltersFarmingGroup": { "message": "Campanhas farmadas" },
  "campaignFiltersDisplayGroup": { "message": "Exibidas na lista de Drops" },
```

**ru.json**
```json
  "campaignFiltersTitle": { "message": "Фильтры кампаний" },
  "campaignFiltersDescription": { "message": "Выберите, какие кампании фармятся и какие видны в списке дропов. Кампания с наградой, готовой к получению, всегда остаётся видимой." },
  "campaignFiltersFarmingGroup": { "message": "Фармящиеся кампании" },
  "campaignFiltersDisplayGroup": { "message": "Показаны в списке дропов" },
```

**tr.json**
```json
  "campaignFiltersTitle": { "message": "Kampanya filtreleri" },
  "campaignFiltersDescription": { "message": "Hangi kampanyaların toplandığını ve hangilerinin Drops listesinde görüneceğini seçin. Alınabilir ödülü olan bir kampanya her zaman görünür kalır." },
  "campaignFiltersFarmingGroup": { "message": "Toplanan kampanyalar" },
  "campaignFiltersDisplayGroup": { "message": "Drops listesinde gösterilenler" },
```

**zh_CN.json**
```json
  "campaignFiltersTitle": { "message": "活动筛选" },
  "campaignFiltersDescription": { "message": "选择要挂机的活动以及在掉落列表中显示的活动。有可领取奖励的活动始终保持可见。" },
  "campaignFiltersFarmingGroup": { "message": "挂机的活动" },
  "campaignFiltersDisplayGroup": { "message": "在掉落列表中显示" },
```

**hi.json**
```json
  "campaignFiltersTitle": { "message": "अभियान फ़िल्टर" },
  "campaignFiltersDescription": { "message": "चुनें कि कौन से अभियान फ़ार्म किए जाएँ और कौन से ड्रॉप्स सूची में दिखें। जिस अभियान में दावा करने योग्य इनाम है वह हमेशा दिखता रहता है।" },
  "campaignFiltersFarmingGroup": { "message": "फ़ार्म किए गए अभियान" },
  "campaignFiltersDisplayGroup": { "message": "ड्रॉप्स सूची में दिखाए गए" },
```

**ar.json**
```json
  "campaignFiltersTitle": { "message": "عوامل تصفية الحملات" },
  "campaignFiltersDescription": { "message": "اختر الحملات التي تُزرع والحملات الظاهرة في قائمة الإسقاطات. تظل الحملة التي تحتوي على مكافأة قابلة للاستلام ظاهرة دائمًا." },
  "campaignFiltersFarmingGroup": { "message": "الحملات المزروعة" },
  "campaignFiltersDisplayGroup": { "message": "المعروضة في قائمة الإسقاطات" },
```

- [ ] **Step 3: Run the parity test**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/i18n.test.ts`
Expected: PASS — every catalog has the same key set as English.

- [ ] **Step 4: Run the popup suites from Task 8**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settingsView.test.tsx tests/settingsRegistry.test.ts tests/settingsSearchView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/locales/messages
git commit -m "i18n: rename visible campaigns to campaign filters"
```

---

### Task 10: Document, verify, and check the migration by hand

**Files:**
- Modify: `docs/architecture.md:47`, and the "Settings Migrations" section

- [ ] **Step 1: Update the settings group list**

In `docs/architecture.md` line 47, add `campaignFilters` to the farming behavior group:

```md
- Farming behavior: `autoClaim`, `autoClaimChannelPoints`, `idleWatchlistFallbackOnly`, `priorityMode`, `campaignPriorities`, `excludedCampaignIds`, `campaignFilters`.
```

- [ ] **Step 2: Document the migration**

Append to the "Settings Migrations" section:

```md
Migration 2 renames `campaignVisibility` to `campaignFilters`. The setting moved
from the extension-only layer into `EngineSettings` when its `notLinked` and
`subscription` keys started gating farming, so the CLI honours it too and the
name no longer claims the setting is only about visibility.
```

- [ ] **Step 3: Full verification**

Run: `pnpm verify`
Expected: PASS — script tests, all workspace typechecks, the extension suite, the Astro site build, and both browser builds.

- [ ] **Step 4: Exercise the migration against real stored settings**

This is the one step the unit tests cannot cover: `CURRENT_SETTINGS_SCHEMA_VERSION` was `1` in every shipped build, so the v1 → v2 path has never run on real data.

1. Run `pnpm dev` and load the extension.
2. Before loading the new build, confirm the profile has stored settings from a previous version (open the popup on the current released build, toggle a filter, close it).
3. Load the new build against that same profile.
4. Open the popup → Settings → Drops. The "Campaign filters" row must show the toggle states you set, not the defaults.
5. Confirm the Drops list still renders and farming still starts.

Record the result in the PR description. If the filters come back defaulted, the migration lost data — stop and fix before merging.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): document the campaign filters migration"
```

---

## Done when

- `pnpm verify` passes.
- An unlinked Kick campaign is farmed with `notLinked: true` and skipped with `notLinked: false`.
- The four display keys provably do not affect `isEligible`.
- Excluded campaigns are never farmed and appear only when `excluded: true`.
- A profile carrying `campaignVisibility` upgrades to `campaignFilters` with its values intact, verified by hand.
- All 11 locale catalogs carry the four new keys and no longer carry the two old ones.
