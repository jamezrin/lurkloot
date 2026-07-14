# Category Selection Icons Design

## Problem

Selected Twitch and Kick categories in the popup settings always render an
initials placeholder, even when the category has artwork. Platform category
search already returns `CategorySelection.imageUrl`, and settings normalization
already preserves it. The selected row and drag overlay ignore that value.

The zero-network "Has active drops" path has a second data-loss point:
`gameItemsFromCampaigns` omits `DropCampaign.gameImageUrl`, and selecting a
suggestion saves only its id and name.

## Scope

Fix issue #91 for both Twitch and Kick category settings. Selected categories
with artwork render a 32px rounded-square thumbnail in the normal sortable row
and its drag overlay. Categories without artwork, categories whose image fails
to load, and the synthetic "No category" selection retain the initials fallback.

This change does not alter farming eligibility, category ordering, platform
requests, permissions, storage format, or watch-queue row behavior. It adds no
dependencies.

## Design

Extend `GameItem` with an optional `imageUrl`. Populate it from
`DropCampaign.gameImageUrl` in `gameItemsFromCampaigns`, and pass it through when
a user adds a "Has active drops" suggestion. Search-selected categories already
carry the same field and need no data-layer change.

Extend `CompactRow` with an optional `avatarImageUrl`. When present, the avatar
container uses the existing `ImageWithFallback` primitive to render a
rounded-square, cover-fitted image. The fallback is the existing styled initials
avatar. When absent, rendering remains identical to today. Only category rows
and their drag overlay pass the new prop, so watch-queue consumers remain
unchanged.

The image should use an empty alternative description because the adjacent row
title already names the category. A failed remote image switches to initials
without changing row size or layout.

## Data Flow

For category search:

1. The platform adapter returns `{ id, name, imageUrl }`.
2. The popup saves the full `CategorySelection`.
3. Settings normalization preserves `imageUrl`.
4. The selected row and drag overlay pass it to `CompactRow`.
5. `ImageWithFallback` displays the thumbnail or initials fallback.

For active-drop suggestions:

1. A campaign provides `gameImageUrl`.
2. `gameItemsFromCampaigns` maps it to `GameItem.imageUrl`.
3. Selecting the suggestion saves `{ id, name, imageUrl }`.
4. Rendering follows the same selected-row path as search results.

## Testing

Add deterministic Vitest coverage for the two regression boundaries:

- `gameItemsFromCampaigns` retains campaign category artwork and leaves the
  synthetic "No category" item without an image.
- `CompactRow` renders an image when `avatarImageUrl` is present and preserves
  the initials-only markup when it is absent.

The implementation follows a red-green cycle for each behavior. Final
verification runs the focused tests, the full extension test suite, workspace
typechecks, and the site build through `pnpm check`.

## Acceptance Criteria

- Search-selected categories with artwork show a rounded-square thumbnail.
- Active-drop suggestions preserve and show available campaign artwork after
  selection.
- The drag overlay uses the same artwork as the selected row.
- Missing or failed artwork falls back to initials without layout shift.
- Twitch and Kick follow the same UI path.
- Existing watch-queue avatars and category filtering behavior are unchanged.
