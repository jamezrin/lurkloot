# Kick Daily Challenges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Farm Kick's daily gamification challenges behind an on-by-default per-platform setting, and give Twitch channel-point claiming the popup toggle it never had.

**Architecture:** `PlatformSettings` splits into per-platform interfaces so each platform carries its own claim toggle. Kick gains an account-level `claimChallenges()` adapter method the scheduler calls on a 10-minute throttle, independent of any watch session. Claims surface as a new `challenge_claimed` activity event that the controller turns into a notification.

**Tech Stack:** TypeScript pnpm monorepo, WXT extension, Vitest (Node env, globals enabled), React popup UI.

**Spec:** `docs/superpowers/specs/2026-07-19-kick-daily-challenges-design.md`

**Branch:** `feat/kick-daily-challenges`, already created off `origin/develop`.

**Baseline note:** develop does **not** contain the `postClaimHandoff*` settings or `supportsPostClaimHandoff` adapter flag — those live on the unmerged `feat/twitch-claim-handoff` branch. If you see them, you are on the wrong base.

---

## File Structure

**Modified — shared contracts:**
- `packages/shared/src/models.ts` — split `PlatformSettings`; add `gamification` to `SchedulerState`
- `packages/shared/src/settings.ts` — defaults, merge/migration, patch type, two accessor helpers
- `packages/shared/src/events.ts` — `challenge_claimed` activity event

**Modified — engine:**
- `packages/core/src/platforms/adapter.ts` — `ClaimedChallenge`, `claimChallenges?()`
- `packages/core/src/platforms/kick/index.ts` — Kick implementation
- `packages/core/src/core/scheduler.ts` — throttled challenge block; channel-points call site
- `packages/core/src/background/controller.ts` — notification from tick events

**Modified — CLI:**
- `packages/cli/src/settings.ts` — per-platform keys and normalization
- `packages/cli/src/config.ts` — generated config template

**Modified — UI:**
- `packages/popup-ui/src/settingsPlatform.tsx` — the two toggles
- `packages/popup-ui/src/settings.tsx` — wiring
- `packages/locales/messages/*.json` — 10 catalogs, 5 new keys each

**Tests:**
- `packages/extension/tests/settings.test.ts`
- `packages/extension/tests/adapters.test.ts`
- `packages/extension/tests/scheduler.test.ts`
- `packages/extension/tests/backgroundController.test.ts`
- `packages/cli/tests/settings.test.ts`, `packages/cli/tests/config.test.ts`

**Commands:** `pnpm test` (extension suite), `pnpm typecheck` (all packages), `pnpm check` before the final commit.

---

## Task 1: Split the platform settings types

Moves `autoClaimChannelPoints` onto `platform.twitch` and introduces
`platform.kick.autoClaimChallenges`. Both belong in one commit: the type split breaks every consumer
of `EngineSettings.platform`, so shared, scheduler, and CLI all move together and the task must end
with the whole workspace typechecking.

**Files:**
- Modify: `packages/shared/src/models.ts:212-221` (PlatformSettings), `:243-263` (EngineSettings)
- Modify: `packages/shared/src/settings.ts:10-17` (SettingsPatch), `:20-67` (defaults), `:94-146` (mergeEngineSettings)
- Modify: `packages/core/src/core/scheduler.ts:596`
- Modify: `packages/cli/src/settings.ts`, `packages/cli/src/config.ts`
- Test: `packages/extension/tests/settings.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add to `packages/extension/tests/settings.test.ts`. If `mergeSettings` and `DEFAULT_SETTINGS` are not already imported there, add `import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";`.

```ts
describe("per-platform claim settings", () => {
  it("defaults autoClaimChannelPoints on for Twitch", () => {
    expect(mergeSettings(undefined).platform.twitch.autoClaimChannelPoints).toBe(true);
  });

  it("migrates a legacy top-level autoClaimChannelPoints onto platform.twitch", () => {
    const merged = mergeSettings({ autoClaimChannelPoints: false } as never);
    expect(merged.platform.twitch.autoClaimChannelPoints).toBe(false);
  });

  it("prefers an explicit platform.twitch value over the legacy top-level one", () => {
    const merged = mergeSettings({
      autoClaimChannelPoints: false,
      platform: { ...DEFAULT_SETTINGS.platform, twitch: { ...DEFAULT_SETTINGS.platform.twitch, autoClaimChannelPoints: true } },
    } as never);
    expect(merged.platform.twitch.autoClaimChannelPoints).toBe(true);
  });

  it("drops the legacy top-level key from the merged result", () => {
    expect("autoClaimChannelPoints" in mergeSettings(undefined)).toBe(false);
  });

  it("defaults autoClaimChallenges on for Kick", () => {
    expect(mergeSettings(undefined).platform.kick.autoClaimChallenges).toBe(true);
  });

  it("honors an explicit autoClaimChallenges of false", () => {
    const merged = mergeSettings({
      platform: { ...DEFAULT_SETTINGS.platform, kick: { ...DEFAULT_SETTINGS.platform.kick, autoClaimChallenges: false } },
    });
    expect(merged.platform.kick.autoClaimChallenges).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- settings.test.ts`
Expected: FAIL — `platform.twitch.autoClaimChannelPoints` is `undefined`.

- [ ] **Step 3: Split the types in `models.ts`**

Replace the `PlatformSettings` interface at `packages/shared/src/models.ts:212-221` with:

```ts
export interface PlatformSettings {
  enabled: boolean;
  watchQueueChannels: string[];
  excludedChannels?: string[];
  // When true, every category is farmable. When false, only `categories` are
  // farmed (an empty list then means nothing is farmed). The list is ordered:
  // order sets farming priority (see categoryPriorityScore in the scheduler).
  farmAllCategories: boolean;
  categories: CategorySelection[];
}

// Per-platform settings carry the claim toggles that only make sense on that
// platform, so the type never advertises a knob the platform ignores.
export interface TwitchPlatformSettings extends PlatformSettings {
  autoClaimChannelPoints: boolean;
}

export interface KickPlatformSettings extends PlatformSettings {
  autoClaimChallenges: boolean;
}

export interface PlatformSettingsByPlatform {
  twitch: TwitchPlatformSettings;
  kick: KickPlatformSettings;
}
```

In `EngineSettings` (`packages/shared/src/models.ts:243-263`), delete the line
`autoClaimChannelPoints: boolean;` and change `platform: Record<Platform, PlatformSettings>;` to
`platform: PlatformSettingsByPlatform;`.

- [ ] **Step 4: Update `settings.ts` defaults, patch type, and merge**

In `packages/shared/src/settings.ts`:

Change the import on line 1 to add the new types:

```ts
import type { AdFocusMode, CampaignFilterKey, CategorySelection, CompatibilitySettings, EngineSettings, ExtensionSettings, KickPlatformSettings, LanguageOverride, Platform, PriorityMode, RateNudgeStatus, SupportedLocale, TwitchPlatformSettings } from "./models";
```

(`PlatformSettings` is no longer referenced in this file once `SettingsPatch` is updated; drop it from the import if TypeScript flags it as unused.)

Replace the `SettingsPatch.platform` member:

```ts
export type SettingsPatch = Partial<Omit<ExtensionSettings, "platform" | "compatibility" | "campaignVisibility">> & {
  platform?: {
    twitch?: Partial<TwitchPlatformSettings>;
    kick?: Partial<KickPlatformSettings>;
  };
  compatibility?: {
    twitch?: Partial<CompatibilitySettings["twitch"]>;
    kick?: Partial<CompatibilitySettings["kick"]>;
  };
  campaignVisibility?: Partial<ExtensionSettings["campaignVisibility"]>;
};
```

In `DEFAULT_ENGINE_SETTINGS`, delete the top-level `autoClaimChannelPoints: true,` line and add the
field to the Twitch platform block:

```ts
  platform: {
    twitch: {
      enabled: true,
      watchQueueChannels: [],
      excludedChannels: [],
      farmAllCategories: true,
      categories: [],
      autoClaimChannelPoints: true,
    },
    kick: {
      enabled: true,
      watchQueueChannels: [],
      excludedChannels: [],
      farmAllCategories: true,
      categories: [],
      autoClaimChallenges: true,
    },
  },
```

In `mergeEngineSettings`, delete the top-level `autoClaimChannelPoints:` line and add the migrating
read inside the Twitch block. Note the `legacyChannelPoints` local declared just above the return:

```ts
export function mergeEngineSettings(value: Partial<EngineSettings> | undefined): EngineSettings {
  const platform = value?.platform;
  const compatibility = value?.compatibility;
  // Pre-split configs stored this at the top level. Read it as the fallback for
  // the Twitch platform block so an existing "off" survives; never written back.
  const legacyChannelPoints = (value as (Partial<EngineSettings> & { autoClaimChannelPoints?: boolean }) | undefined)?.autoClaimChannelPoints;
  return {
```

and in the Twitch platform block inside that return:

```ts
      twitch: {
        enabled: booleanOr(platform?.twitch?.enabled, DEFAULT_ENGINE_SETTINGS.platform.twitch.enabled),
        watchQueueChannels: normalizeChannelList(platform?.twitch?.watchQueueChannels),
        excludedChannels: normalizeChannelList(platform?.twitch?.excludedChannels),
        farmAllCategories: booleanOr(platform?.twitch?.farmAllCategories, DEFAULT_ENGINE_SETTINGS.platform.twitch.farmAllCategories),
        categories: normalizeCategorySelections(platform?.twitch?.categories),
        autoClaimChannelPoints: booleanOr(
          platform?.twitch?.autoClaimChannelPoints,
          booleanOr(legacyChannelPoints, DEFAULT_ENGINE_SETTINGS.platform.twitch.autoClaimChannelPoints),
        ),
      },
```

and add the Kick counterpart in the Kick block of the same return:

```ts
        autoClaimChallenges: booleanOr(platform?.kick?.autoClaimChallenges, DEFAULT_ENGINE_SETTINGS.platform.kick.autoClaimChallenges),
```

- [ ] **Step 5: Add the accessor helpers**

The scheduler holds `platform` as a variable, so indexing `settings.platform[platform]` yields a
union that carries neither field. Add both helpers at the end of
`packages/shared/src/settings.ts` so the platform conditional lives in exactly one place:

```ts
// The claim toggles are per-platform, so a scheduler loop holding `platform` as a
// variable cannot read them off the union. These answer "is the toggle on for
// this platform"; whether the platform can actually claim is decided separately
// by the adapter's optional capability method.
export function autoClaimChannelPointsFor(settings: EngineSettings, platform: Platform): boolean {
  return platform === "twitch" ? settings.platform.twitch.autoClaimChannelPoints : false;
}

export function autoClaimChallengesFor(settings: EngineSettings, platform: Platform): boolean {
  return platform === "kick" ? settings.platform.kick.autoClaimChallenges : false;
}
```

- [ ] **Step 6: Update the scheduler call site**

In `packages/core/src/core/scheduler.ts`, add `autoClaimChannelPointsFor` to the existing
`@lurkloot/shared/settings` import. Change line 596 from:

```ts
        if (settings.autoClaimChannelPoints && adapter.claimChannelPoints) {
```

to:

```ts
        if (autoClaimChannelPointsFor(settings, platform) && adapter.claimChannelPoints) {
```

- [ ] **Step 7: Update the CLI settings schema**

In `packages/cli/src/settings.ts`:

Change the type import to pull in the split types:

```ts
import type { CompatibilitySettings, EngineSettings, KickPlatformSettings, Platform, PlatformSettingsByPlatform, PriorityMode, TwitchPlatformSettings } from "@lurkloot/shared/models";
```

In `CliSettings`, delete `autoClaimChannelPoints: boolean;` and change
`platform: Record<Platform, PlatformSettings>;` to `platform: PlatformSettingsByPlatform;`.
Replace the comment above the interface that claims `PlatformSettings` is reused verbatim:

```ts
// The CLI's own settings surface — intentionally decoupled from the extension's
// ExtensionSettings. It only exposes settings that actually do something in the
// headless, tabless watch path (direct HTTP heartbeats / Kick WebSocket; no
// browser, no tabs). Anything that only matters with a real browser running is
// rejected (see EXTENSION_ONLY_KEYS) so the config never carries inert knobs.
// Per-platform settings reuse the extension's split platform types; the
// top-level schema is deliberately not shared.
```

In `DEFAULT_CLI_SETTINGS`, delete the `autoClaimChannelPoints:` line. The `platform` spreads already
copy `DEFAULT_SETTINGS.platform.twitch` / `.kick`, so they pick up the new field automatically.

In `CLI_SETTING_KEYS`, delete the `"autoClaimChannelPoints",` entry.

Replace the single `CLI_PLATFORM_KEYS` set with a per-platform record:

```ts
const CLI_PLATFORM_KEYS: Record<Platform, Set<string>> = {
  twitch: new Set(["enabled", "watchQueueChannels", "excludedChannels", "farmAllCategories", "categories", "autoClaimChannelPoints"]),
  kick: new Set(["enabled", "watchQueueChannels", "excludedChannels", "farmAllCategories", "categories"]),
};
```

In `parseCliSettings`, update the per-platform key check to index by platform:

```ts
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          for (const key of Object.keys(entry as Record<string, unknown>)) {
            if (!CLI_PLATFORM_KEYS[name as Platform].has(key)) offenders.push(`unknown setting "${key}" under platform.${name}`);
          }
        }
```

Delete the `autoClaimChannelPoints: booleanOr(...)` line from the object `parseCliSettings` returns.

Replace `normalizePlatform` with a version that builds each platform separately:

```ts
function normalizePlatform(raw: EngineSettings["platform"] | undefined): PlatformSettingsByPlatform {
  const common = (platform: Platform) => {
    const ps = (raw?.[platform] ?? {}) as Partial<TwitchPlatformSettings & KickPlatformSettings>;
    const defaults = DEFAULT_CLI_SETTINGS.platform[platform];
    return {
      ps,
      base: {
        enabled: booleanOr(ps.enabled, defaults.enabled),
        watchQueueChannels: normalizeChannelList(ps.watchQueueChannels),
        excludedChannels: normalizeChannelList(ps.excludedChannels),
        farmAllCategories: booleanOr(ps.farmAllCategories, defaults.farmAllCategories),
        categories: normalizeCategorySelections(ps.categories),
      },
    };
  };
  const twitch = common("twitch");
  const kick = common("kick");
  return {
    twitch: {
      ...twitch.base,
      autoClaimChannelPoints: booleanOr(twitch.ps.autoClaimChannelPoints, DEFAULT_CLI_SETTINGS.platform.twitch.autoClaimChannelPoints),
    },
    kick: { ...kick.base },
  };
}
```

- [ ] **Step 8: Update the generated CLI config template**

In `packages/cli/src/config.ts`, delete these two lines from the `settings` block:

```
    // Automatically claim completed drops and Twitch channel-point bonuses.
    "autoClaim": ${json(defaults.autoClaim)},
    "autoClaimChannelPoints": ${json(defaults.autoClaimChannelPoints)},
```

and replace them with:

```
    // Automatically claim completed drops.
    "autoClaim": ${json(defaults.autoClaim)},
```

Then add the field to the Twitch platform block in the same template:

```
      "twitch": {
        "enabled": ${json(twitch.enabled)},
        "watchQueueChannels": ${json(twitch.watchQueueChannels)},
        "excludedChannels": ${json(twitch.excludedChannels)},
        "farmAllCategories": ${json(twitch.farmAllCategories)},
        // Used when farmAllCategories is false.
        "categories": ${json(twitch.categories)},
        // Claim channel-point bonuses while farming this platform.
        "autoClaimChannelPoints": ${json(twitch.autoClaimChannelPoints)}
      },
```

- [ ] **Step 9: Fix the scheduler test's stale assertion**

`packages/extension/tests/scheduler.test.ts` has a channel-points test around line 1848 whose
`settings({ platform: { twitch: { enabled: true, watchQueueChannels: [] }, … } })` call still
typechecks (the helper spreads defaults), so no change is needed there. Run the suite and only
touch tests that actually fail.

- [ ] **Step 10: Run the full verification**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. If the CLI tests assert on the old flat key or the old template text, update those
assertions to the new nested shape — that is the intended breaking change, not a regression.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src packages/core/src/core/scheduler.ts packages/cli/src packages/extension/tests
git commit -m "refactor(settings): split platform settings and move the claim toggles"
```

---

## Task 2: Expose `autoClaimChallenges` through the CLI

Task 1 left the Kick toggle absent from the CLI's accepted keys, so a config setting it is rejected
and the generated template never mentions it. This task closes that gap.

**Files:**
- Modify: `packages/cli/src/settings.ts`, `packages/cli/src/config.ts`
- Test: `packages/cli/tests/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/tests/settings.test.ts`, following that file's existing `parseCliSettings`
patterns:

```ts
  it("accepts autoClaimChallenges under platform.kick", () => {
    const parsed = parseCliSettings({ platform: { kick: { autoClaimChallenges: false } } });
    expect(parsed.platform.kick.autoClaimChallenges).toBe(false);
  });

  it("defaults autoClaimChallenges on when the config omits it", () => {
    expect(parseCliSettings({}).platform.kick.autoClaimChallenges).toBe(true);
  });

  it("rejects autoClaimChallenges under platform.twitch", () => {
    expect(() => parseCliSettings({ platform: { twitch: { autoClaimChallenges: true } } }))
      .toThrow('unknown setting "autoClaimChallenges" under platform.twitch');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/cli test -- settings.test.ts`
Expected: FAIL — the first case throws `unknown setting "autoClaimChallenges" under platform.kick`.

- [ ] **Step 3: Add the CLI key, normalization, and template entry**

`packages/cli/src/settings.ts` — add `"autoClaimChallenges"` to the `kick` set in
`CLI_PLATFORM_KEYS`, and add the field to the Kick branch of `normalizePlatform`:

```ts
    kick: {
      ...kick.base,
      autoClaimChallenges: booleanOr(kick.ps.autoClaimChallenges, DEFAULT_CLI_SETTINGS.platform.kick.autoClaimChallenges),
    },
```

`packages/cli/src/config.ts` — add to the Kick platform block of the template:

```
      "kick": {
        "enabled": ${json(kick.enabled)},
        "watchQueueChannels": ${json(kick.watchQueueChannels)},
        "excludedChannels": ${json(kick.excludedChannels)},
        "farmAllCategories": ${json(kick.farmAllCategories)},
        // Used when farmAllCategories is false.
        "categories": ${json(kick.categories)},
        // Claim Kick's daily gamification challenges automatically.
        "autoClaimChallenges": ${json(kick.autoClaimChallenges)}
      }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm typecheck && pnpm --filter @lurkloot/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/cli/tests
git commit -m "feat(cli): accept the Kick auto-claim challenges setting"
```

---

## Task 3: `claimChallenges()` on the adapter contract and Kick

**Files:**
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/extension/tests/adapters.test.ts`, inside the existing `describe("KickAdapter", …)`.
The `jsonFetcher` helper at the top of that file is already in scope.

```ts
  it("claims only completed, unclaimed Kick challenges", async () => {
    const claimed: string[] = [];
    const fetcher = jsonFetcher((url, init) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return {
          data: [
            { id: "done", recurrence: "daily", claimed_at: null, condition: { progress: 60, threshold: 60 } },
            { id: "already", recurrence: "daily", claimed_at: "2026-07-17T23:39:02Z", condition: { progress: 60, threshold: 60 } },
            { id: "partial", recurrence: "daily", claimed_at: null, condition: { progress: 30, threshold: 60 } },
          ],
        };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/done/claim") {
        expect(init?.method).toBe("POST");
        claimed.push("done");
        return { data: { challenge_id: "done", winner: { id: "card", rarity: "legendary" } } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const adapter = new KickAdapter(fetcher);

    await expect(adapter.claimChallenges!()).resolves.toEqual([
      { id: "done", rarity: "legendary", recurrence: "daily" },
    ]);
    expect(claimed).toEqual(["done"]);
  });

  it("reports an unknown rarity when the Kick claim response omits a winner", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return { data: [{ id: "done", recurrence: "weekly", claimed_at: null, condition: { progress: 5, threshold: 5 } }] };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/done/claim") return { message: "success" };
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(new KickAdapter(fetcher).claimChallenges!()).resolves.toEqual([
      { id: "done", rarity: "unknown", recurrence: "weekly" },
    ]);
  });

  it("keeps claiming Kick challenges after one claim fails", async () => {
    const fetcher = jsonFetcher((url) => {
      if (url === "https://web.kick.com/api/v1/gamification/challenges") {
        return {
          data: [
            { id: "bad", recurrence: "daily", claimed_at: null, condition: { progress: 1, threshold: 1 } },
            { id: "good", recurrence: "daily", claimed_at: null, condition: { progress: 1, threshold: 1 } },
          ],
        };
      }
      if (url === "https://web.kick.com/api/v1/gamification/challenges/bad/claim") throw new Error("boom");
      if (url === "https://web.kick.com/api/v1/gamification/challenges/good/claim") {
        return { data: { winner: { rarity: "common" } } };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(new KickAdapter(fetcher).claimChallenges!()).resolves.toEqual([
      { id: "good", rarity: "common", recurrence: "daily" },
    ]);
  });

  it("returns nothing when Kick reports no challenges", async () => {
    const fetcher = jsonFetcher(() => ({}));
    await expect(new KickAdapter(fetcher).claimChallenges!()).resolves.toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- adapters.test.ts`
Expected: FAIL — `adapter.claimChallenges` is undefined.

- [ ] **Step 3: Add the contract to `adapter.ts`**

In `packages/core/src/platforms/adapter.ts`, add the result type above `PlatformAdapter`:

```ts
// A gamification challenge that was just claimed. Account-level, so unlike
// channel points it is not tied to a channel or a watch session.
export interface ClaimedChallenge {
  id: string;
  rarity: string;
  recurrence: string;
}
```

and add the optional method to `PlatformAdapter`, directly under `claimChannelPoints`:

```ts
  // Claims any completed, unclaimed gamification challenges for the logged-in
  // account and reports what was won. Account-level, so it takes no channel and
  // runs regardless of whether a watch session is active.
  claimChallenges?(): Promise<ClaimedChallenge[]>;
```

- [ ] **Step 4: Implement it on the Kick adapter**

In `packages/core/src/platforms/kick/index.ts`, add `ClaimedChallenge` to the existing
`../adapter` type import. Add the response shapes next to the other `interface Kick*Response`
declarations near the top of the file:

```ts
interface KickChallengesResponse {
  data?: KickChallenge[];
}

interface KickChallenge {
  id?: string;
  recurrence?: string;
  // Kick sets this when the box has already been opened. `status` is deliberately
  // not consulted: only "claimed" is documented, so any check against the other
  // values would be a guess.
  claimed_at?: string | null;
  condition?: { progress?: number; threshold?: number; type?: string };
}

interface KickChallengeClaimResponse {
  data?: { challenge_id?: string; winner?: { id?: string; rarity?: string } } | null;
}
```

Add the method to the `KickAdapter` class, immediately after `claimReward`:

```ts
  async claimChallenges(): Promise<ClaimedChallenge[]> {
    const response = await this.fetcher.fetchJson<KickChallengesResponse>(
      "https://web.kick.com/api/v1/gamification/challenges",
      undefined,
      this.emit,
    );
    const claimed: ClaimedChallenge[] = [];
    for (const challenge of response?.data ?? []) {
      const id = typeof challenge?.id === "string" ? challenge.id.trim() : "";
      if (!id || challenge.claimed_at != null) continue;
      const progress = Number(challenge.condition?.progress ?? 0);
      const threshold = Number(challenge.condition?.threshold ?? 0);
      if (!Number.isFinite(progress) || !Number.isFinite(threshold) || threshold <= 0 || progress < threshold) continue;
      // One failing box must not block the others, so each claim is isolated.
      try {
        const result = await this.fetcher.fetchJson<KickChallengeClaimResponse>(
          `https://web.kick.com/api/v1/gamification/challenges/${encodeURIComponent(id)}/claim`,
          { method: "POST" },
          this.emit,
        );
        const rarity = result?.data?.winner?.rarity;
        claimed.push({
          id,
          rarity: typeof rarity === "string" && rarity.trim() ? rarity.trim() : "unknown",
          recurrence: typeof challenge.recurrence === "string" && challenge.recurrence.trim() ? challenge.recurrence.trim() : "unknown",
        });
      } catch (error) {
        diagnostic(this.emit, "warn", `Kick challenge ${id} claim failed: ${error instanceof Error ? error.message : String(error)}`, "kick");
      }
    }
    return claimed;
  }
```

`diagnostic` is already imported from `../adapter` in this file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- adapters.test.ts`
Expected: PASS, all four new cases.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/platforms packages/extension/tests/adapters.test.ts
git commit -m "feat(kick): claim completed gamification challenges"
```

---

## Task 4: Throttled challenge polling in the scheduler

**Files:**
- Modify: `packages/shared/src/models.ts` (SchedulerState, line 285-295)
- Modify: `packages/shared/src/events.ts` (ActivityEvent union)
- Modify: `packages/core/src/core/scheduler.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/extension/tests/scheduler.test.ts`, in the same `describe` block that holds the
existing "claims channel points for active watch sessions when supported" test. The `settings`,
`adapter`, `campaign`, and `channel` helpers are already defined at the top of that file.

```ts
  it("claims Kick challenges even when the platform never starts watching", async () => {
    const kick = {
      ...adapter("kick", [], []),
      claimChallenges: vi.fn(async () => [{ id: "daily", rarity: "epic", recurrence: "daily" }]),
    };

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(kick.claimChallenges).toHaveBeenCalled();
    expect(result.state.sessions.kick.status).toBe("idle");
    expect(result.state.gamification?.kick?.lastCheckedAt).toBeDefined();
    expect(result.events.some((event) => event.category === "activity" && event.code === "challenge_claimed")).toBe(true);
  });

  it("skips the Kick challenge poll inside the throttle window", async () => {
    const kick = { ...adapter("kick", [], []), claimChallenges: vi.fn(async () => []) };
    const recent = new Date(Date.now() - 60_000).toISOString();

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        gamification: { kick: { lastCheckedAt: recent } },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(kick.claimChallenges).not.toHaveBeenCalled();
    expect(result.state.gamification?.kick?.lastCheckedAt).toBe(recent);
  });

  it("does not claim Kick challenges when the setting is off", async () => {
    const kick = { ...adapter("kick", [], []), claimChallenges: vi.fn(async () => []) };

    await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true, autoClaimChallenges: false } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(kick.claimChallenges).not.toHaveBeenCalled();
  });

  it("keeps the tick healthy when a Kick challenge poll throws", async () => {
    const kick = {
      ...adapter("kick", [], []),
      claimChallenges: vi.fn(async () => { throw new Error("gamification down"); }),
    };

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(result.state.sessions.kick.status).not.toBe("error");
    expect(result.state.sessions.kick.errorChecks).toBe(0);
    expect(result.events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("gamification down"))).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- scheduler.test.ts`
Expected: FAIL — `claimChallenges` is never called and `gamification` is not on `SchedulerState`.

- [ ] **Step 3: Add the state field**

In `packages/shared/src/models.ts`, add to `SchedulerState` (after `manualWatch`):

```ts
  // Last time each platform's account-level gamification endpoints were polled.
  // Persisted because adapters are rebuilt every tick, so an in-memory throttle
  // would never survive to the next one.
  gamification?: Partial<Record<Platform, { lastCheckedAt: string }>>;
```

- [ ] **Step 4: Add the activity event**

In `packages/shared/src/events.ts`, add to the `ActivityEvent` union:

```ts
  | { category: "activity"; code: "challenge_claimed"; level: "info"; platform: Platform; message?: never; data: { challengeId: string; rarity: string; recurrence: string } }
```

- [ ] **Step 5: Implement the scheduler block**

In `packages/core/src/core/scheduler.ts`, add `autoClaimChallengesFor` to the
`@lurkloot/shared/settings` import. Add the constant and helper near the other module-level
helpers:

```ts
// Kick's daily challenge window is hours long, so a ten-minute poll is far more
// than responsive enough while keeping the request count negligible.
const CHALLENGE_POLL_INTERVAL_MS = 10 * 60 * 1000;

function challengePollDue(state: SchedulerState, platform: Platform, now: number): boolean {
  const lastCheckedAt = state.gamification?.[platform]?.lastCheckedAt;
  if (!lastCheckedAt) return true;
  const last = Date.parse(lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= CHALLENGE_POLL_INTERVAL_MS;
}
```

Inside the per-platform loop in `runSchedulerTick`, immediately **after** the
`if (!settings.running || !platformSettings.enabled) { … continue; }` block and **before** the
watch-decision logic, insert:

```ts
      // Account-level, so it runs whether or not this platform ends up watching:
      // the watch-time threshold is usually met by a session that has already
      // stopped. Failures are swallowed — gamification is strictly additive to
      // farming and must never fail the tick or trip the error backoff.
      if (autoClaimChallengesFor(settings, platform) && adapter.claimChallenges && challengePollDue(nextState, platform, Date.now())) {
        // Stamped on attempt, not on success, so a persistently failing endpoint
        // is retried on the next interval instead of on every tick.
        nextState.gamification = {
          ...nextState.gamification,
          [platform]: { lastCheckedAt: new Date().toISOString() },
        };
        try {
          for (const challenge of await adapter.claimChallenges()) {
            emit({
              category: "activity",
              code: "challenge_claimed",
              level: "info",
              platform,
              data: { challengeId: challenge.id, rarity: challenge.rarity, recurrence: challenge.recurrence },
            });
          }
        } catch (error) {
          emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Challenge claim failed");
        }
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- scheduler.test.ts`
Expected: PASS, all four new cases.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "feat(scheduler): poll and claim Kick challenges on a throttle"
```

---

## Task 5: Notify on a claimed challenge

**Files:**
- Modify: `packages/core/src/background/controller.ts:37-43` (EN_RUNTIME_MESSAGES), `:381` (call), `:916-928` (emitNotifications)
- Test: `packages/extension/tests/backgroundController.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/extension/tests/backgroundController.test.ts`, next to the existing
"emits reward notifications best-effort when rewards become earned" test. That test establishes the
pattern used here: `harness(...)` returns `env` exposing `deps` (with the `createNotification` spy),
the per-platform adapters as `env.twitch` / `env.kick`, and `env.controller.tick()`.

```ts
  it("emits a notification when a Kick challenge is claimed", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: true });
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Challenge reward claimed",
      message: "You won a mythic card from your daily challenge.",
    });
  });

  it("does not emit a challenge notification when reward notifications are off", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: false });
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Challenge reward claimed" }),
    );
  });
```

The harness's `adapter("kick")` factory does not define `claimChallenges`, so assigning it is what
makes the platform challenge-capable for these two tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- backgroundController.test.ts`
Expected: FAIL — no such notification is emitted.

- [ ] **Step 3: Add the English runtime fallbacks**

In `packages/core/src/background/controller.ts`, extend `EN_RUNTIME_MESSAGES`:

```ts
const EN_RUNTIME_MESSAGES: Record<string, string> = {
  notificationRewardClaimed: "Reward claimed",
  notificationRewardEarned: "Reward earned",
  notificationNoDropsLeft: "No drops left",
  notificationRewardFromCampaign: "$1 from $2",
  notificationNoDropsLeftMessage: "$1 has no eligible drops to farm.",
  notificationChallengeClaimed: "Challenge reward claimed",
  notificationChallengeReward: "You won a $1 card from your $2 challenge.",
};
```

- [ ] **Step 4: Pass the tick's events into `emitNotifications` and scan them**

Change the signature and add the scan. Challenge claims are not in `SchedulerState`, so they are
read off the tick's events rather than a state diff:

```ts
  async function emitNotifications(
    settings: EngineSettings,
    previous: SchedulerState,
    next: SchedulerState,
    tickEvents: readonly EngineEvent[] = [],
  ): Promise<void> {
    if (settings.notifyRewardEarned) {
      for (const reward of newlyEarnedRewards(previous, next)) {
        await safeNotify(
          await tr("notificationRewardEarned"),
          await tr("notificationRewardFromCampaign", [reward.reward.name, reward.campaign.name]),
        );
      }
      // Challenge claims never enter SchedulerState, so they come from the tick's
      // events instead of a state diff. They ride notifyRewardEarned deliberately:
      // one more toggle for a single event type is not worth the settings surface.
      for (const event of tickEvents) {
        if (event.category !== "activity" || event.code !== "challenge_claimed") continue;
        await safeNotify(
          await tr("notificationChallengeClaimed"),
          await tr("notificationChallengeReward", [event.data.rarity, event.data.recurrence]),
        );
      }
    }
```

Leave the rest of the function unchanged. Update the call site at line 381:

```ts
        await emitNotifications(settings, state, result.state, result.events);
```

`EngineEvent` is already imported in this file; if not, add it to the `@lurkloot/shared/events`
type import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- backgroundController.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): notify when a Kick challenge reward is claimed"
```

---

## Task 6: Popup toggles and locale catalogs

**Files:**
- Modify: `packages/popup-ui/src/settingsPlatform.tsx:32-90`
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/locales/messages/*.json` (all 10)

- [ ] **Step 1: Add the English strings**

In `packages/locales/messages/en.json`, add these five entries. Match the file's existing
`{"message": "…"}` object format and keep them near the other settings keys:

```json
  "autoClaimChannelPointsTitle": {
    "message": "Auto-claim channel points"
  },
  "autoClaimChannelPointsDescription": {
    "message": "Claim channel-point bonuses while farming this platform."
  },
  "autoClaimChallengesTitle": {
    "message": "Auto-claim daily challenges"
  },
  "autoClaimChallengesDescription": {
    "message": "Open Kick's daily challenge reward once its watch-time goal is met."
  },
  "notificationChallengeClaimed": {
    "message": "Challenge reward claimed"
  }
```

Also add `notificationChallengeReward`:

```json
  "notificationChallengeReward": {
    "message": "You won a $1 card from your $2 challenge."
  }
```

- [ ] **Step 2: Translate into the other nine catalogs**

Add the same six keys to `ar.json`, `de.json`, `es.json`, `fr.json`, `hi.json`, `it.json`,
`pt_BR.json`, `ru.json`, and `zh_CN.json`, translating the message values. Keep the `$1` / `$2`
placeholders and their order intact in every locale.

- [ ] **Step 3: Render the toggles**

In `packages/popup-ui/src/settingsPlatform.tsx`, add the import:

```ts
import { SettingRow } from "./settingsControls";
```

Extend the `PlatformSettingsGroup` props with one callback:

```tsx
export function PlatformSettingsGroup({ platform, suggestions, settings, onFarmAllCategoriesChange, onCategoriesChange, onSearchCategories, onExcludedChannelsChange, onAutoClaimBonusChange }: {
  platform: Platform;
  suggestions: GameItem[];
  settings: ExtensionSettings;
  onFarmAllCategoriesChange(farmAll: boolean): void | Promise<void>;
  onCategoriesChange(categories: CategorySelection[]): void | Promise<void>;
  onSearchCategories(query: string): Promise<CategorySelection[]>;
  onExcludedChannelsChange(channels: string[]): void | Promise<void>;
  // The platform's own claim toggle: channel points on Twitch, daily challenges
  // on Kick. Each platform has exactly one, so a single callback covers both.
  onAutoClaimBonusChange(value: boolean): void | Promise<void>;
}) {
```

Render it inside the first `<div className="divide-y …">`, after the watch-queue row. Read the
concrete platform key rather than `settings.platform[platform]`, which is a union and does not
carry either field:

```tsx
        {platform === "twitch" ? (
          <SettingRow
            title={t("autoClaimChannelPointsTitle")}
            description={t("autoClaimChannelPointsDescription")}
            checked={settings.platform.twitch.autoClaimChannelPoints}
            onChange={onAutoClaimBonusChange}
          />
        ) : (
          <SettingRow
            title={t("autoClaimChallengesTitle")}
            description={t("autoClaimChallengesDescription")}
            checked={settings.platform.kick.autoClaimChallenges}
            onChange={onAutoClaimBonusChange}
          />
        )}
```

- [ ] **Step 4: Wire it from the settings view**

In `packages/popup-ui/src/settings.tsx`, add the handler alongside the other
`setPlatform*` helpers:

```tsx
  const setPlatformAutoClaimBonus = (platform: Platform) => (value: boolean) => onSettingsChange(
    platform === "twitch"
      ? { platform: { twitch: { autoClaimChannelPoints: value } } }
      : { platform: { kick: { autoClaimChallenges: value } } },
  );
```

and pass it on the `PlatformSettingsGroup` element:

```tsx
            <PlatformSettingsGroup platform={platformTab} suggestions={suggestions[platformTab]} settings={settings} onFarmAllCategoriesChange={setPlatformFarmAllCategories(platformTab)} onCategoriesChange={setPlatformCategories(platformTab)} onSearchCategories={(query) => onSearchCategories(platformTab, query)} onExcludedChannelsChange={setPlatformExcludedChannels(platformTab)} onAutoClaimBonusChange={setPlatformAutoClaimBonus(platformTab)} />
```

- [ ] **Step 5: Verify the site demo still builds**

`packages/site` imports the real popup UI, so a missing required prop breaks its build. If the demo
renders `PlatformSettingsGroup` or `SettingsView` directly, pass the new callback there too.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full check**

Run: `pnpm check`
Expected: PASS — script tests, workspace typechecks, extension tests, and the Astro site build.

- [ ] **Step 7: Commit**

```bash
git add packages/popup-ui/src packages/locales/messages
git commit -m "feat(popup): expose the per-platform auto-claim toggles"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run the full verification suite**

Run: `pnpm verify`
Expected: PASS — `pnpm check` plus both browser builds.

- [ ] **Step 2: Confirm the engine stayed browser-free**

`packages/extension/tests/coreBoundary.test.ts` guards that `@lurkloot/core` imports no WXT or
browser globals. Nothing in this plan adds one, but confirm the guard passed inside `pnpm check`
rather than assuming it.

- [ ] **Step 3: Sanity-check the generated CLI config**

`defaultConfigJsonc()` in `packages/cli/src/config.ts` generates the template. Confirm its output
puts `autoClaimChannelPoints` under `platform.twitch`, `autoClaimChallenges` under `platform.kick`,
and neither at the top level — and that the generated text still round-trips through
`parseConfig` without offenders. `packages/cli/tests/config.test.ts` is the place to assert this.

- [ ] **Step 4: Note the breaking CLI change for the release**

Removing the top-level `autoClaimChannelPoints` means an existing CLI config carrying it now fails
`parseCliSettings` with `unknown CLI setting "autoClaimChannelPoints"`. The value still migrates
through `mergeEngineSettings` for stored extension settings, but CLI users must edit their config.
Call this out in the PR description so it reaches the release notes.

---

## Open Risk

The Kick response shapes come from the issue's captures, not a live session. Two unknowns remain and
are only settled by running against a real Kick account:

- The `status` value for an unclaimed-but-complete challenge is undocumented. Eligibility keys off
  `claimed_at` and the progress threshold instead, so this should not matter.
- Whether `POST /claim` is idempotent or errors on a double-claim is unknown. The per-challenge
  try/catch in Task 3 keeps either behavior harmless.

If the live shapes differ, Task 3 is the only task that needs revisiting.
