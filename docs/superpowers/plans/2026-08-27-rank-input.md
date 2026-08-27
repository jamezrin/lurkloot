# Click-to-Edit Sort Rank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users type a 1-based sort rank on Drops, Idle Watchlist, and settings category rows instead of only dragging.

**Architecture:** A pure `commitRank` helper plus a shared `RankInput` in `primitives.tsx` replace the static rank span. Callers still persist through existing `arrayMove` + `onReorder` / `onChange`. Drops search keeps a non-editable number.

**Tech Stack:** TypeScript, React 19, `@dnd-kit/helpers` `arrayMove`, Vitest + linkedom in `packages/extension/tests/`

**Spec:** `docs/superpowers/specs/2026-08-27-rank-input-design.md`

## Global Constraints

- Display is 1-based (`index + 1`); `commitRank` / `onMove` use 0-based indexes.
- Successful commit is insert-and-shift via `arrayMove`, not a swap.
- Empty, `0`, negatives, and non-whole-numbers cancel; `n > count` clamps to `count`; same rank is a no-op (no settings write).
- Enter or blur commits; Escape cancels without moving.
- Use `inputMode="numeric"` text input, never `type="number"`.
- English `aria-label` `Set rank of {name}`; no new locale catalog keys.
- Drops search stays view-only: static number, no rank button/input.
- No new settings keys, scheduler changes, or overlay/column-grow UI.
- Follow strict TypeScript, ES modules, two-space indentation, double quotes, and semicolons.

## File structure

- `packages/popup-ui/src/primitives.tsx` — `commitRank`, `RankInput`, and `CompactRow` using `RankInput`.
- `packages/popup-ui/src/drops.tsx` — campaign rail uses `RankInput`; search omits `onMove`.
- `packages/popup-ui/src/idleWatchlist.tsx` — pass rank props into `CompactRow`.
- `packages/popup-ui/src/settingsPlatform.tsx` — pass rank props into `CompactRow`.
- `packages/extension/tests/rankInput.test.ts` — pure `commitRank` cases.
- `packages/extension/tests/dropsView.test.tsx` — click/type/blur reorder + search stays static.

---

### Task 1: `commitRank` helper

**Files:**
- Create: `packages/extension/tests/rankInput.test.ts`
- Modify: `packages/popup-ui/src/primitives.tsx` (insert after `moveById`, around line 21)

**Interfaces:**
- Consumes: none.
- Produces: `export type CommitRankResult = { action: "cancel" } | { action: "move"; toIndex: number }` and `export function commitRank(raw: string, currentIndex: number, count: number): CommitRankResult`. `toIndex` is 0-based.

- [ ] **Step 1: Write the failing tests**

Create `packages/extension/tests/rankInput.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { commitRank } from "../../popup-ui/src/primitives";

describe("commitRank", () => {
  it("cancels empty, zero, and non-whole numbers", () => {
    for (const raw of ["", "  ", "0", "-1", "abc", "3.5", "3abc"]) {
      expect(commitRank(raw, 2, 12), raw).toEqual({ action: "cancel" });
    }
  });

  it("clamps a too-large rank to the last index", () => {
    expect(commitRank("99", 0, 12)).toEqual({ action: "move", toIndex: 11 });
  });

  it("accepts leading zeros as the integer they parse to", () => {
    expect(commitRank("03", 0, 12)).toEqual({ action: "move", toIndex: 2 });
  });

  it("moves to the typed 1-based position", () => {
    expect(commitRank("3", 0, 12)).toEqual({ action: "move", toIndex: 2 });
  });

  it("cancels when the typed rank is already the current position", () => {
    expect(commitRank("3", 2, 12)).toEqual({ action: "cancel" });
    expect(commitRank("99", 0, 1)).toEqual({ action: "cancel" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension test -- tests/rankInput.test.ts`

Expected: FAIL because `commitRank` is not exported.

- [ ] **Step 3: Implement `commitRank`**

In `packages/popup-ui/src/primitives.tsx`, immediately after `moveById`:

```ts
export type CommitRankResult =
  | { action: "cancel" }
  | { action: "move"; toIndex: number };

export function commitRank(raw: string, currentIndex: number, count: number): CommitRankResult {
  const trimmed = raw.trim();
  if (count < 1 || !/^\d+$/.test(trimmed)) return { action: "cancel" };
  const n = Number(trimmed);
  if (n < 1) return { action: "cancel" };
  const toIndex = Math.min(n, count) - 1;
  if (toIndex === currentIndex) return { action: "cancel" };
  return { action: "move", toIndex };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm --filter @lurkloot/extension test -- tests/rankInput.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/extension/tests/rankInput.test.ts packages/popup-ui/src/primitives.tsx
git commit -m "feat(popup): add commitRank helper"
```

---

### Task 2: `RankInput` and `CompactRow`

**Files:**
- Modify: `packages/popup-ui/src/primitives.tsx` (`DragHandle` ends ~line 109; `CompactRow` ~158–211)
- Modify: `packages/popup-ui/src/idleWatchlist.tsx` (`SortableIdleWatchlist`, ~96–105)
- Modify: `packages/popup-ui/src/settingsPlatform.tsx` (`SortableCategoryRow`, ~315–321)

**Interfaces:**
- Consumes: `commitRank` from Task 1.
- Produces: `export function RankInput(props: { index: number; count: number; label: string; onMove?: (toIndex: number) => void; size: "row" | "rail" }): React.ReactElement`. `CompactRow` requires `rankLabel: string`, `rankCount: number`, and `onRankMove(toIndex: number): void` in addition to existing props.

- [ ] **Step 1: Add `RankInput` after `DragHandle`**

```tsx
export function RankInput({ index, count, label, onMove, size }: { index: number; count: number; label: string; onMove?: (toIndex: number) => void; size: "row" | "rail" }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(String(index + 1));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const skipBlur = React.useRef(false);
  const textClass = size === "rail"
    ? "w-full min-w-0 text-center text-[10px] font-bold tabular leading-none"
    : "w-4 text-center text-[11px] font-bold tabular";
  const color: React.CSSProperties = { color: "var(--accent-text)" };

  React.useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!onMove) {
    return <span className={textClass} style={color}>{index + 1}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={`Set rank of ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          setValue(String(index + 1));
          setEditing(true);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className={cn(textClass, "rounded-sm outline-none hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:text-zinc-200")}
        style={color}
      >
        {index + 1}
      </button>
    );
  }

  function close(commit: boolean): void {
    skipBlur.current = !commit;
    setEditing(false);
    if (!commit) return;
    const result = commitRank(value, index, count);
    if (result.action === "move") onMove(result.toIndex);
  }

  return (
    <input
      ref={inputRef}
      autoFocus
      inputMode="numeric"
      aria-label={`Set rank of ${label}`}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (skipBlur.current) {
          skipBlur.current = false;
          return;
        }
        close(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(false);
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(textClass, "bg-transparent p-0 outline-none focus:ring-1 focus:ring-[var(--accent-ring)]")}
      style={color}
    />
  );
}
```

`onMove` is narrowed by the `if (!onMove)` return above, so `close(true)` can call it directly.

- [ ] **Step 2: Point `CompactRow` at `RankInput`**

Replace the rank `<span>` (`index + 1`) with:

```tsx
<RankInput index={index} count={rankCount} label={rankLabel} onMove={onRankMove} size="row" />
```

Add `rankLabel: string`, `rankCount: number`, and `onRankMove(toIndex: number): void` to the `CompactRow` props type and destructuring.

- [ ] **Step 3: Wire Idle Watchlist and settings categories**

In `idleWatchlist.tsx`, import `arrayMove` from `@dnd-kit/helpers`. Pass list length and move through `SortableIdleWatchlist`:

```tsx
{streamers.map((streamer, index) => (
  <SortableIdleWatchlist
    key={streamer.id}
    streamer={streamer}
    index={index}
    count={streamers.length}
    platform={platform}
    onRemove={() => removeChannel(streamer.id)}
    onMove={(toIndex) => void onChange(arrayMove(streamers, index, toIndex))}
  />
))}
```

Extend `SortableIdleWatchlist` with `count` and `onMove`, and pass them into `CompactRow` as `rankCount={count}`, `rankLabel={streamer.name}`, `onRankMove={onMove}`.

In `settingsPlatform.tsx`, import `arrayMove` from `@dnd-kit/helpers`. Update the category map:

```tsx
{categories.map((category, index) => (
  <SortableCategoryRow
    key={category.id}
    category={category}
    index={index}
    count={categories.length}
    accent={accentFor(index)}
    onRemove={() => void onChange(categories.filter((entry) => entry.id !== category.id))}
    onMove={(toIndex) => void onChange(arrayMove(categories, index, toIndex))}
  />
))}
```

Extend `SortableCategoryRow` the same way and pass `rankLabel={category.name}`, `rankCount={count}`, `onRankMove={onMove}` into `CompactRow`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @lurkloot/popup-ui typecheck`

Expected: PASS. `CompactRow` call sites all supply the new props. Drops is not using `CompactRow`.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src/primitives.tsx packages/popup-ui/src/idleWatchlist.tsx packages/popup-ui/src/settingsPlatform.tsx
git commit -m "feat(popup): add inline RankInput to compact rows"
```

---

### Task 3: Campaign rail and Drops search

**Files:**
- Modify: `packages/popup-ui/src/drops.tsx` (`endDrag` ~108; search cards ~153–157; `SortableCampaign` ~176–185; campaign rail span ~223–225)
- Test: `packages/extension/tests/dropsView.test.tsx`

**Interfaces:**
- Consumes: `RankInput` from Task 2; `arrayMove` from `@dnd-kit/helpers`.
- Produces: `CampaignCard` optional `rankCount?: number` and `onRankMove?: (toIndex: number) => void`. Search cards omit `onRankMove` so `RankInput` renders a span.

- [ ] **Step 1: Write the failing DropsPanel tests**

In `packages/extension/tests/dropsView.test.tsx`, add a helper next to `setSearchQuery` that drives a controlled input, then add this describe:

```tsx
function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onChange?(event: { target: HTMLInputElement; currentTarget: HTMLInputElement }): void; onBlur?(): void }>)[propsKey]
    : undefined;
  props?.onChange?.({ target: input, currentTarget: input });
}

describe("campaign rank input", () => {
  it("reorders via the typed rank on blur", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onReorder = vi.fn();
    const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "first", name: "First campaign" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "second", name: "Second campaign" }, 1, idleSession, false),
    ];
    const container = document.getElementById("app")!;

    act(() => {
      root = createRoot(container);
      root.render(
        <I18nContext.Provider value={{ t: (key) => ({ search: "Search" })[key] ?? key, dir: "ltr", locale: "en" }}>
          <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
            <DropsPanel
              campaigns={campaigns}
              gameMap={{}}
              refreshing={false}
              onRefreshCampaign={() => undefined}
              onReorder={onReorder}
              onToggleExclude={() => undefined}
            />
          </PopupRuntimeContext.Provider>
        </I18nContext.Provider>,
      );
    });

    const rank = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Set rank of Second campaign");
    expect(rank).not.toBeNull();
    act(() => rank?.click());
    const input = container.querySelector<HTMLInputElement>("input[inputmode='numeric']")!;
    expect(input).not.toBeNull();
    act(() => {
      setInputValue(input, "1");
      input.blur();
    });

    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder.mock.calls[0]?.[0].map((campaign: { id: string }) => campaign.id)).toEqual(["second", "first"]);
  });

  it("does not expose a rank editor while searching", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.getElementById("app")!;
    const campaigns = [
      campaignViewFromCampaign({ ...sourceCampaign(), id: "first", name: "First campaign" }, 0, idleSession, false),
      campaignViewFromCampaign({ ...sourceCampaign(), id: "second", name: "Second campaign" }, 1, idleSession, false),
    ];

    act(() => {
      root = createRoot(container);
      renderDropsPanel(campaigns);
    });

    act(() => container.querySelector<HTMLButtonElement>("button[aria-label='Search']")?.click());
    const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
    act(() => setSearchQuery(input, "Second"));

    expect([...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Set rank of Second campaign")).toBeUndefined();
    expect(container.querySelector("input[inputmode='numeric']")).toBeNull();
    expect(container.querySelector<HTMLElement>("article .w-7 span")?.textContent).toBe("2");
  });
});
```

The existing test `"keeps the original priority number in filtered results"` already asserts `article .w-7 span` text `"2"`. Keep that test; the search path must still render a span.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/dropsView.test.tsx`

Expected: FAIL — no `Set rank of Second campaign` button.

- [ ] **Step 3: Wire `RankInput` into the campaign rail**

Import `arrayMove` from `@dnd-kit/helpers` and `RankInput` from `./primitives`.

In `DropsPanel`, add:

```ts
function moveCampaign(fromIndex: number, toIndex: number): void {
  void onReorder(arrayMove(campaigns, fromIndex, toIndex));
}
```

Pass `rankCount={campaigns.length}` and `onRankMove={(toIndex) => moveCampaign(index, toIndex)}` only through `SortableCampaign` (the non-search list). Do **not** pass `onRankMove` on the search `CampaignCard` map.

Extend `SortableCampaign` and `CampaignCard` with optional `rankCount?: number` and `onRankMove?: (toIndex: number) => void`. `SortableCampaign` forwards both onto `CampaignCard`.

Replace the rail number span with:

```tsx
<RankInput index={index} count={rankCount ?? 0} label={campaign.title} onMove={onRankMove} size="rail" />
```

Keep the decorative `GripVertical` fallback when `dragHandle` is missing (search). The rank stays a span in that case because `onMove` is undefined.

- [ ] **Step 4: Run the Drops tests and make sure they pass**

Run: `pnpm --filter @lurkloot/extension test -- tests/dropsView.test.tsx tests/rankInput.test.ts`

Expected: PASS, including `"keeps the original priority number in filtered results"`.

If blur does not fire React's `onBlur` under linkedom, call the `__reactProps$` `onBlur` the same way `setInputValue` calls `onChange`.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @lurkloot/popup-ui typecheck && pnpm --filter @lurkloot/extension typecheck`

```bash
git add packages/popup-ui/src/drops.tsx packages/extension/tests/dropsView.test.tsx
git commit -m "feat(popup): type a campaign sort rank"
```

---

### Task 4: Verification

**Files:** none new.

- [ ] **Step 1: Run the extension test suite**

Run: `pnpm --filter @lurkloot/extension test`

Expected: PASS.

- [ ] **Step 2: Manual check (if a popup host is available)**

On Drops, Idle Watchlist, and settings categories: click a rank, type a new 1-based position, blur, confirm insert-and-shift. Escape cancels. Open campaign search and confirm the number is not editable. Drag still works on the grip.

- [ ] **Step 3: Final commit only if verification left uncommitted fixes**

Do not create an empty commit. If Step 2 required code changes, commit those with a focused `fix(popup): ...` message.
