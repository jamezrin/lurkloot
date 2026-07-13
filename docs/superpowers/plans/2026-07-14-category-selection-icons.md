# Category Selection Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show available Twitch and Kick category artwork in selected-category rows and drag overlays while retaining initials for missing or failed images.

**Architecture:** Preserve artwork on the existing `GameItem` to `CategorySelection` data path, then add an optional image input to the shared `CompactRow` primitive. Category settings opt into the image input; watch-queue consumers remain unchanged and the existing `ImageWithFallback` component owns error fallback behavior.

**Tech Stack:** TypeScript, React 19, WXT, Vitest, React DOM server rendering, pnpm

## Global Constraints

- Render category artwork as a 32px rounded-square, cover-fitted thumbnail.
- Fall back to the existing initials avatar when artwork is absent or fails to load.
- Apply the same artwork to the selected row and its drag overlay.
- Preserve existing watch-queue rendering and category filtering behavior.
- Add no dependencies, permissions, storage migrations, or platform requests.
- Follow strict TypeScript, ES modules, two-space indentation, double quotes, and semicolons.

---

### Task 1: Preserve active-drop category artwork

**Files:**
- Create: `packages/extension/tests/popupCategoryIcons.test.ts`
- Modify: `packages/popup-ui/src/types.ts:5`
- Modify: `packages/popup-ui/src/viewModels.ts:63-77`
- Modify: `packages/popup-ui/src/settingsPlatform.tsx:257-266`

**Interfaces:**
- Consumes: `DropCampaign.gameImageUrl?: string` from `@lurkloot/shared/models`.
- Produces: `GameItem.imageUrl?: string`, passed into `CategorySelection.imageUrl?: string` when an active-drop suggestion is selected.

- [ ] **Step 1: Write the failing artwork-propagation test**

Create `packages/extension/tests/popupCategoryIcons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DropCampaign } from "@lurkloot/shared/models";
import { gameItemsFromCampaigns } from "../../popup-ui/src/viewModels";

const t = (key: string): string => key;

describe("popup category icons", () => {
  it("preserves campaign category artwork in active-drop suggestions", () => {
    const campaign: DropCampaign = {
      id: "fortnite-drops",
      platform: "twitch",
      name: "Fortnite Drops",
      categoryId: "33214",
      gameName: "Fortnite",
      gameImageUrl: "https://art.example/fortnite.jpg",
      status: "active",
      rewards: [],
    };

    expect(gameItemsFromCampaigns([campaign], t)).toEqual([
      expect.objectContaining({
        id: "33214",
        name: "Fortnite",
        imageUrl: "https://art.example/fortnite.jpg",
      }),
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupCategoryIcons.test.ts
```

Expected: FAIL because the received `GameItem` has no `imageUrl` property.

- [ ] **Step 3: Add the minimal artwork data path**

Change `GameItem` in `packages/popup-ui/src/types.ts` to:

```ts
export type GameItem = {
  id: string;
  name: string;
  short: string;
  accent: string;
  imageUrl?: string;
};
```

In the non-synthetic branch of `gameItemsFromCampaigns` in
`packages/popup-ui/src/viewModels.ts`, retain the campaign artwork:

```ts
      : {
        id,
        name: campaign.gameName ?? t("unknownGame"),
        short: initials(campaign.gameName ?? campaign.name),
        accent: GAME_ACCENTS[index % GAME_ACCENTS.length],
        imageUrl: campaign.gameImageUrl,
      });
```

In the active-drop suggestions map in
`packages/popup-ui/src/settingsPlatform.tsx`, display and preserve the image:

```tsx
<CategoryAddChip
  key={suggestion.id}
  name={suggestion.name}
  imageUrl={suggestion.imageUrl}
  onClick={() => addCategory({
    id: suggestion.id,
    name: suggestion.name,
    ...(suggestion.imageUrl ? { imageUrl: suggestion.imageUrl } : {}),
  })}
/>
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupCategoryIcons.test.ts
```

Expected: PASS with 1 test passing.

- [ ] **Step 5: Run the popup UI typecheck**

Run:

```bash
pnpm --filter @lurkloot/popup-ui typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 6: Commit the data-path change**

```bash
git add packages/extension/tests/popupCategoryIcons.test.ts packages/popup-ui/src/types.ts packages/popup-ui/src/viewModels.ts packages/popup-ui/src/settingsPlatform.tsx
git commit -m "fix(popup): preserve category artwork"
```

---

### Task 2: Render selected-category artwork with fallback

**Files:**
- Modify: `packages/extension/tests/popupCategoryIcons.test.ts`
- Modify: `packages/popup-ui/src/primitives.tsx:121-139`
- Modify: `packages/popup-ui/src/settingsPlatform.tsx:249-254,306-312`

**Interfaces:**
- Consumes: `CompactRow.avatarImageUrl?: string` alongside the existing `avatar` fallback string.
- Produces: a fixed-size rounded-square image when a URL exists; otherwise `ImageWithFallback` renders `avatar` inside the same row position.

- [ ] **Step 1: Write the failing selected-row rendering test**

Extend `packages/extension/tests/popupCategoryIcons.test.ts` with these imports:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeSettings } from "@lurkloot/shared/settings";
import { PlatformSettingsGroup } from "../../popup-ui/src/settingsPlatform";
```

Add this helper and tests inside the existing `describe` block:

```ts
  function renderSelectedCategory(imageUrl?: string): string {
    const settings = mergeSettings(undefined);
    settings.platform.twitch.farmAllCategories = false;
    settings.platform.twitch.categories = [{
      id: "33214",
      name: "Fort Night",
      ...(imageUrl ? { imageUrl } : {}),
    }];

    return renderToStaticMarkup(createElement(PlatformSettingsGroup, {
      platform: "twitch",
      suggestions: [],
      settings,
      onFarmAllCategoriesChange: () => {},
      onCategoriesChange: () => {},
      onSearchCategories: async () => [],
      onExcludedChannelsChange: () => {},
    }));
  }

  it("renders selected category artwork as a rounded-square image", () => {
    const markup = renderSelectedCategory("https://art.example/fortnite.jpg");

    expect(markup).toContain('src="https://art.example/fortnite.jpg"');
    expect(markup).toContain("h-8 w-8");
    expect(markup).toContain("rounded-lg");
  });

  it("keeps initials when selected category artwork is absent", () => {
    const markup = renderSelectedCategory();

    expect(markup).not.toContain("<img");
    expect(markup).toContain(">FN</span>");
  });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupCategoryIcons.test.ts
```

Expected: the artwork rendering test FAILS because the selected row contains no
`<img>`; the propagation and no-artwork fallback tests PASS.

- [ ] **Step 3: Add image rendering to `CompactRow`**

Replace the single-line `CompactRow` props declaration in
`packages/popup-ui/src/primitives.tsx` with:

```tsx
export function CompactRow({
  avatar,
  avatarImageUrl,
  avatarStyle,
  index,
  title,
  titleHref,
  subtitle,
  trailing,
  dragHandle,
  isOverlay = false,
  dimmed = false,
}: {
  avatar: string;
  avatarImageUrl?: string;
  avatarStyle: React.CSSProperties;
  index: number;
  title: string;
  titleHref?: string;
  subtitle?: string;
  trailing: React.ReactNode;
  dragHandle: React.ReactNode;
  isOverlay?: boolean;
  dimmed?: boolean;
}) {
```

Replace its avatar span with:

```tsx
<span
  className={cn(
    "flex h-8 w-8 shrink-0 items-center justify-center text-[11px] font-bold",
    avatarImageUrl ? "overflow-hidden rounded-lg" : "rounded-full",
  )}
  style={avatarStyle}
>
  <ImageWithFallback
    src={avatarImageUrl}
    alt=""
    fit="cover"
    fallback={avatar}
  />
</span>
```

`ImageWithFallback` already switches to `fallback` after `onError`, so failed
remote artwork preserves the same 32px row footprint without new error logic.

- [ ] **Step 4: Wire both category row forms to `avatarImageUrl`**

In `packages/popup-ui/src/settingsPlatform.tsx`, add
`avatarImageUrl={active.imageUrl}` to the drag-overlay `CompactRow`, and add
`avatarImageUrl={category.imageUrl}` to the sortable-row `CompactRow`. Do not
change either watch-queue call site.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/popupCategoryIcons.test.ts
```

Expected: PASS with 3 tests passing and no warnings.

- [ ] **Step 6: Run the full extension tests and popup UI typecheck**

Run:

```bash
pnpm test
pnpm --filter @lurkloot/popup-ui typecheck
```

Expected: all extension tests pass and the popup UI typecheck exits 0.

- [ ] **Step 7: Commit the rendering change**

```bash
git add packages/extension/tests/popupCategoryIcons.test.ts packages/popup-ui/src/primitives.tsx packages/popup-ui/src/settingsPlatform.tsx
git commit -m "fix(popup): show selected category artwork"
```

---

### Task 3: Verify and prepare the pull request

**Files:**
- Review: `docs/superpowers/specs/2026-07-14-category-selection-icons-design.md`
- Review: `docs/superpowers/plans/2026-07-14-category-selection-icons.md`
- Review: all files changed since `origin/main`

**Interfaces:**
- Consumes: the completed data-path and rendering commits from Tasks 1 and 2.
- Produces: verified PR-ready commits satisfying issue #91 and the approved design.

- [ ] **Step 1: Inspect the complete diff and repository state**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Expected: no unstaged implementation changes, no whitespace errors, and only the
approved design, plan, tests, and popup UI changes are present.

- [ ] **Step 2: Run fresh full verification**

Run:

```bash
pnpm verify
```

Expected: script tests, all workspace typechecks, extension tests, Astro site
build, and Chromium and Firefox extension builds all exit 0.

- [ ] **Step 3: Request code review and address findings**

Request review of `origin/main...HEAD` against the approved design and issue #91.
Fix all Critical and Important findings using a new red-green test cycle, rerun
`pnpm verify`, and commit any required corrections with a focused Conventional
Commit subject.

- [ ] **Step 4: Confirm GitHub publishing prerequisites**

Run:

```bash
gh --version
gh auth status
git status -sb
```

Expected: GitHub CLI is installed and authenticated, and the branch is clean.

- [ ] **Step 5: Push the repository-convention branch**

Run:

```bash
git push -u origin fix/category-selection-icons
```

Expected: the remote branch is created and tracks `origin/fix/category-selection-icons`.

- [ ] **Step 6: Open a draft PR**

Create a draft PR targeting `main` with Conventional Commit title:

```text
fix(popup): show selected category artwork
```

The PR body must summarize the two artwork data paths, explain that selected
rows previously ignored or discarded `imageUrl`, list `pnpm verify` under
testing, link `Closes #91`, and note that missing or failed images retain the
initials fallback.
