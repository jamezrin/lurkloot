# Drops Rail Rank Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Drops campaign rank a 16px-wide caption of the grip, centered in the existing 28px rail.

**Architecture:** Wrap grip + `RankInput` in a `w-4` column inside the unchanged `w-7` rail. Change `RankInput` `size="rail"` from `w-full` to `w-4` with flex centering. CompactRow `size="row"` stays as it is.

**Tech Stack:** TypeScript, React, Tailwind utilities, Vitest + linkedom in `packages/extension/tests/`

**Spec:** `docs/superpowers/specs/2026-08-30-drops-rail-rank-alignment-design.md`

## Global Constraints

- Rail stays `w-7`; inner unit is `w-4`; do not grow either.
- `RankInput` rail is not `w-full`; display, edit, and search span share the `w-4` box.
- CompactRow / `size="row"` unchanged; do not change `DragHandle` globally.
- Click-to-edit, Escape, search view-only, and `stopPropagation` stay as in `docs/superpowers/specs/2026-08-27-rank-input-design.md`.
- Follow strict TypeScript, ES modules, two-space indentation, double quotes, and semicolons.

## File structure

- `packages/popup-ui/src/primitives.tsx` — `RankInput` `size="rail"` classes.
- `packages/popup-ui/src/drops.tsx` — inner `w-4` stack in the campaign rail.
- `packages/extension/tests/dropsView.test.tsx` — assert rail rank is `w-4` and not `w-full`.

---

### Task 1: Shared-width Drops rail stack

**Files:**
- Modify: `packages/popup-ui/src/primitives.tsx` (`RankInput` `textClass` for `size === "rail"`)
- Modify: `packages/popup-ui/src/drops.tsx` (campaign rail around the `w-7` div)
- Test: `packages/extension/tests/dropsView.test.tsx`

**Interfaces:**
- Consumes: existing `RankInput({ index, count, label, onMove, size: "rail" })`.
- Produces: rail rank control whose `className` includes `w-4` and does not include `w-full`.

- [ ] **Step 1: Write the failing assertions**

In `packages/extension/tests/dropsView.test.tsx`, in `"moves a campaign when the rank is typed and committed"`, after `expect(rank).toBeDefined();` add:

```ts
    expect(rank?.className).toContain("w-4");
    expect(rank?.className).not.toContain("w-full");
```

In `"keeps the rank static while campaign search is open"`, after the existing span text assertion, add:

```ts
    const rankSpan = container.querySelector<HTMLElement>("article .w-7 span");
    expect(rankSpan?.className).toContain("w-4");
    expect(rankSpan?.className).not.toContain("w-full");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/dropsView.test.tsx`

Expected: FAIL — rank button/span still use `w-full min-w-0`.

- [ ] **Step 3: Change `RankInput` rail classes**

In `packages/popup-ui/src/primitives.tsx`, replace the rail branch of `textClass`:

```ts
  const textClass = size === "rail"
    ? "flex w-4 items-center justify-center text-center text-[10px] font-bold tabular leading-none"
    : "w-4 text-center text-[11px] font-bold tabular";
```

- [ ] **Step 4: Wrap the Drops rail contents in a `w-4` unit**

In `packages/popup-ui/src/drops.tsx`, replace the rail block with:

```tsx
        <div className="flex w-7 shrink-0 items-center justify-center border-r border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/40">
          <div className="flex w-4 flex-col items-center gap-0.5">
            {dragHandle ?? <GripVertical size={14} className="text-zinc-300 dark:text-zinc-600" />}
            <RankInput index={index} count={rankCount ?? 0} label={campaign.title} onMove={onRankMove} size="rail" />
          </div>
        </div>
```

Update the comment above it to say the grip and rank share a 16px column centered in the rail.

- [ ] **Step 5: Run the tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/dropsView.test.tsx tests/rankInput.test.ts
pnpm --filter @lurkloot/popup-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/popup-ui/src/primitives.tsx packages/popup-ui/src/drops.tsx packages/extension/tests/dropsView.test.tsx
git commit -m "fix(popup): align drops rank under the grip"
```
