# Backlog Roadmap Design

## Goal

Turn the current scheduler-related backlog into a dependency-aware action plan in the public [Lurkloot GitHub Project](https://github.com/users/jamezrin/projects/2).

## Project fields

Use the existing project fields only:

- `Status`: Backlog, Ready, In progress, In review, Done
- `Priority`: P0, P1, P2
- `Size`: XS, S, M, L, XL
- `Iteration`: Iteration 2 (2026-08-07 through 2026-08-20) and Iteration 3 (2026-08-21 through 2026-09-03)
- `Start date` and `Target date`
- `Area`: core or release/ci for this scope
- `Platform`: Twitch or Both

Later work uses start/target dates because the project currently exposes no iteration after Iteration 3.

## Roadmap assignments

| Issue | Role | Status | Priority | Size | Iteration | Start | Target | Area | Platform |
|---|---|---|---|---|---|---|---|---|---|
| #392 | Availability correctness prerequisite | In progress | P0 | M | Iteration 2 | 2026-08-15 | 2026-08-20 | core | Twitch |
| #391 | Independent reward-blocker correctness | Ready | P1 | S | Iteration 2 | 2026-08-15 | 2026-08-20 | core | Both |
| #336 | Independent heartbeat lane | Ready | P0 | L | Iteration 3 | 2026-08-21 | 2026-09-03 | core | Both |
| #339 | Reduce Twitch discovery cost | Ready | P1 | M | none | 2026-09-04 | 2026-09-10 | core | Twitch |
| #394 | Provider discovery snapshots | Backlog | P0 | XL | none | 2026-09-11 | 2026-09-24 | core | Both |
| #395 | Snapshot-driven target selection | Backlog | P0 | L | none | 2026-09-25 | 2026-10-08 | core | Both |
| #337 | Negative-search backoff in final architecture | Backlog | P1 | M | none | 2026-10-09 | 2026-10-15 | core | Twitch |
| #361 | Scheduler-efficiency epic | In progress | P0 | XL | none | 2026-08-15 | 2026-10-15 | core | Both |
| #382 | Initiative handoff and coordination tracker | In progress | P1 | XS | none | 2026-08-15 | 2026-10-15 | release/ci | Both |

## Dependency order

1. Complete #392 before any negative availability backoff. Confirmed progress must continue overriding ambiguous Twitch channel-availability evidence.
2. Complete #336 before the larger discovery refactor so farming cadence is protected independently.
3. Complete #339 before #394 so campaign-detail request reduction is established inside the discovery boundary.
4. Complete #394 before #395 because selection requires committed discovery snapshots.
5. Complete #337 after #395 so negative-search memory is implemented against the final discovery/selection architecture instead of rewritten.

#391 is independent and small enough to run alongside #392. #361 and #382 are tracking items, not implementation stages.

## Mutation rules

- Add an issue to Project #2 if it is not already present; do not duplicate items.
- Set only the approved roadmap fields. Do not change issue bodies, labels, milestones, assignees, or repository status.
- Preserve #392 as `In progress`; no issue is marked `Done` by this operation.
- Use exact ISO dates from the assignment table.
- Verify every item by reading the project after mutation.

## Success criteria

- All nine issues appear in the Lurkloot project.
- Each has the approved status, priority, size, area, platform, dates, and iteration where applicable.
- The roadmap communicates one critical implementation chain: #392 → #336 → #339 → #394 → #395 → #337.
- #391 is visibly parallel work and #361/#382 are visibly initiative trackers.
