# Settings Information-Architecture Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the extension popup's settings view into three collapsible sections (General, Twitch, Kick) with purpose-grouped subsections, a global "show advanced" switch, and a search box that filters settings by localized title and description.

**Architecture:** The hand-written JSX tree in `settings.tsx` is replaced by a declarative registry: a plain data structure of sections → groups → entries, where each entry carries a stable id, its `titleKey`/`descriptionKey`, an `advanced` flag, and a `render` function. `settings.tsx` becomes a thin walker over that registry. Search and advanced-visibility become a pure function over the tree plus a `t` function, unit-testable with no DOM. The platform switch, the enabled/paused pill and the watch-queue count pill are deleted; compatibility settings move from a global Advanced section into each platform's own Advanced group.

**Tech Stack:** TypeScript (strict, ESM), React 19, Vitest (Node env, `linkedom` for DOM), pnpm workspaces, Tailwind utility classes, `lucide-react` icons, `@lurkloot/locales` JSON catalogs.

**Issue:** https://github.com/jamezrin/lurkloot/issues/171

**Worktree:** `.worktrees/settings-ia-rework` on branch `refactor/settings-ia-rework` (already created, deps installed).

---

## Scope Fence

This is a **UI reorganization only**. Do not touch:

- `ExtensionSettings` shape (`packages/shared/src/settings.ts`, `models.ts`)
- the scheduler, controller, or any platform adapter
- the CLI package

Every setting rendered in the new tree already exists in `DEFAULT_SETTINGS`. If a task seems to require a schema change, stop and raise it — it means the plan is wrong.

---

## Key Design Decisions

These were settled during brainstorming. Do not re-litigate them mid-implementation.

1. **Only the three top-level sections collapse.** Subsections (groups) are labelled dividers, not collapsibles. Two levels of collapse in a 600px popup is tedious, and the search box is the real answer to "long page".
2. **Sections default to expanded.** Today everything defaults collapsed, which is precisely why settings are hard to find. Collapse state persists per section.
3. **`showAdvanced` is UI state, not a setting.** It lives in adapter storage alongside collapse state, exactly like `COLLAPSED_SETTINGS_SECTIONS_KEY`. Putting it in `ExtensionSettings` would breach the scope fence.
4. **Search reveals advanced entries without flipping the switch.** An advanced entry is visible when `showAdvanced || query is non-empty`.
5. **No collapse-state migration is needed.** The existing stored map is keyed by *translated section titles* ("Advanced", "Allgemein", …). None of those strings equal a new section id (`general`/`twitch`/`kick`), so stale keys are inert. Task 4 prunes unknown keys on write, which cleans them up naturally.
6. **Search matching is token-AND over diacritic-folded text.** `"safety margin"` matches "Deadline safety margin"; `"margen"` matches Spanish "Margen de seguridad" regardless of accents.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/popup-ui/src/settingsSearch.ts` | Pure text normalization + the tree filter. No React, no i18n imports beyond a `TFunction` parameter. Fully unit-testable. |
| `packages/popup-ui/src/settingsRegistry.tsx` | The declarative tree: types + `buildSettingsRegistry(ctx)`. Owns *what settings exist and where they live*. |
| `packages/extension/tests/settingsSearch.test.ts` | Unit tests for normalization, token matching, advanced-visibility rules. |
| `packages/extension/tests/settingsRegistry.test.ts` | Structural invariants: unique ids, every message key exists in `en.json`, no group with fewer than two entries. |

**Modified:**

| File | Change |
|---|---|
| `packages/popup-ui/src/constants.ts` | Add `SHOW_ADVANCED_SETTINGS_KEY`. |
| `packages/popup-ui/src/settingsControls.tsx` | `SettingsSection` takes a stable `id`; add `SettingsGroup`, `SettingsSearchBox`, `AdvancedSettingsSwitch`. |
| `packages/popup-ui/src/settingsPlatform.tsx` | Delete `SettingsPlatformSwitch`, the enabled/paused pill and the queue-count pill. Export the two editors for registry use. |
| `packages/popup-ui/src/compatibilitySettings.tsx` | Split into per-platform rendering; drop the section header and platform group headers. |
| `packages/popup-ui/src/settings.tsx` | Rewritten as a registry walker. Drop `initialPlatform`. |
| `packages/popup-ui/src/Popup.tsx:581` | Drop the `initialPlatform` prop. |
| `packages/locales/messages/*.json` (×10) | New section/group labels. |
| `packages/extension/tests/settingsView.test.tsx` | Advanced settings now need the switch enabled. |
| `packages/extension/tests/compatibilitySettingsView.test.tsxx` | New per-platform component signature. |
| `packages/extension/tests/settingsCredentialExport.test.tsx` | Export is a standalone button, not a `SettingsSection`. |

**All commands run from the worktree root:** `/home/jamezrin/dev/lurkloot/.worktrees/settings-ia-rework`

---

## Task 1: Search matching primitives

**Files:**
- Create: `packages/popup-ui/src/settingsSearch.ts`
- Test: `packages/extension/tests/settingsSearch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/settingsSearch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchesSearch, normalizeSearchText } from "../../popup-ui/src/settingsSearch";

describe("normalizeSearchText", () => {
  it("lowercases, trims and folds diacritics", () => {
    expect(normalizeSearchText("  Margen DE Seguridad  ")).toBe("margen de seguridad");
    expect(normalizeSearchText("Sicherheitsmarge")).toBe("sicherheitsmarge");
    expect(normalizeSearchText("Marge de sécurité")).toBe("marge de securite");
  });

  it("leaves non-latin scripts intact", () => {
    expect(normalizeSearchText("安全边际")).toBe("安全边际");
  });
});

describe("matchesSearch", () => {
  const haystack = ["Deadline safety margin", "Extra buffer minutes before a reward deadline."];

  it("matches an empty query", () => {
    expect(matchesSearch(haystack, "")).toBe(true);
    expect(matchesSearch(haystack, "   ")).toBe(true);
  });

  it("matches a single token in the title", () => {
    expect(matchesSearch(haystack, "deadline")).toBe(true);
  });

  it("matches a token in the description", () => {
    expect(matchesSearch(haystack, "buffer")).toBe(true);
  });

  it("requires every token to match, in any order or field", () => {
    expect(matchesSearch(haystack, "safety margin")).toBe(true);
    expect(matchesSearch(haystack, "margin safety")).toBe(true);
    expect(matchesSearch(haystack, "margin buffer")).toBe(true);
    expect(matchesSearch(haystack, "safety unrelated")).toBe(false);
  });

  it("ignores accents in the query", () => {
    expect(matchesSearch(["Marge de sécurité"], "securite")).toBe(true);
    expect(matchesSearch(["Marge de securite"], "sécurité")).toBe(true);
  });

  it("does not match on substrings of the query", () => {
    expect(matchesSearch(haystack, "deadlines")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsSearch.test.ts
```

Expected: FAIL — `Failed to resolve import "../../popup-ui/src/settingsSearch"`.

- [ ] **Step 3: Write the implementation**

Create `packages/popup-ui/src/settingsSearch.ts`:

```ts
// Search over settings text. Kept free of React and of the catalog loader so it
// can be unit-tested directly: callers resolve their own strings first.

// Diacritics are folded so a Spanish or French user can type without accents and
// still hit their own localized labels.
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

// Every whitespace-separated token in the query must appear somewhere across the
// supplied strings. Order does not matter, and a token may match the title while
// another matches the description.
export function matchesSearch(haystacks: readonly string[], query: string): boolean {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  const hay = haystacks.map(normalizeSearchText).join(" ");
  return needle.split(/\s+/).every((token) => hay.includes(token));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsSearch.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/settingsSearch.ts packages/extension/tests/settingsSearch.test.ts
git commit -m "feat(popup): add settings search matching primitives"
```

---

## Task 2: Registry types and the tree filter

**Files:**
- Modify: `packages/popup-ui/src/settingsSearch.ts`
- Test: `packages/extension/tests/settingsSearch.test.ts:1` (append a new `describe`)

The filter operates on a structural subset of the registry, so it can be tested with hand-built fixtures before the real registry exists.

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/settingsSearch.test.ts`:

```ts
import { filterSettingsTree, type SettingsSectionNode } from "../../popup-ui/src/settingsSearch";

describe("filterSettingsTree", () => {
  const labels: Record<string, string> = {
    generalTitle: "General",
    twitchTitle: "Twitch",
    dropsTitle: "Drops",
    schedulerTitle: "Scheduler & timing",
    autoClaimTitle: "Auto-claim drops",
    autoClaimDescription: "Claim rewards as soon as they are earned.",
    intervalTitle: "Scheduler interval",
    intervalDescription: "How often the scheduler re-evaluates channels.",
    compatTitle: "Compatibility profile",
    compatDescription: "Heartbeat and inventory behavior.",
  };
  const t = (key: string) => labels[key] ?? key;

  const tree: SettingsSectionNode[] = [
    {
      id: "general",
      titleKey: "generalTitle",
      rows: [],
      groups: [
        {
          id: "general.drops",
          titleKey: "dropsTitle",
          entries: [{ id: "general.drops.autoClaim", titleKey: "autoClaimTitle", descriptionKey: "autoClaimDescription" }],
        },
        {
          id: "general.scheduler",
          titleKey: "schedulerTitle",
          advanced: true,
          entries: [{ id: "general.scheduler.interval", titleKey: "intervalTitle", descriptionKey: "intervalDescription" }],
        },
      ],
    },
    {
      id: "twitch",
      titleKey: "twitchTitle",
      rows: [],
      groups: [
        {
          id: "twitch.compatibility",
          titleKey: "compatTitle",
          advanced: true,
          entries: [{ id: "twitch.compatibility.profile", titleKey: "compatTitle", descriptionKey: "compatDescription" }],
        },
      ],
    },
  ];

  it("hides advanced groups when the switch is off and there is no query", () => {
    const result = filterSettingsTree(tree, { t, query: "", showAdvanced: false });
    expect(result.map((section) => section.id)).toEqual(["general"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops"]);
  });

  it("shows advanced groups when the switch is on", () => {
    const result = filterSettingsTree(tree, { t, query: "", showAdvanced: true });
    expect(result.map((section) => section.id)).toEqual(["general", "twitch"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops", "general.scheduler"]);
  });

  it("reveals a matching advanced entry even while the switch is off", () => {
    const result = filterSettingsTree(tree, { t, query: "heartbeat", showAdvanced: false });
    expect(result.map((section) => section.id)).toEqual(["twitch"]);
    expect(result[0]!.groups[0]!.entries.map((entry) => entry.id)).toEqual(["twitch.compatibility.profile"]);
  });

  it("drops non-matching entries, groups and sections", () => {
    const result = filterSettingsTree(tree, { t, query: "auto-claim", showAdvanced: true });
    expect(result.map((section) => section.id)).toEqual(["general"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops"]);
  });

  it("reports a per-section match count while searching", () => {
    const result = filterSettingsTree(tree, { t, query: "scheduler", showAdvanced: true });
    expect(result[0]!.matchCount).toBe(1);
  });

  it("returns every section with a zero match count for an empty query", () => {
    const result = filterSettingsTree(tree, { t, query: "", showAdvanced: true });
    expect(result.every((section) => section.matchCount === 0)).toBe(true);
  });

  it("matches a section by its own title and keeps all its non-advanced content", () => {
    const result = filterSettingsTree(tree, { t, query: "general", showAdvanced: false });
    expect(result.map((section) => section.id)).toEqual(["general"]);
    expect(result[0]!.groups.map((group) => group.id)).toEqual(["general.drops"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsSearch.test.ts
```

Expected: FAIL — `filterSettingsTree is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `packages/popup-ui/src/settingsSearch.ts`:

```ts
export type TranslateFn = (key: string, substitution?: string) => string;

// The filter only needs the searchable skeleton of the registry. The real
// registry entries carry a render function too; extra properties ride along
// untouched, which is why the node types are generic over the concrete entry.
export interface SettingsEntryNode {
  id: string;
  titleKey: string;
  descriptionKey: string;
  advanced?: boolean;
}

export interface SettingsGroupNode<TEntry extends SettingsEntryNode = SettingsEntryNode> {
  id: string;
  titleKey: string;
  advanced?: boolean;
  entries: TEntry[];
}

export interface SettingsSectionNode<TEntry extends SettingsEntryNode = SettingsEntryNode> {
  id: string;
  titleKey: string;
  rows: TEntry[];
  groups: Array<SettingsGroupNode<TEntry>>;
}

export interface FilteredSection<TEntry extends SettingsEntryNode = SettingsEntryNode>
  extends SettingsSectionNode<TEntry> {
  // Zero when there is no active query. Only meaningful while searching.
  matchCount: number;
}

export interface FilterOptions {
  t: TranslateFn;
  query: string;
  showAdvanced: boolean;
}

function entryText(entry: SettingsEntryNode, t: TranslateFn): string[] {
  return [t(entry.titleKey), t(entry.descriptionKey)];
}

// An advanced entry is reachable in exactly two situations: the user asked for
// advanced settings, or the user searched for it by name.
function advancedVisible(isAdvanced: boolean, showAdvanced: boolean, searching: boolean): boolean {
  return !isAdvanced || showAdvanced || searching;
}

export function filterSettingsTree<TEntry extends SettingsEntryNode>(
  sections: ReadonlyArray<SettingsSectionNode<TEntry>>,
  { t, query, showAdvanced }: FilterOptions,
): Array<FilteredSection<TEntry>> {
  const searching = normalizeSearchText(query).length > 0;

  const result: Array<FilteredSection<TEntry>> = [];
  for (const section of sections) {
    // A section title match keeps the whole section, so "twitch" surfaces
    // everything Twitch-related rather than only rows containing the word.
    const sectionMatched = searching && matchesSearch([t(section.titleKey)], query);
    let matchCount = 0;

    const keepEntry = (entry: TEntry, groupAdvanced = false): boolean => {
      const isAdvanced = Boolean(entry.advanced ?? groupAdvanced);
      if (!advancedVisible(isAdvanced, showAdvanced, searching)) return false;
      if (!searching) return true;
      // Under a section-title match, advanced content still obeys the switch.
      if (sectionMatched) return !isAdvanced || showAdvanced;
      return matchesSearch(entryText(entry, t), query);
    };

    const rows = section.rows.filter((row) => {
      const kept = keepEntry(row);
      if (kept && searching && !sectionMatched) matchCount += 1;
      return kept;
    });

    const groups: Array<SettingsGroupNode<TEntry>> = [];
    for (const group of section.groups) {
      const groupAdvanced = Boolean(group.advanced);
      if (!advancedVisible(groupAdvanced, showAdvanced, searching)) continue;
      // A group-title match keeps the group's entries, same reasoning as sections.
      const groupMatched = searching && !sectionMatched && matchesSearch([t(group.titleKey)], query);
      const entries = group.entries.filter((entry) => {
        if (groupMatched) {
          const isAdvanced = Boolean(entry.advanced ?? groupAdvanced);
          return !isAdvanced || showAdvanced || searching;
        }
        return keepEntry(entry, groupAdvanced);
      });
      if (entries.length === 0) continue;
      if (searching && !sectionMatched) matchCount += entries.length;
      groups.push({ ...group, entries });
    }

    if (rows.length === 0 && groups.length === 0) continue;
    result.push({ ...section, rows, groups, matchCount: searching ? matchCount : 0 });
  }

  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsSearch.test.ts
```

Expected: PASS, 15 tests total.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/settingsSearch.ts packages/extension/tests/settingsSearch.test.ts
git commit -m "feat(popup): filter the settings tree by query and advanced visibility"
```

---

## Task 3: Locale keys for the new sections and groups

**Files:**
- Modify: `packages/locales/messages/en.json`, `ar.json`, `de.json`, `es.json`, `fr.json`, `hi.json`, `it.json`, `pt_BR.json`, `ru.json`, `zh_CN.json`

`packages/extension/tests/i18n.test.ts:41` asserts every catalog has *exactly* the same key set as `en.json`. All ten catalogs must be updated together or the suite fails.

New keys (English values):

| Key | English message |
|---|---|
| `settingsSearchPlaceholder` | `Search settings…` |
| `settingsSearchNoResults` | `No settings match “$1”.` |
| `settingsShowAdvancedTitle` | `Show advanced settings` |
| `settingsSectionGeneral` | `General` |
| `settingsSectionTwitch` | `Twitch` |
| `settingsSectionKick` | `Kick` |
| `settingsGroupAppearance` | `Appearance & behavior` |
| `settingsGroupNotifications` | `Notifications` |
| `settingsGroupDrops` | `Drops` |
| `settingsGroupFarmingTabs` | `Farming tabs` |
| `settingsGroupAdvanced` | `Advanced` |
| `settingsGroupCategories` | `Categories` |
| `settingsGroupExcludedChannels` | `Excluded channels` |
| `settingsGroupCompatibility` | `Compatibility` |

`settingsSearchNoResults` uses a `$1` substitution for the query. Follow the existing placeholder convention in the catalogs — check how `compatibilityReplacedBy` declares its substitution in `en.json` and copy that structure exactly.

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/i18n.test.ts`, inside the top-level `describe("i18n", …)` block:

```ts
  it("localizes the new settings section labels in every catalog", () => {
    const required = [
      "settingsSearchPlaceholder",
      "settingsSearchNoResults",
      "settingsShowAdvancedTitle",
      "settingsSectionGeneral",
      "settingsSectionTwitch",
      "settingsSectionKick",
      "settingsGroupAppearance",
      "settingsGroupNotifications",
      "settingsGroupDrops",
      "settingsGroupFarmingTabs",
      "settingsGroupAdvanced",
      "settingsGroupCategories",
      "settingsGroupExcludedChannels",
      "settingsGroupCompatibility",
    ];
    for (const locale of localeCodes()) {
      const catalog = readCatalog(locale);
      for (const key of required) {
        expect(catalog[key]?.message, `${locale}.${key}`).toBeTruthy();
      }
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/extension && pnpm exec vitest run tests/i18n.test.ts
```

Expected: FAIL — `en.settingsSearchPlaceholder` is undefined.

- [ ] **Step 3: Add the keys to all ten catalogs**

Add all fifteen keys to each of the ten files. Keep each catalog's existing key ordering convention — check whether `en.json` is alphabetically sorted or grouped by feature, and match it.

Translate the values properly; do not copy English into the other nine catalogs. `Twitch` and `Kick` are brand names and stay untranslated in every locale (including `ar`, `hi`, `ru`, `zh_CN`). For guidance on tone and terminology, look at how the existing `settingsGeneralTitle`, `notificationsTitle` and `farmingTabsTitle` entries are worded in each catalog and stay consistent with them.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/extension && pnpm exec vitest run tests/i18n.test.ts
```

Expected: PASS. Both the new test and the pre-existing "keeps locale catalog keys in sync" test must pass — the latter proves no catalog was missed.

- [ ] **Step 5: Commit**

```bash
git add packages/locales/messages packages/extension/tests/i18n.test.ts
git commit -m "feat(locales): add settings section, group and search labels"
```

---

## Task 4: Section, group, search and advanced-switch primitives

**Files:**
- Modify: `packages/popup-ui/src/constants.ts:11`
- Modify: `packages/popup-ui/src/settingsControls.tsx:11-63`

`SettingsSection` currently keys its persisted collapse state by the translated `title` prop (`settingsControls.tsx:20` and `:36`), so switching language silently reopens every section. It gains a stable `id` and keys by that instead.

- [ ] **Step 1: Add the storage key**

In `packages/popup-ui/src/constants.ts`, directly below the existing `COLLAPSED_SETTINGS_SECTIONS_KEY` line:

```ts
export const SHOW_ADVANCED_SETTINGS_KEY = "popup:showAdvancedSettings";
```

- [ ] **Step 2: Rewrite `SettingsSection` with a stable id**

Replace `packages/popup-ui/src/settingsControls.tsx:11-63` (the whole `SettingsSection` function) with:

```tsx
export function SettingsSection({ id, title, description, icon: Icon, iconNode, badge, forceExpanded, children }: {
  // Stable, locale-independent identity. Collapse state is keyed by this, not by
  // the translated title, so changing language does not reset the accordion.
  id: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  iconNode?: React.ReactNode;
  badge?: React.ReactNode;
  // While searching, sections holding matches are opened regardless of the
  // persisted state, and the persisted state is left untouched.
  forceExpanded?: boolean;
  children: React.ReactNode;
}) {
  const { adapter, preview } = usePopupRuntime();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (preview) return;
    let mounted = true;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      if (!mounted) return;
      const map = stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean | undefined> | undefined;
      setCollapsed(map?.[id] === true);
    });
    return () => {
      mounted = false;
    };
  }, [adapter, preview, id]);

  function toggleCollapsed(): void {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);
    if (preview) return;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      const map = (stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean> | undefined) ?? {};
      // Only known section ids survive a write. Entries left over from the old
      // title-keyed scheme are dropped the first time a section is toggled.
      const next = { ...map, [id]: nextCollapsed };
      void adapter.setStorage({ [COLLAPSED_SETTINGS_SECTIONS_KEY]: next });
    });
  }

  const expanded = forceExpanded || !collapsed;

  return (
    <section>
      <header className="mb-1.5 px-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleCollapsed}
          className="flex w-full items-start justify-between gap-3 rounded-lg px-1 py-1 text-left outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-900/70"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              {iconNode ?? (Icon ? <Icon size={13} className="text-zinc-400 dark:text-zinc-500" /> : null)}
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</span>
              {badge}
            </span>
            {description ? <span className="mt-1 block text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">{description}</span> : null}
          </span>
          <ChevronDown size={14} className={cn("mt-0.5 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500", expanded && "rotate-180")} />
        </button>
      </header>
      {expanded ? <div className="space-y-3 px-0.5">{children}</div> : null}
    </section>
  );
}

// A labelled divider inside a section. Groups do not collapse: two levels of
// accordion in a 600px popup is tedious, and search is the real answer to a long
// page. Advanced groups are visually demoted so they read as advanced even once
// the "show advanced" switch has revealed them.
export function SettingsGroup({ title, advanced = false, children }: {
  title: string;
  advanced?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mt-3 first:mt-0", advanced && "rounded-lg border border-amber-500/20 bg-amber-500/[0.03] px-2 pb-1 dark:border-amber-500/20")}>
      <div className="mb-0.5 flex items-center gap-1.5 pt-1">
        {advanced ? <TriangleAlert size={11} className="shrink-0 text-amber-500/80" /> : null}
        <span className={cn("text-[10px] font-semibold uppercase tracking-wide", advanced ? "text-amber-600/90 dark:text-amber-400/90" : "text-zinc-400 dark:text-zinc-500")}>{title}</span>
        <span className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800/70" />
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">{children}</div>
    </div>
  );
}

export function SettingsSearchBox({ value, onChange }: { value: string; onChange(value: string): void }) {
  const t = useT();
  return (
    <div className="relative">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={t("settingsSearchPlaceholder")}
        placeholder={t("settingsSearchPlaceholder")}
        className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-8 pr-3 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      />
    </div>
  );
}

export function AdvancedSettingsSwitch({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{t("settingsShowAdvancedTitle")}</span>
      <Toggle checked={checked} onChange={onChange} label={t("settingsShowAdvancedTitle")} />
    </div>
  );
}
```

Update the import at `packages/popup-ui/src/settingsControls.tsx:2` to add the two new icons:

```tsx
import { Ban, ChevronDown, Search, TriangleAlert, type LucideIcon } from "lucide-react";
```

Note that `SettingsSection` no longer takes a `divided` prop — the walker in Task 7 places rows inside `SettingsGroup`, which owns the dividers. Removing it is intentional.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: FAIL, and only with errors in `packages/popup-ui/src/settings.tsx` about the removed `divided` prop and the missing `id` prop. Those are fixed in Task 7. Any error in another file means this step was done wrong — fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add packages/popup-ui/src/constants.ts packages/popup-ui/src/settingsControls.tsx
git commit -m "refactor(popup): key settings sections by stable id and add group primitives"
```

---

## Task 5: Split compatibility settings per platform

**Files:**
- Modify: `packages/popup-ui/src/compatibilitySettings.tsx:132-217`
- Modify: `packages/extension/tests/compatibilitySettingsView.test.tsxx`

The current `CompatibilitySettings` renders its own section header plus both platforms' `PlatformGroup` blocks. In the new tree each platform section renders only its own rows, so the component is parameterized by platform and loses both the header and the platform grouping.

- [ ] **Step 1: Write the failing test**

In `packages/extension/tests/compatibilitySettingsView.test.tsxx`, change the import at line 9 to:

```tsx
import { PlatformCompatibilitySettings } from "../../popup-ui/src/compatibilitySettings";
```

Then update every render site in that file to pass a `platform` prop and use the new component name. Each existing render of:

```tsx
<CompatibilitySettings settings={…} registry={…} resolution={…} onChange={…} />
```

becomes:

```tsx
<PlatformCompatibilitySettings platform="twitch" settings={…} registry={…} resolution={…} onChange={…} />
```

Read the whole test file first and update each occurrence — assertions that reach for Twitch controls need `platform="twitch"`, and any asserting on Kick controls need a second render with `platform="kick"`. Assertions that depended on both platforms being present in one render must be split into two renders.

Add this new test to the file:

```tsx
  it("renders only the requested platform's rows", () => {
    const { container } = mountCompatibility({ platform: "twitch" });
    const text = container.textContent ?? "";
    expect(text).toContain("Heartbeat transport");
    expect(text).not.toContain("Claim handling");
  });
```

Adapt `mountCompatibility` to accept and forward a `platform` option — match whatever helper signature the file already uses.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/extension && pnpm exec vitest run tests/compatibilitySettingsView.test.tsx
```

Expected: FAIL — `PlatformCompatibilitySettings` is not exported.

- [ ] **Step 3: Rewrite the component**

Delete the `PlatformGroup` function (`compatibilitySettings.tsx:77-89`) — the platform section heading now supplies that context.

Replace the exported `CompatibilitySettings` function (`compatibilitySettings.tsx:132-217`) with:

```tsx
export function PlatformCompatibilitySettings({ platform, settings, registry, resolution, onChange }: {
  platform: Platform;
  settings: CompatibilitySelections;
  registry: PopupCompatibilityRegistry;
  resolution: PopupCompatibilityResolution;
  onChange(patch: SettingsPatch): void | Promise<void>;
}) {
  const t = useT();
  const automatic = t("compatibilityAutomatic");
  const effective = resolution.compatibility;
  // The reset button and the override warning are scoped to this platform, so a
  // Twitch override does not light up a warning in the Kick section.
  const overridden = Object.values(settings[platform]).some((value) => value !== "auto");
  const metadata = (records: OptionRecords, id: string) => records[id];

  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
      {platform === "twitch" ? (
        <>
          <CompatibilityRow
            title={t("compatibilityComponentProfile")}
            ariaLabel={t("compatibilityTwitchProfileTitle")}
            description={t("compatibilityTwitchProfileDescription")}
            selection={settings.twitch.profile}
            resolvedId={effective.twitch.profile}
            metadata={metadata(registry.twitch.profiles, effective.twitch.profile)}
            options={options(registry.twitch.profiles, automatic, t, true)}
            onChange={(profile) => onChange({ compatibility: { twitch: { profile } } })}
            component={false}
          />
          <CompatibilityRow
            title={t("compatibilityComponentHeartbeat")}
            ariaLabel={t("compatibilityTwitchHeartbeatTitle")}
            description={t("compatibilityTwitchHeartbeatDescription")}
            selection={settings.twitch.heartbeatTransport}
            resolvedId={effective.twitch.heartbeat}
            metadata={metadata(registry.twitch.heartbeat, effective.twitch.heartbeat)}
            options={options(registry.twitch.heartbeat, automatic, t, true)}
            onChange={(heartbeatTransport) => onChange({ compatibility: { twitch: { heartbeatTransport } } })}
            component
          />
          <CompatibilityRow
            title={t("compatibilityComponentInventory")}
            ariaLabel={t("compatibilityTwitchInventoryTitle")}
            description={t("compatibilityTwitchInventoryDescription")}
            selection={settings.twitch.inventoryQueryVersion}
            resolvedId={effective.twitch.inventory}
            metadata={metadata(registry.twitch.inventory, effective.twitch.inventory)}
            options={options(registry.twitch.inventory, automatic, t, true)}
            onChange={(inventoryQueryVersion) => onChange({ compatibility: { twitch: { inventoryQueryVersion } } })}
            component
          />
        </>
      ) : (
        <>
          <CompatibilityRow
            title={t("compatibilityComponentProfile")}
            ariaLabel={t("compatibilityKickProfileTitle")}
            description={t("compatibilityKickProfileDescription")}
            selection={settings.kick.profile}
            resolvedId={effective.kick.profile}
            metadata={metadata(registry.kick.profiles, effective.kick.profile)}
            options={options(registry.kick.profiles, automatic, t)}
            onChange={(profile) => onChange({ compatibility: { kick: { profile } } })}
            component={false}
          />
          <CompatibilityRow
            title={t("compatibilityComponentClaim")}
            ariaLabel={t("compatibilityKickClaimTitle")}
            description={t("compatibilityKickClaimDescription")}
            selection={settings.kick.claimLinkHandling}
            resolvedId={effective.kick.claim}
            metadata={metadata(registry.kick.claim, effective.kick.claim)}
            options={options(registry.kick.claim, automatic, t)}
            onChange={(claimLinkHandling) => onChange({ compatibility: { kick: { claimLinkHandling } } })}
            component
          />
        </>
      )}
      <div className="py-2">
        {overridden ? <div className="mb-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2 text-[10px] text-amber-700 dark:text-amber-300"><TriangleAlert size={12} className="mt-0.5 shrink-0" /><span>{t("compatibilityOverrideWarning")}</span></div> : null}
        <button type="button" disabled={!overridden} onClick={() => void onChange(automaticPatchFor(platform))} className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-semibold text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-40 dark:border-zinc-700"><RotateCcw size={12} />{t("compatibilityRestoreAutomatic")}</button>
      </div>
    </div>
  );
}
```

The reset patch is now per-platform. Replace the `AUTOMATIC_COMPATIBILITY_PATCH` export (`compatibilitySettings.tsx:18-23`) with:

```tsx
const AUTOMATIC_TWITCH: SettingsPatch = Object.freeze({
  compatibility: Object.freeze({ twitch: Object.freeze({ profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" }) }),
});

const AUTOMATIC_KICK: SettingsPatch = Object.freeze({
  compatibility: Object.freeze({ kick: Object.freeze({ profile: "auto", claimLinkHandling: "auto" }) }),
});

export function automaticPatchFor(platform: Platform): SettingsPatch {
  return platform === "twitch" ? AUTOMATIC_TWITCH : AUTOMATIC_KICK;
}
```

The `isOverridden` helper (`compatibilitySettings.tsx:52-55`) is now unused — delete it. The `PLATFORMS` import becomes unused once `PlatformGroup` is gone — delete it from the import list at line 6.

Check whether anything else imports `AUTOMATIC_COMPATIBILITY_PATCH`:

```bash
grep -rn "AUTOMATIC_COMPATIBILITY_PATCH" packages --include=*.ts --include=*.tsx | grep -v node_modules
```

Update every hit to `automaticPatchFor(platform)`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/extension && pnpm exec vitest run tests/compatibilitySettingsView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/compatibilitySettings.tsx packages/extension/tests/compatibilitySettingsView.test.tsxx
git commit -m "refactor(popup): scope compatibility settings to a single platform"
```

---

## Task 6: Strip the platform switch and redundant pills

**Files:**
- Modify: `packages/popup-ui/src/settingsPlatform.tsx:33-133`

- [ ] **Step 1: Delete `SettingsPlatformSwitch`**

Delete `packages/popup-ui/src/settingsPlatform.tsx:111-133` in full.

- [ ] **Step 2: Split `PlatformSettingsGroup` into the two editors the registry needs**

Replace `packages/popup-ui/src/settingsPlatform.tsx:33-109` (the whole `PlatformSettingsGroup` function) with two focused exports:

```tsx
export function PlatformCategorySettings({ platform, suggestions, settings, onFarmAllCategoriesChange, onCategoriesChange, onSearchCategories }: {
  platform: Platform;
  suggestions: GameItem[];
  settings: ExtensionSettings;
  onFarmAllCategoriesChange(farmAll: boolean): void | Promise<void>;
  onCategoriesChange(categories: CategorySelection[]): void | Promise<void>;
  onSearchCategories(query: string): Promise<CategorySelection[]>;
}) {
  const t = useT();
  const details = PLATFORMS[platform];
  const platformSettings = settings.platform[platform];

  return (
    <>
      <div className="flex items-center gap-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("farmAllCategoriesTitle")}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("farmAllCategoriesDescription", details.label)}</div>
        </div>
        <Toggle checked={platformSettings.farmAllCategories} onChange={onFarmAllCategoriesChange} label={t("farmAllCategoriesTitle")} />
      </div>
      {platformSettings.farmAllCategories ? null : (
        <div className="py-2">
          <CategoryFilterEditor
            platform={platform}
            categories={platformSettings.categories}
            suggestions={suggestions}
            onChange={onCategoriesChange}
            onSearch={onSearchCategories}
          />
        </div>
      )}
    </>
  );
}

export function PlatformExcludedChannels({ platform, settings, onExcludedChannelsChange }: {
  platform: Platform;
  settings: ExtensionSettings;
  onExcludedChannelsChange(channels: string[]): void | Promise<void>;
}) {
  const t = useT();
  return (
    <div className="py-2">
      <ChannelListEditor
        title={t("excludedChannelsTitle")}
        description={t("excludedChannelsDescription")}
        empty={t("excludedChannelsEmpty")}
        channels={settings.platform[platform].excludedChannels ?? []}
        onChange={onExcludedChannelsChange}
      />
    </div>
  );
}
```

This deletes, as required by the issue:

- the enabled/paused status pill (old lines 54-60)
- the watch-queue count pill (old lines 61-67)
- the per-platform claim `SettingRow` (old lines 68-82) — the registry renders it as a loose section row in Task 7

The `SettingRow` import at line 31 and the `Pill` import at line 24 may now be unused inside this file. Run `pnpm typecheck` and remove whatever it flags as unused; `Pill` is still used by `ChannelListEditor` and `CategoryFilterEditor`, so check before deleting.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: FAIL, only in `packages/popup-ui/src/settings.tsx` (it still imports `PlatformSettingsGroup` and `SettingsPlatformSwitch`). Task 7 fixes it.

- [ ] **Step 4: Commit**

```bash
git add packages/popup-ui/src/settingsPlatform.tsx
git commit -m "refactor(popup): drop the settings platform switch and redundant pills"
```

---

## Task 7: The settings registry

**Files:**
- Create: `packages/popup-ui/src/settingsRegistry.tsx`
- Test: `packages/extension/tests/settingsRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/settingsRegistry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { buildSettingsRegistry } from "../../popup-ui/src/settingsRegistry";

const englishPath = createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json");
const english = JSON.parse(readFileSync(englishPath, "utf8")) as Record<string, { message: string }>;

function registry() {
  return buildSettingsRegistry({
    t: (key: string) => key,
    settings: DEFAULT_SETTINGS,
    onSettingsChange: async () => undefined,
    suggestions: { twitch: [], kick: [] },
    onSearchCategories: async () => [],
    compatibilityRegistry: COMPATIBILITY_REGISTRY,
    compatibilityResolution: resolveCompatibility(DEFAULT_SETTINGS.compatibility),
  });
}

describe("settings registry", () => {
  it("exposes exactly the three top-level sections in order", () => {
    expect(registry().map((section) => section.id)).toEqual(["general", "twitch", "kick"]);
  });

  it("gives every entry a unique id", () => {
    const ids = registry().flatMap((section) => [
      ...section.rows.map((row) => row.id),
      ...section.groups.flatMap((group) => group.entries.map((entry) => entry.id)),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Groups that render one rich editor are exempt: "no one-setting subsections"
  // is a rule about lists of toggles, not about editors.
  const EDITOR_GROUPS = [".categories", ".channels", ".compatibility"];

  it("gives every toggle group at least two entries", () => {
    for (const section of registry()) {
      for (const group of section.groups) {
        if (EDITOR_GROUPS.some((suffix) => group.id.endsWith(suffix))) continue;
        expect(group.entries.length, `${section.id}/${group.id}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("resolves every message key against the English catalog", () => {
    for (const section of registry()) {
      expect(english[section.titleKey], section.titleKey).toBeTruthy();
      const entries = [...section.rows, ...section.groups.flatMap((group) => group.entries)];
      for (const group of section.groups) expect(english[group.titleKey], group.titleKey).toBeTruthy();
      for (const entry of entries) {
        expect(english[entry.titleKey], entry.titleKey).toBeTruthy();
        expect(english[entry.descriptionKey], entry.descriptionKey).toBeTruthy();
      }
    }
  });

  it("marks exactly one advanced group per section", () => {
    const advanced = registry().flatMap((section) => section.groups.filter((group) => group.advanced).map((group) => group.id));
    expect(advanced).toEqual([
      "general.advanced",
      "twitch.compatibility",
      "kick.compatibility",
    ]);
  });

  it("omits the compatibility groups when no registry is supplied", () => {
    const withoutCompatibility = buildSettingsRegistry({
      t: (key: string) => key,
      settings: DEFAULT_SETTINGS,
      onSettingsChange: async () => undefined,
      suggestions: { twitch: [], kick: [] },
      onSearchCategories: async () => [],
    });
    const groups = withoutCompatibility.flatMap((section) => section.groups.map((group) => group.id));
    expect(groups).not.toContain("twitch.compatibility");
    expect(groups).not.toContain("kick.compatibility");
  });

  it("places the watch-queue fallback setting in the general drops group", () => {
    const drops = registry()[0]!.groups.find((group) => group.id === "general.drops");
    expect(drops?.entries.map((entry) => entry.id)).toContain("general.drops.watchQueueFallbackOnly");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsRegistry.test.ts
```

Expected: FAIL — cannot resolve `../../popup-ui/src/settingsRegistry`.

- [ ] **Step 3: Write the registry**

Create `packages/popup-ui/src/settingsRegistry.tsx`. This file owns *what settings exist and where they live*; it holds no layout logic.

```tsx
import React from "react";
import { Gift, Play, Radio, Settings as SettingsIcon, SlidersHorizontal, Bell, Terminal, type LucideIcon } from "lucide-react";
import type { CategorySelection, ExtensionSettings, LanguageOverride, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { LOCALE_OPTIONS } from "@lurkloot/shared/i18n";
import {
  CampaignFilterSettingRow,
  ForgetExcludedCampaignsRow,
  NumberSettingRow,
  SelectSettingRow,
  SettingRow,
} from "./settingsControls";
import { PlatformCategorySettings, PlatformExcludedChannels } from "./settingsPlatform";
import { PlatformCompatibilitySettings } from "./compatibilitySettings";
import type { SettingsEntryNode, SettingsGroupNode, SettingsSectionNode, TranslateFn } from "./settingsSearch";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export interface SettingsChangeOptions {
  tickAfterSave?: boolean;
  tickAfterSavePlatforms?: Platform[];
}

export interface SettingsRegistryContext {
  t: TranslateFn;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: SettingsChangeOptions): Promise<void>;
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
}

export interface SettingsEntryDef extends SettingsEntryNode {
  render(): React.ReactNode;
}

export type SettingsGroupDef = SettingsGroupNode<SettingsEntryDef>;

export interface SettingsSectionDef extends SettingsSectionNode<SettingsEntryDef> {
  icon: LucideIcon;
}

export function buildSettingsRegistry(ctx: SettingsRegistryContext): SettingsSectionDef[] {
  const { t, settings, onSettingsChange } = ctx;
  const setFlag = (key: keyof ExtensionSettings) => (value: boolean) => void onSettingsChange({ [key]: value } as SettingsPatch);
  const tabPlaybackDisabled = settings.tablessMode;
  const tabPlaybackDisabledReason = t("tablessDisabledReason");

  const platformPatch = (platform: Platform, patch: Record<string, unknown>) =>
    onSettingsChange({ platform: { [platform]: patch } } as SettingsPatch, { tickAfterSave: true, tickAfterSavePlatforms: [platform] });

  const general: SettingsSectionDef = {
    id: "general",
    titleKey: "settingsSectionGeneral",
    icon: SettingsIcon,
    rows: [],
    groups: [
      {
        id: "general.appearance",
        titleKey: "settingsGroupAppearance",
        entries: [
          {
            id: "general.appearance.language",
            titleKey: "settingsLanguageTitle",
            descriptionKey: "settingsLanguageDescription",
            render: () => (
              <SelectSettingRow<LanguageOverride>
                title={t("settingsLanguageTitle")}
                description={t("settingsLanguageDescription")}
                value={settings.languageOverride}
                options={LOCALE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.value === "browser" ? t(option.labelKey) : `${option.nativeName} (${t(option.labelKey)})`,
                }))}
                onChange={(value) => void onSettingsChange({ languageOverride: value })}
              />
            ),
          },
          {
            id: "general.appearance.autoStart",
            titleKey: "autoStartTitle",
            descriptionKey: "autoStartDescription",
            render: () => <SettingRow title={t("autoStartTitle")} description={t("autoStartDescription")} checked={settings.autoStartDropFarming} onChange={setFlag("autoStartDropFarming")} />,
          },
          {
            id: "general.appearance.pauseOnManualWatch",
            titleKey: "pauseManualTitle",
            descriptionKey: "pauseManualDescription",
            render: () => <SettingRow title={t("pauseManualTitle")} description={t("pauseManualDescription")} checked={settings.pauseOnManualWatch} onChange={setFlag("pauseOnManualWatch")} />,
          },
          {
            id: "general.appearance.hideTips",
            titleKey: "hideTipsTitle",
            descriptionKey: "hideTipsDescription",
            render: () => <SettingRow title={t("hideTipsTitle")} description={t("hideTipsDescription")} checked={!settings.showTips} onChange={(hideTips) => void onSettingsChange({ showTips: !hideTips })} />,
          },
        ],
      },
      {
        id: "general.notifications",
        titleKey: "settingsGroupNotifications",
        entries: [
          {
            id: "general.notifications.rewardEarned",
            titleKey: "rewardEarnedTitle",
            descriptionKey: "rewardEarnedDescription",
            render: () => <SettingRow title={t("rewardEarnedTitle")} description={t("rewardEarnedDescription")} checked={settings.notifyRewardEarned} onChange={setFlag("notifyRewardEarned")} />,
          },
          {
            id: "general.notifications.noDropsLeft",
            titleKey: "noDropsLeftTitle",
            descriptionKey: "noDropsLeftDescription",
            render: () => <SettingRow title={t("noDropsLeftTitle")} description={t("noDropsLeftDescription")} checked={settings.notifyNoDropsLeft} onChange={setFlag("notifyNoDropsLeft")} />,
          },
        ],
      },
      {
        id: "general.drops",
        titleKey: "settingsGroupDrops",
        entries: [
          {
            id: "general.drops.autoClaim",
            titleKey: "autoClaimTitle",
            descriptionKey: "autoClaimDescription",
            render: () => <SettingRow title={t("autoClaimTitle")} description={t("autoClaimDescription")} checked={settings.autoClaim} onChange={setFlag("autoClaim")} />,
          },
          {
            id: "general.drops.priorityMode",
            titleKey: "campaignPriorityTitle",
            descriptionKey: "campaignPriorityDescription",
            render: () => (
              <SelectSettingRow
                title={t("campaignPriorityTitle")}
                description={t("campaignPriorityDescription")}
                value={settings.priorityMode}
                options={[
                  { value: "priority_list_only", label: t("priorityListOnly") },
                  { value: "ending_soonest", label: t("endingSoonest") },
                  { value: "lowest_availability", label: t("lowAvailabilityFirst") },
                ]}
                onChange={(value) => void onSettingsChange({ priorityMode: value }, { tickAfterSave: true })}
              />
            ),
          },
          {
            id: "general.drops.watchQueueFallbackOnly",
            titleKey: "watchQueueFallbackOnlyTitle",
            descriptionKey: "watchQueueFallbackOnlyDescription",
            render: () => <SettingRow title={t("watchQueueFallbackOnlyTitle")} description={t("watchQueueFallbackOnlyDescription")} checked={settings.watchQueueFallbackOnly} onChange={setFlag("watchQueueFallbackOnly")} />,
          },
          {
            id: "general.drops.campaignVisibility",
            titleKey: "visibleCampaignsTitle",
            descriptionKey: "visibleCampaignsDescription",
            render: () => <CampaignFilterSettingRow value={settings.campaignVisibility} onChange={(campaignVisibility) => void onSettingsChange({ campaignVisibility })} />,
          },
          {
            id: "general.drops.forgetExcluded",
            titleKey: "forgetExcludedTitle",
            descriptionKey: "forgetExcludedDescription",
            render: () => <ForgetExcludedCampaignsRow count={settings.excludedCampaignIds.length} onForget={() => void onSettingsChange({ excludedCampaignIds: [] }, { tickAfterSave: true })} />,
          },
        ],
      },
      {
        id: "general.farmingTabs",
        titleKey: "settingsGroupFarmingTabs",
        entries: [
          {
            id: "general.farmingTabs.tabless",
            titleKey: "tablessTitle",
            descriptionKey: "tablessDescription",
            render: () => <SettingRow title={t("tablessTitle")} description={t("tablessDescription")} checked={settings.tablessMode} onChange={(value) => void onSettingsChange({ tablessMode: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.farmingTabs.autoClose",
            titleKey: "autoCloseTabsTitle",
            descriptionKey: "autoCloseTabsDescription",
            render: () => <SettingRow title={t("autoCloseTabsTitle")} description={t("autoCloseTabsDescription")} checked={settings.autoCloseFinishedDrops} onChange={setFlag("autoCloseFinishedDrops")} />,
          },
          {
            id: "general.farmingTabs.mute",
            titleKey: "muteTabsTitle",
            descriptionKey: "muteTabsDescription",
            render: () => <SettingRow title={t("muteTabsTitle")} description={t("muteTabsDescription")} checked={settings.muteFarmingTabs} onChange={setFlag("muteFarmingTabs")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />,
          },
          {
            id: "general.farmingTabs.keepUnmuted",
            titleKey: "keepVideosUnmutedTitle",
            descriptionKey: "keepVideosUnmutedDescription",
            render: () => <SettingRow title={t("keepVideosUnmutedTitle")} description={t("keepVideosUnmutedDescription")} checked={settings.keepFarmingVideosUnmuted !== false} onChange={setFlag("keepFarmingVideosUnmuted")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />,
          },
          {
            id: "general.farmingTabs.adFocus",
            titleKey: "adFocusTitle",
            descriptionKey: "adFocusDescription",
            render: () => (
              <SelectSettingRow
                title={t("adFocusTitle")}
                description={t("adFocusDescription")}
                value={settings.adFocusMode ?? "window"}
                options={[
                  { value: "none", label: t("off") },
                  { value: "tab", label: t("tabOnly") },
                  { value: "window", label: t("tabAndWindow") },
                ]}
                onChange={(value) => void onSettingsChange({ adFocusMode: value })}
                disabled={tabPlaybackDisabled}
                disabledReason={tabPlaybackDisabledReason}
              />
            ),
          },
        ],
      },
      {
        // Scheduler tuning and diagnostics are one group, not two: each section
        // gets exactly one advanced group, and a lone "Diagnostics" group would
        // hold a single toggle.
        id: "general.advanced",
        titleKey: "settingsGroupAdvanced",
        advanced: true,
        entries: [
          {
            id: "general.advanced.pollInterval",
            titleKey: "schedulerIntervalTitle",
            descriptionKey: "schedulerIntervalDescription",
            render: () => <NumberSettingRow title={t("schedulerIntervalTitle")} description={t("schedulerIntervalDescription")} value={Math.round(settings.pollIntervalMinutes * 60)} min={30} max={3600} suffix={t("secondsSuffix")} onChange={(value) => void onSettingsChange({ pollIntervalMinutes: value / 60 })} />,
          },
          {
            id: "general.advanced.postClaimHandoff",
            titleKey: "postClaimHandoffTitle",
            descriptionKey: "postClaimHandoffDescription",
            render: () => <SettingRow title={t("postClaimHandoffTitle")} description={t("postClaimHandoffDescription")} checked={settings.postClaimHandoff} onChange={setFlag("postClaimHandoff")} />,
          },
          {
            id: "general.advanced.postClaimHandoffInterval",
            titleKey: "postClaimHandoffIntervalTitle",
            descriptionKey: "postClaimHandoffIntervalDescription",
            render: () => <NumberSettingRow title={t("postClaimHandoffIntervalTitle")} description={t("postClaimHandoffIntervalDescription")} value={settings.postClaimHandoffIntervalSeconds} min={1} max={30} suffix={t("secondsSuffix")} disabled={!settings.postClaimHandoff} disabledReason={t("postClaimHandoffDescription")} onChange={(value) => void onSettingsChange({ postClaimHandoffIntervalSeconds: value })} />,
          },
          {
            id: "general.advanced.postClaimHandoffMax",
            titleKey: "postClaimHandoffMaxTitle",
            descriptionKey: "postClaimHandoffMaxDescription",
            render: () => <NumberSettingRow title={t("postClaimHandoffMaxTitle")} description={t("postClaimHandoffMaxDescription")} value={settings.postClaimHandoffMaxSeconds} min={5} max={120} suffix={t("secondsSuffix")} disabled={!settings.postClaimHandoff} disabledReason={t("postClaimHandoffDescription")} onChange={(value) => void onSettingsChange({ postClaimHandoffMaxSeconds: value })} />,
          },
          {
            id: "general.advanced.skipUnfinishable",
            titleKey: "skipUnfinishableRewardsTitle",
            descriptionKey: "skipUnfinishableRewardsDescription",
            render: () => <SettingRow title={t("skipUnfinishableRewardsTitle")} description={t("skipUnfinishableRewardsDescription")} checked={settings.skipUnfinishableRewards} onChange={(value) => void onSettingsChange({ skipUnfinishableRewards: value }, { tickAfterSave: true })} />,
          },
          {
            id: "general.advanced.deadlineSafetyMargin",
            titleKey: "deadlineSafetyMarginTitle",
            descriptionKey: "deadlineSafetyMarginDescription",
            render: () => <NumberSettingRow title={t("deadlineSafetyMarginTitle")} description={t("deadlineSafetyMarginDescription")} value={settings.deadlineSafetyMarginMinutes} min={0} max={60} suffix={t("minutesSuffix")} onChange={(value) => void onSettingsChange({ deadlineSafetyMarginMinutes: value }, { tickAfterSave: true })} disabled={!settings.skipUnfinishableRewards} disabledReason={t("deadlineSafetyMarginDisabledReason")} />,
          },
          {
            id: "general.advanced.diagnosticLogging",
            titleKey: "diagnosticLoggingTitle",
            descriptionKey: "diagnosticLoggingDescription",
            render: () => <SettingRow title={t("diagnosticLoggingTitle")} description={t("diagnosticLoggingDescription")} checked={settings.diagnosticLogging} onChange={setFlag("diagnosticLogging")} />,
          },
        ],
      },
    ],
  };

  const platformSection = (platform: Platform, titleKey: string, icon: LucideIcon): SettingsSectionDef => {
    const claimEntry: SettingsEntryDef = platform === "twitch"
      ? {
        id: "twitch.autoClaimChannelPoints",
        titleKey: "autoClaimChannelPointsTitle",
        descriptionKey: "autoClaimChannelPointsDescription",
        render: () => <SettingRow title={t("autoClaimChannelPointsTitle")} description={t("autoClaimChannelPointsDescription")} checked={settings.platform.twitch.autoClaimChannelPoints} onChange={(value) => void onSettingsChange({ platform: { twitch: { autoClaimChannelPoints: value } } })} />,
      }
      : {
        id: "kick.autoClaimChallenges",
        titleKey: "autoClaimChallengesTitle",
        descriptionKey: "autoClaimChallengesDescription",
        render: () => <SettingRow title={t("autoClaimChallengesTitle")} description={t("autoClaimChallengesDescription")} checked={settings.platform.kick.autoClaimChallenges} onChange={(value) => void onSettingsChange({ platform: { kick: { autoClaimChallenges: value } } })} />,
      };

    const groups: SettingsGroupDef[] = [
      {
        id: `${platform}.categories`,
        titleKey: "settingsGroupCategories",
        entries: [
          {
            id: `${platform}.categories.farmAll`,
            titleKey: "farmAllCategoriesTitle",
            descriptionKey: "farmAllCategoriesDescription",
            render: () => (
              <PlatformCategorySettings
                platform={platform}
                suggestions={ctx.suggestions[platform]}
                settings={settings}
                onFarmAllCategoriesChange={(farmAllCategories) => void platformPatch(platform, { farmAllCategories })}
                onCategoriesChange={(categories) => void platformPatch(platform, { categories })}
                onSearchCategories={(query) => ctx.onSearchCategories(platform, query)}
              />
            ),
          },
        ],
      },
      {
        id: `${platform}.channels`,
        titleKey: "settingsGroupExcludedChannels",
        entries: [
          {
            id: `${platform}.channels.excluded`,
            titleKey: "excludedChannelsTitle",
            descriptionKey: "excludedChannelsDescription",
            render: () => (
              <PlatformExcludedChannels
                platform={platform}
                settings={settings}
                onExcludedChannelsChange={(excludedChannels) => void platformPatch(platform, { excludedChannels })}
              />
            ),
          },
        ],
      },
    ];

    if (ctx.compatibilityRegistry && ctx.compatibilityResolution) {
      const compatibilityRegistry = ctx.compatibilityRegistry;
      const compatibilityResolution = ctx.compatibilityResolution;
      groups.push({
        id: `${platform}.compatibility`,
        titleKey: "settingsGroupCompatibility",
        advanced: true,
        entries: [
          {
            id: `${platform}.compatibility.rows`,
            titleKey: "compatibilitySectionTitle",
            descriptionKey: "compatibilitySectionDescription",
            render: () => (
              <PlatformCompatibilitySettings
                platform={platform}
                settings={settings.compatibility}
                registry={compatibilityRegistry}
                resolution={compatibilityResolution}
                onChange={(patch) => void onSettingsChange(patch)}
              />
            ),
          },
        ],
      });
    }

    return { id: platform, titleKey, icon, rows: [claimEntry], groups };
  };

  return [
    general,
    platformSection("twitch", "settingsSectionTwitch", Radio),
    platformSection("kick", "settingsSectionKick", Radio),
  ];
}
```

**On the "no one-setting subsections" rule:** the issue's rule targets lists of
toggles, not editors. Three groups here render exactly one rich editor each —
`categories`, `channels` and `compatibility` — and splitting them further would
be worse, not better. The registry test exempts those three ids from the
minimum-entry check. Everything that *is* a list of toggles obeys the rule:
`general.diagnostics` was folded into `general.advanced` rather than shipping a
group with a single logging switch.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsRegistry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/settingsRegistry.tsx packages/extension/tests/settingsRegistry.test.ts
git commit -m "feat(popup): declare settings as a searchable registry"
```

---

## Task 8: Rewrite the settings view as a registry walker

**Files:**
- Modify: `packages/popup-ui/src/settings.tsx` (full rewrite)
- Modify: `packages/popup-ui/src/Popup.tsx:581`

- [ ] **Step 1: Write the failing test**

Create a new test file `packages/extension/tests/settingsSearchView.test.tsxx`. Model the mount helper on `packages/extension/tests/settingsView.test.tsx:20-56` — read that file first and copy its `parseHTML` / `stubGlobal` / `createRoot` setup exactly, including the `PopupRuntimeContext` with `preview: true`.

```tsx
  it("hides advanced groups until the advanced switch is turned on", () => {
    const { container } = mountSettings();
    expect(container.textContent).not.toContain("Scheduler interval");
    const advancedSwitch = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show advanced settings");
    act(() => advancedSwitch?.click());
    expect(container.textContent).toContain("Scheduler interval");
  });

  it("filters settings by title as the user types", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => {
      setInputValue(search, "mute");
    });
    expect(container.textContent).toContain("Mute farming tabs");
    expect(container.textContent).not.toContain("Auto-claim drops");
  });

  it("reveals a matching advanced setting without enabling the advanced switch", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => {
      setInputValue(search, "scheduler interval");
    });
    expect(container.textContent).toContain("Scheduler interval");
    const advancedSwitch = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show advanced settings");
    expect(advancedSwitch?.getAttribute("aria-checked")).toBe("false");
  });

  it("restores the full tree when the query is cleared", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => setInputValue(search, "mute"));
    act(() => setInputValue(search, ""));
    expect(container.textContent).toContain("Auto-claim drops");
  });

  it("shows an empty state when nothing matches", () => {
    const { container } = mountSettings();
    const search = container.querySelector("input[type=search]") as HTMLInputElement;
    act(() => setInputValue(search, "zzzznotasetting"));
    expect(container.textContent).toContain("No settings match");
  });
```

Add this helper to the file — React's synthetic `onChange` needs the native setter to fire under `linkedom`:

```tsx
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
}
```

The `labels` map in the mount helper must cover every key the registry resolves. Start from the keys in `settingsRegistry.tsx` and add each one; a missing key falls back to the key name, which will make assertions fail confusingly. Verify `Toggle` in `primitives.tsx` renders `aria-label` and `aria-checked` on a `button` before relying on those selectors — if it uses a different element or attribute, adjust the selectors to match.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsSearchView.test.tsx
```

Expected: FAIL — no search input exists yet.

- [ ] **Step 3: Rewrite `settings.tsx`**

Replace the entire contents of `packages/popup-ui/src/settings.tsx` with:

```tsx
import React, { useEffect, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import type { CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { SHOW_ADVANCED_SETTINGS_KEY } from "./constants";
import { AdvancedSettingsSwitch, SettingsGroup, SettingsSearchBox, SettingsSection } from "./settingsControls";
import { buildSettingsRegistry, type SettingsChangeOptions } from "./settingsRegistry";
import { filterSettingsTree } from "./settingsSearch";
import { usePopupRuntime, useT } from "./context";
import type { GameItem, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export function SettingsView({ suggestions, onSearchCategories, settings, onSettingsChange, onExportCredentials, exportConfirmationResetKey, compatibilityRegistry, compatibilityResolution }: {
  suggestions: Record<Platform, GameItem[]>;
  onSearchCategories(platform: Platform, query: string): Promise<CategorySelection[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: SettingsPatch, options?: SettingsChangeOptions): Promise<void>;
  // Optional: when provided, the settings view shows an "Export credentials"
  // action for the headless CLI. The extension wires it; the demo omits it.
  onExportCredentials?: () => void | Promise<void>;
  exportConfirmationResetKey: number;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  compatibilityResolution?: PopupCompatibilityResolution;
}) {
  const t = useT();
  const { adapter, preview } = usePopupRuntime();
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [exportArmed, setExportArmed] = useState(false);
  useEffect(() => setExportArmed(false), [exportConfirmationResetKey]);

  useEffect(() => {
    if (preview) return;
    let mounted = true;
    void adapter.getStorage(SHOW_ADVANCED_SETTINGS_KEY).then((stored) => {
      if (mounted) setShowAdvanced(stored[SHOW_ADVANCED_SETTINGS_KEY] === true);
    });
    return () => {
      mounted = false;
    };
  }, [adapter, preview]);

  function toggleAdvanced(value: boolean): void {
    setShowAdvanced(value);
    if (preview) return;
    void adapter.setStorage({ [SHOW_ADVANCED_SETTINGS_KEY]: value });
  }

  const sections = useMemo(
    () => buildSettingsRegistry({ t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution }),
    [t, settings, onSettingsChange, suggestions, onSearchCategories, compatibilityRegistry, compatibilityResolution],
  );
  const visible = useMemo(() => filterSettingsTree(sections, { t, query, showAdvanced }), [sections, t, query, showAdvanced]);
  const searching = query.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SettingsSearchBox value={query} onChange={setQuery} />
        <AdvancedSettingsSwitch checked={showAdvanced} onChange={toggleAdvanced} />
      </div>

      {visible.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">{t("settingsSearchNoResults", query.trim())}</p>
      ) : (
        <div className="space-y-6">
          {visible.map((section) => (
            <SettingsSection
              key={section.id}
              id={section.id}
              title={t(section.titleKey)}
              icon={section.icon}
              // While searching, a section holding matches opens regardless of
              // the state the user left it in, and that state is not overwritten.
              forceExpanded={searching}
            >
              {section.rows.length > 0 ? (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {section.rows.map((row) => <React.Fragment key={row.id}>{row.render()}</React.Fragment>)}
                </div>
              ) : null}
              {section.groups.map((group) => (
                <SettingsGroup key={group.id} title={t(group.titleKey)} advanced={group.advanced}>
                  {group.entries.map((entry) => <React.Fragment key={entry.id}>{entry.render()}</React.Fragment>)}
                </SettingsGroup>
              ))}
            </SettingsSection>
          ))}
        </div>
      )}

      {onExportCredentials && !searching ? (
        <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800/70">
          {exportArmed ? (
            <div className="space-y-2 px-1 py-1">
              <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{t("cliExportConfirm")}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => setExportArmed(false)}
                >
                  {t("cliExportCancel")}
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                  onClick={() => {
                    setExportArmed(false);
                    void onExportCredentials();
                  }}
                >
                  {t("cliExportConfirmButton")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 px-1 py-1">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("cliExportHint")}</p>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                onClick={() => setExportArmed(true)}
              >
                <Terminal size={13} />
                {t("cliExportButton")}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Drop the dead prop from `Popup.tsx`**

At `packages/popup-ui/src/Popup.tsx:581`, remove ` initialPlatform={platform}` from the `<SettingsView …>` call. Leave every other prop untouched.

Then check whether `platform` is still used elsewhere in `Popup.tsx`:

```bash
grep -n "platform" packages/popup-ui/src/Popup.tsx
```

It is used by other views, so it stays — only the prop passed to `SettingsView` goes.

- [ ] **Step 5: Run the tests**

```bash
cd packages/extension && pnpm exec vitest run tests/settingsSearchView.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/popup-ui/src/settings.tsx packages/popup-ui/src/Popup.tsx packages/extension/tests/settingsSearchView.test.tsxx
git commit -m "feat(popup): rework settings into searchable general, twitch and kick sections"
```

---

## Task 9: Repair the pre-existing settings tests

**Files:**
- Modify: `packages/extension/tests/settingsView.test.tsx`
- Modify: `packages/extension/tests/settingsCredentialExport.test.tsx`

- [ ] **Step 1: Run the full suite to see the damage**

```bash
pnpm test
```

Expected: FAIL in `settingsView.test.tsx` and `settingsCredentialExport.test.tsx`. Read every failure before changing anything.

- [ ] **Step 2: Fix `settingsView.test.tsx`**

The helper at `settingsView.test.tsx:53-55` finds a button whose text contains `"Advanced"` and clicks it to expand the old Advanced section. That section no longer exists — the deadline settings now live in an advanced *group* gated by the advanced switch.

Replace those lines with a click on the advanced switch:

```tsx
    const advancedSwitch = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show advanced settings");
    act(() => advancedSwitch?.click());
```

Add `settingsShowAdvancedTitle: "Show advanced settings"` and `settingsSearchPlaceholder: "Search settings…"` to the `labels` map at `settingsView.test.tsx:27-34`. Add every other label key the registry now resolves for the General section — run the test and add whatever comes back as a raw key name.

The assertions about the deadline settings themselves should not need changing: same controls, same `onSettingsChange` calls.

- [ ] **Step 3: Fix `settingsCredentialExport.test.tsx`**

The export UI is no longer wrapped in a `SettingsSection`, so any assertion that first expands a "Headless CLI" section must go — the button is now always visible at the foot of the settings view. Remove the section-expanding step and keep the arm/confirm/cancel assertions as they are.

Add `settingsSearchPlaceholder` and `settingsShowAdvancedTitle` to that file's `labels` map at `settingsCredentialExport.test.tsx:8-18`.

- [ ] **Step 4: Run the full suite**

```bash
pnpm test
```

Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/tests
git commit -m "test(popup): update settings tests for the reworked section layout"
```

---

## Task 10: Full verification

- [ ] **Step 1: Run the complete check**

```bash
pnpm check
```

This runs script tests, workspace typechecks, the extension test suite and the Astro site build. Expected: all green. The site build matters — `packages/site` imports the real popup UI for its live demo, so a broken `SettingsView` signature breaks the marketing site.

- [ ] **Step 2: Confirm the platform switch is gone**

```bash
grep -rn "SettingsPlatformSwitch\|AUTOMATIC_COMPATIBILITY_PATCH\|initialPlatform" packages --include=*.ts --include=*.tsx | grep -v node_modules
```

Expected: no output.

- [ ] **Step 3: Confirm no stale collapse-key usage**

```bash
grep -rn "COLLAPSED_SETTINGS_SECTIONS_KEY" packages --include=*.ts --include=*.tsx | grep -v node_modules
```

Expected: only `constants.ts` and `settingsControls.tsx`.

- [ ] **Step 4: Look at it in a real browser**

```bash
pnpm dev
```

Load the extension, open the popup, open settings. Verify by hand — automated tests do not cover visual hierarchy:

- General, Twitch and Kick all expanded on first open; collapsing one persists across popup reopen
- the advanced switch reveals Scheduler & timing and both Compatibility groups, and persists
- typing `mute` narrows to the two mute settings; clearing restores everything
- typing `heartbeat` with the advanced switch off still surfaces the Twitch compatibility rows
- switching language (General → Appearance → Language) does **not** reset section collapse state — this is the `settingsControls.tsx:20` bug the stable ids fix
- the Export credentials button sits at the foot of the settings view

Capture a screenshot of the settings view for the PR. The issue asks for screenshots on popup UI changes.

- [ ] **Step 5: Both browser builds**

```bash
pnpm verify
```

Expected: `pnpm check` plus Chromium and Firefox builds, all green.

- [ ] **Step 6: Push and open the PR**

The git remote is SSH and no key was loaded when this plan was written. If `git push` fails with `Permission denied (publickey)`, run `ssh-add` first.

```bash
git push -u origin refactor/settings-ia-rework
gh pr create --base develop \
  --title "refactor(popup): rework settings into general, twitch and kick sections" \
  --body "Closes #171"
```

Fill the PR body with a summary, the testing performed, and the settings screenshot. Base is `develop`, never `main`.

---

## Notes for the Implementer

**The tension in Task 7 is real, not an oversight.** The issue says "no subsection with fewer than two settings", but three subsections (categories, excluded channels, compatibility) each render exactly one rich editor. Task 7 spells out the resolution: exempt editor-backed groups from the rule and merge diagnostics into the advanced group. Do not paper over it with entries that render `null`.

**`t` identity and `useMemo`.** `buildSettingsRegistry` is memoized on `t`, `settings` and the callbacks. If `useT()` returns a fresh function every render, the memo never hits and the registry rebuilds constantly. Check `packages/popup-ui/src/context.tsx` — if `t` is not stable, either stabilize it there or drop it from the dependency array and accept the rebuild. Rebuilding is cheap (it is plain object construction), so do not over-engineer this; just know which one is happening.

**Search does not persist.** The query resets when the popup closes. That is intentional — a stale filter on reopen would look like missing settings.

**The site demo.** `packages/site` renders `SettingsView` through `Popup` with `preview: true`, which short-circuits every storage read. Advanced defaults to off and collapse state defaults to expanded in preview mode, which is the right demo appearance.
