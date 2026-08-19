# Clarify Next Reward Remaining Time

## Context

The expanded campaign card currently renders the campaign-wide remaining watch time beside the next reward. For sequential rewards, that makes the next reward appear to require the sum of every remaining reward's watch time.

## Design

`campaignStats()` will continue to calculate `remaining` as the total watch time left across the campaign. It will also expose `nextRewardRemaining`, calculated from the next incomplete watch reward's own requirement and progress and clamped to zero.

The expanded campaign card will use `nextRewardRemaining` beside `Next: <reward>`. The three-column summary will continue to use the campaign-wide `remaining`, but its label will use a new localized `campaignLeft` message so the scope is explicit.

All locale catalogs will define `campaignLeft`. Diagnostic messages are unaffected.

## Edge Cases

- A partially progressed next reward reports only its own remaining minutes.
- A completed campaign does not show next-reward time, matching current rendering behavior.
- A non-watch next reward does not show watch-time remaining.
- Campaign totals and progress calculations retain their existing semantics.

## Testing

Focused view-model tests will cover untouched sequential rewards and a partially progressed next reward. Existing popup, typecheck, and build verification will protect the UI and locale integration.
