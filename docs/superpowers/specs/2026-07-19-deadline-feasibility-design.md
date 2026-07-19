# Deadline Feasibility Design

## Goal

Prevent the extension and CLI from selecting watch rewards that cannot be completed before their deadline, while allowing users to disable the rule or configure a small scheduling buffer.

## Configuration

Add one engine-level setting named `deadlineSafetyMarginMinutes`:

- `-1` disables deadline feasibility filtering and preserves current scheduling behavior.
- `0` enables exact mathematical feasibility with no additional buffer.
- Integers from `1` through `60` enable filtering with that many additional required minutes.

The default is `5`. Settings normalization rounds finite values to the nearest integer and clamps them to the inclusive range `-1` through `60`. Missing, non-numeric, and non-finite values use the default.

Because this is part of `EngineSettings`, the same value and behavior apply to the extension and CLI. The popup exposes it in Advanced settings and renders `-1` as “Disabled” rather than as an unexplained negative duration. The generated CLI JSONC configuration documents all three modes.

## Feasibility Calculation

Create one pure, shared feasibility evaluator for watch rewards. It accepts a campaign, reward, configured margin, and injectable current timestamp, and returns a structured result suitable for both scheduling and presentation.

For an unearned watch reward:

1. Calculate remaining watch minutes as `max(0, requiredMinutes - watchedMinutes)`.
2. Parse the campaign deadline from `campaign.endsAt` and the reward deadline from `reward.availableUntil`.
3. Ignore missing or invalid timestamps. If neither timestamp is valid, return an unknown-deadline result and keep the reward farmable.
4. When both timestamps are valid, use the earlier one. This is the earliest applicable deadline.
5. Calculate the required duration as the remaining watch minutes plus the configured safety margin.
6. The reward is feasible when the time from `now` to the chosen deadline is greater than or equal to the required duration. Exact equality is feasible; any shortage is infeasible.

When the setting is `-1`, the evaluator returns a disabled result and does not reject any reward. Claimed rewards and non-watch rewards are outside this rule and retain their existing behavior.

Calculations use milliseconds internally so boundary behavior is deterministic. Human-facing messages may round durations for readability but do not influence the decision.

## Scheduler Integration

The scheduler applies feasibility alongside existing reward availability and precondition checks. It evaluates currently earnable rewards in the campaign using the existing preference for in-progress rewards before locked rewards, but skips infeasible candidates and continues looking for another earnable, feasible reward. A campaign is rejected for insufficient time only when it has no feasible watch reward that can currently be selected.

All scheduler paths that select or retain a reward use the same evaluator. This includes initial campaign selection, switching to a higher-priority reward, and deciding whether the current watch session remains valid. Disabling the setting bypasses this filtering everywhere.

The scheduler emits a specific diagnostic when a candidate is excluded. The message identifies the campaign and reward and reports the remaining watch minutes, available minutes, selected deadline, and configured margin. Existing generic `campaign_ineligible` session handling remains compatible, while the text explains the precise cause.

## Popup and CLI Presentation

The popup reuses the shared evaluator rather than duplicating deadline arithmetic. Affected rewards show an “Insufficient time remaining” explanation, and a campaign with no selectable feasible watch reward exposes the same reason in its UI state. This is derived at render time from current settings and the current clock, so time-sensitive status is not persisted into campaign data.

The CLI continues to report scheduler decisions through its existing event and diagnostic pipeline. Its generated JSONC template includes `deadlineSafetyMarginMinutes` with comments explaining `-1`, `0`, and positive values. CLI settings validation recognizes and normalizes the field through the same contract used by the engine.

All new user-facing popup copy is added to every locale catalog, following the repository’s existing localization fallback conventions.

## Data and Error Handling

No platform parser changes are required because normalized campaigns already expose `endsAt`, `availableUntil`, `requiredMinutes`, and `watchedMinutes`.

Missing or malformed deadlines are treated as unknown rather than infeasible, preserving current behavior as required by the issue. Negative or over-complete remaining work is clamped to zero. An already-passed valid deadline remains infeasible unless the reward is already earned or the feature is disabled.

The evaluator returns typed reason data instead of formatted UI strings. Each host formats that data for its own diagnostics or localized presentation.

## Testing

Deterministic unit tests use a fixed `now` value and cover:

- exact equality between available and required duration;
- a one-millisecond shortage;
- partial progress reducing remaining work;
- campaign-only and reward-only deadlines;
- selecting the earlier valid campaign or reward deadline;
- missing and invalid deadlines preserving farmability;
- zero and positive safety margins;
- `-1` disabling the rule;
- skipping an infeasible preferred reward in favor of another feasible reward;
- rejecting or stopping a campaign with no feasible selectable reward;
- settings defaults, rounding, and `-1..60` clamping;
- popup explanation and Advanced-setting behavior;
- CLI JSONC generation and parsing.

Relevant focused suites run first, followed by the repository’s full `pnpm verify` before completion.

## Out of Scope

- Predicting downtime, advertisements, stream endings, or platform-side progress lag beyond the configured fixed margin.
- Combining simultaneous progress across platforms or campaigns.
- Changing campaign priority ordering beyond excluding infeasible rewards.
- Rejecting rewards when deadline data is unavailable or invalid.
