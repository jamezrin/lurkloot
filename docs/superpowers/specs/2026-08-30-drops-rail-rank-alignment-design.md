# Drops Rail Rank Alignment

## Context

Click-to-edit rank shipped in [PR #443](https://github.com/jamezrin/lurkloot/pull/443) against [issue #432](https://github.com/jamezrin/lurkloot/issues/432). The Drops campaign number sits under the grip in a 28px (`w-7`) rail. After the static `<span>` became a `w-full` `RankInput` button, the 1-based rank looks left of the grip’s axis — Geist tabular “1” is left-heavy in its slot, and full-rail `text-center` treats the digit as rail text instead of a caption of the handle.

Idle Watchlist and settings `CompactRow` ranks (beside the grip) are out of scope.

Follows `docs/superpowers/specs/2026-08-27-rank-input-design.md`. Interaction, commit rules, and accessibility do not change.

## Goal

The Drops rail rank and grip share one 16px-wide stack, centered in the existing rail, so the number reads as a caption of the handle.

## Scope

In:

- Drops campaign drag rail (`packages/popup-ui/src/drops.tsx`)
- `RankInput` `size="rail"` box in `packages/popup-ui/src/primitives.tsx`

Out:

- Idle Watchlist and settings `CompactRow` (`size="row"`)
- Growing the rail, overlay/badge treatments, locale keys, scheduler, or commit-rule changes

## Layout

The rail stays `w-7` with the same border and background. Inside it, a `w-4` column (`flex flex-col items-center gap-0.5`) holds:

1. The grip (`DragHandle`, or the 14px `GripVertical` overlay fallback)
2. `RankInput` `size="rail"`

The rail itself is `flex items-center justify-center` so that unit is centered. `gap-0.5` lives on the inner unit, not on the rail.

`RankInput` rail classes are `w-4` plus flex centering (`flex items-center justify-center text-center text-[10px] font-bold tabular leading-none`). They are not `w-full`. Display, edit input, and the search-mode static span all use that same box.

Two-digit ranks may clip. Do not grow the rail or the unit.

## Interaction

Unchanged from the rank-input spec: click/Enter/Space edit, Enter/blur commit, Escape cancel, `stopPropagation` so the card does not expand and drag does not start. Drops search still omits `onMove`. The edit field stays in the 16px slot (no overlay).

## Testing

Existing `DropsPanel` rank click/type/blur tests must still pass. Add one assertion that the Drops rank control’s class list includes `w-4` and does not include `w-full`, covering display and search-mode span.
