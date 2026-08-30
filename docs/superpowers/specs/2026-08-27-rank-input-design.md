# Click-to-Edit Sort Rank

## Context

Drops, Idle Watchlist, and the settings category list are ordered by drag-and-drop. Each row already shows a 1-based rank next to the grip (`index + 1`). Reordering a long list means scrolling and dragging; campaign search disables drag entirely. [Issue #432](https://github.com/jamezrin/lurkloot/issues/432) asks for typing a new rank instead.

This is a popup-only interaction. Persistence stays on the existing reorder callbacks.

## Goal

Clicking the displayed rank turns it into a small numeric field. Committing moves that item to the typed 1-based position and shifts neighbors (insert, not swap), the same `arrayMove` path drag already uses.

## Scope

In:

- Drops campaign cards (the number under the grip in the drag rail)
- Idle Watchlist rows (`CompactRow`)
- Settings category rows (`CompactRow`)

Out:

- Rank editing while Drops search is open (filtered cards keep a static number, matching drag)
- New settings keys, scheduler changes, or locale catalog entries

## Architecture

A shared `RankInput` primitive lives in `packages/popup-ui/src/primitives.tsx` beside `DragHandle`. It replaces the static `index + 1` span in `CompactRow` and in the campaign drag rail in `drops.tsx`. The field stays in that existing slot (no overlay, no column grow). `CompactRow` gains the item label, list length, and an `onMove(toIndex)` callback so watchlist and category rows can share the control.

A pure helper `commitRank(raw, currentIndex, count)` returns either cancel or a 0-based `toIndex`. Callers apply `arrayMove` and the existing `onReorder` / `onChange` callbacks:

- Drops → `onReorder` → `campaignPriorities` via `prioritiesFromOrder`
- Idle Watchlist → `onChange(streamers)`
- Categories → `onChange(categories)`

No new storage shape.

## Interaction

Display state is a button showing the 1-based rank. Click (or Enter/Space when focused) opens a centered text input with `inputMode="numeric"` — not `type="number"`, so there are no spinners. The current value is selected so typing replaces it.

- Enter or blur runs `commitRank` and closes the field
- Escape restores the original rank and closes without moving

The campaign rank sits in the left rail, outside the card's expand toggle and off the grip, so editing must not expand the card or start a drag.

## Commit rules

`commitRank` trims the raw string. The remainder must be a whole number (`/^\d+$/`); leading zeros are allowed (`03` → 3). Then:

| Input | Result |
| --- | --- |
| empty, `0`, negatives, or not a whole number (`abc`, `3.5`, `3abc`) | cancel |
| `n > count` | clamp to `count` |
| `n` in `1…count` | `toIndex = n - 1` |
| `toIndex === currentIndex` | cancel (no settings write, no tick) |

A cancelled commit leaves the list unchanged. A successful commit is insert-and-shift via `arrayMove`, not a swap.

## Accessibility

Follow `DragHandle`: an English `aria-label` of the form `Set rank of {name}`. No new locale keys. The control is keyboard-reachable; Tab lands on the button, Enter/Space open edit.

## Testing

Vitest in `packages/extension/tests/`, same as other popup-ui coverage.

1. Pure `commitRank` cases for cancel, clamp-to-end, a real move, and same-rank no-op.
2. One focused `DropsPanel` test: click rank, type, blur, assert `onReorder` received `arrayMove` order. While search is open, the rank is not a button or input.

`CompactRow` shares `RankInput`, so watchlist and settings do not need a duplicated click path. Scheduler and settings-schema tests are out of scope.
