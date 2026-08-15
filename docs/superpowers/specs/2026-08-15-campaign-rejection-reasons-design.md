# Campaign Rejection Reasons Design

## Context

Lurkloot can discover a large Twitch or Kick campaign inventory and then reject every campaign before channel selection. Diagnostics currently show discovery and selection totals but not the predicates responsible for rejection. The popup can display a campaign that is not farmable without explaining why, while some setting descriptions imply broader behavior than platform rules allow.

Issue [#389](https://github.com/jamezrin/lurkloot/issues/389) tracks this work.

## Goals

- Explain every scheduler-level campaign rejection with a stable, structured reason.
- Keep scheduler behavior, diagnostics, and popup explanations aligned through one shared evaluator.
- Log aggregate rejection counts and actionable details without repeating unchanged snapshots every minute.
- Show a compact indicator on collapsed campaign cards and a localized explanation on expanded cards.
- Explicitly explain when Twitch requires account linking despite the global unlinked-campaign preference.

## Non-goals

- Change which campaigns or rewards are farmed.
- Diagnose failures that occur after a campaign enters channel selection, such as no live eligible channel.
- Localize diagnostic bodies; diagnostics remain English literals.
- Persist a second copy of derived rejection state in scheduler storage.

## Considered Approaches

### Duplicate scheduler and popup checks

The scheduler could add logging around its existing predicates while the popup independently derives display copy. This is the smallest local edit but recreates the drift that the shared campaign-filter module was introduced to prevent. Rejected.

### Store the scheduler's latest reason in campaign state

The scheduler could annotate or separately persist every campaign after each tick. This would make the popup consume the exact scheduler result, but introduces synchronization and migration concerns for data that is deterministic from campaign plus settings. It would also leave non-running or freshly opened hosts without a reason until another tick. Rejected.

### Shared pure evaluator

Add a pure evaluator to `@lurkloot/shared` that returns either farmable or one primary rejection code with structured context. The scheduler uses it for filtering and diagnostics; popup view-model construction uses it for localized presentation. This preserves one definition, needs no persistence migration, and is independently testable. Chosen.

## Shared Evaluation Model

Create a focused shared module for campaign farming evaluation. Its public result is a discriminated union:

- `{ farmable: true }`
- `{ farmable: false, code, rewardId?, deadline?, remainingMinutes?, availableMinutes? }`

The stable rejection codes cover:

- excluded campaign;
- upcoming, expired, or completed lifecycle;
- campaign with no rewards;
- farming-eligibility setting rejection;
- Twitch account linking required;
- category filter mismatch;
- priority-list-only mismatch;
- no unclaimed rewards;
- reward availability window not open or already closed;
- unmet reward prerequisites;
- no watch-based reward;
- deadline infeasibility;
- no currently farmable reward as a final explicit fallback.

Evaluation order is intentional and user-facing. Campaign-level configuration and lifecycle reasons win before reward-level reasons. For reward-level rejection, the evaluator examines every unclaimed reward and chooses the most actionable primary reason. If at least one reward is farmable, the campaign is farmable.

The existing `campaignEligibleClass`, `campaignFarmable`, and scheduler `isEligible` APIs become thin consumers of this evaluator where possible. Priority-list-only remains part of the scheduler evaluation options because it is a farming strategy rather than campaign visibility.

## Diagnostics

After each successful campaign refresh, evaluate every discovered campaign using the current settings. Build a stable fingerprint from campaign IDs and rejection codes plus reason-defining context. Emit only when that fingerprint changes.

The aggregate English diagnostic accounts for every discovered campaign, for example:

`Campaign farming evaluation: 110 discovered, 1 farmable, 94 expired, 8 completed, 4 account linking required, 3 no currently farmable reward`

At the same time, emit one English diagnostic for each rejected active campaign. Lifecycle noise from old expired/completed campaigns remains represented in the aggregate but does not produce individual lines. Each detail includes campaign name, campaign ID, stable code, and relevant reward/deadline context. No locale keys are created for diagnostic bodies.

The fingerprint is held in in-memory scheduler state rather than persisted settings/storage. Extension background restarts may emit one fresh snapshot, which is desirable diagnostic context; unchanged minute ticks do not.

## Popup Presentation

`CampaignView` gains the evaluator's rejection code and only the safe context needed for presentation. View-model construction evaluates the campaign with the same settings passed to the scheduler.

A visible, non-farmed rejected campaign receives:

- a compact warning indicator in the collapsed card metadata;
- a localized explanation row inside the expanded card;
- no warning when the campaign is actively being farmed;
- existing lifecycle and reward-specific UI retained where it provides more detail.

Copy describes the reason and, when appropriate, the corrective action. The Twitch link case reads substantially as “Account linking is required for this Twitch campaign.” The global setting description is clarified to say platform requirements may still require linking.

All locale catalogs receive the new keys. English source copy is authoritative; existing localization conventions are followed for the other catalogs.

## Data Flow

1. An adapter returns `DropCampaign[]`.
2. The shared evaluator consumes each campaign plus `EngineSettings` and strategy options.
3. The scheduler filters with the result and derives a change-triggered diagnostic snapshot.
4. Popup view-model construction evaluates the same campaign and settings.
5. React renders a compact indicator and expanded localized explanation from the structured code.

No browser API, WXT dependency, React type, or localized string enters `@lurkloot/shared` or `@lurkloot/core`.

## Testing

- Shared evaluator unit tests cover every rejection code and evaluation precedence.
- Binding tests prove `farmable: true` agrees with existing `campaignFarmable` behavior and scheduler selection.
- Scheduler tests prove aggregate accounting, active-campaign details, change-triggered deduplication, and re-emission after a changed reason.
- View-model tests prove rejection data reaches `CampaignView`.
- Popup rendering tests prove collapsed and expanded presentation and suppression while actively farming.
- Locale consistency tests ensure every catalog contains all new keys.
- Existing extension, CLI, typecheck, and site suites guard cross-package behavior.

## Success Criteria

- The reported pattern—successful discovery followed by zero checked campaigns—produces enough information to identify the exact rejecting predicate from one diagnostic export.
- A user can expand any visible rejected campaign and understand why it is not being farmed.
- Scheduler selection outcomes do not change.
- Unchanged rejection snapshots generate no per-minute diagnostic spam.
