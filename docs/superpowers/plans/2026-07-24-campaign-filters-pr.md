# feat(settings): make the campaign filters gate farming

## Summary

Hiding a campaign in the **Farmed campaigns** group now actually stops it being
farmed. Until now the campaign filters were the only filter-shaped control in the
product that changed nothing but the Drops list: a user could turn off "Not
linked", watch the campaign disappear from the popup, and the scheduler would keep
farming it in the background. That is fixed, and the setting is renamed from
`campaignVisibility` to `campaignFilters` because the old name promised a
display-only setting that this is no longer.

**Nothing changes under default settings.** The two keys that gate farming both
default to `true`, so a profile that never touched the row farms exactly what it
farmed before.

The Settings → Drops row is now split into two labelled groups:

- **Farmed campaigns** — `notLinked`, `subscription`
- **Shown in the Drops list** — `upcoming`, `expired`, `excluded`, `finished`

Each group is a `role="group"` with an accessible name, so a screen-reader user
hears which half of the row a toggle belongs to instead of six undifferentiated
checkboxes.

## Why only two keys gate farming

`FARMING_FILTER_KEYS` is `["notLinked", "subscription"]`. The other four are
no-ops against `isEligible`, so wiring them in would have been theatre:

| Key | Farming effect |
| --- | --- |
| `notLinked` | **Real** — off stops farming unlinked Kick campaigns, which `isEligible` deliberately exempts from the `accountLinked === false` rejection because Kick accrues watch progress before linking |
| `subscription` | **Real** — off stops farming mixed subscription/watch campaigns, whose watch rewards are otherwise still earnable |
| `expired` | None — `isEligible` already rejects ended campaigns via `hasCampaignEnded` |
| `finished` | None — nothing earnable remains |
| `upcoming` | None — `status !== "active"` is already rejected |
| `excluded` | None — and see below |

`campaignPassesFarmingFilters` takes no exclusion set on purpose. It reads only
the two farming keys; `isEligible` rejects excluded campaigns on its own line.

## Exclusion is unchanged

Excluded campaigns were never farmed and still are not: `excludedCampaignIds` is
checked by `isEligible` independently of any filter. The `excluded` filter key
only decides whether an excluded campaign is still *listed* in the Drops view.
Reading it as a farming key would have to mean "farm the campaigns I explicitly
excluded", which is incoherent, so it stays display-only.

The popup's one escape hatch — a campaign with a claimable reward always stays
visible so the user can claim it — lives in `isCampaignVisible` and deliberately
never reaches the farming predicate.

## Migration

`campaignFilters` moved out of the extension-only layer into `EngineSettings`, so
the CLI honours it too and it is no longer in `EXTENSION_ONLY_KEYS`. CLI values
are validated as booleans and a non-boolean is rejected rather than coerced.

Settings schema v1 → v2 renames the persisted `campaignVisibility` key to
`campaignFilters`, carrying the stored values over untouched and emitting a
`deprecated_property` diagnostic pointing at the replacement path. Extension
storage upgrades itself on the next `loadSettings`; the CLI's JSONC file is never
rewritten, so its diagnostic repeats as a startup warning until the user edits
the file.

**No existing user's farming behaviour changes on upgrade.** The only keys that
default to `false` are `expired` and `excluded`, and neither is a farming key, so
even a profile that opted into the non-default state farms the same set of
campaigns before and after.

## Testing

`pnpm verify` from the worktree root, exit code 0:

- `cws:test` — 17 passed
- `release:test` — 70 passed
- workspace typechecks — clean
- `@lurkloot/cli` — 122 tests in 9 files, all passing
- `@lurkloot/extension` — 826 tests in 46 files, all passing
- `@lurkloot/site` — 3 tests passing, Astro build complete
- Chromium MV3 and Firefox MV2 production builds both succeeded

New coverage in this branch: `packages/extension/tests/campaignFilters.test.ts`
for the categorisation and both predicates, scheduler cases for the two farming
keys, settings-migration fixtures for v1 input / mixed old-and-current input /
fully migrated output, popup registry and view tests for the split groups and
their accessible names, and CLI settings tests for acceptance and boolean
validation. The last commit adds an end-to-end storage test that drives the
extension's real `loadSettings` with a stored v1 document carrying
`campaignVisibility`, asserting the user's `false` values survive under
`campaignFilters` and that the canonical v2 envelope is written back exactly once.

## Manual verification still required

No automated test exercises a real browser profile, and the migration has never
run against real persisted data — `CURRENT_SETTINGS_SCHEMA_VERSION` was `1` in
every shipped build. Before merging:

1. Load the new build against a profile that already has settings written by a
   released version (not a fresh profile — a fresh profile takes the defaults and
   proves nothing).
2. Open **Settings → Drops** and find the **Campaign filters** row.
3. Confirm the six toggles show the states that profile had set, not the
   defaults. In particular, if the profile had turned "Expired" on or "Finished"
   off, those states must still be there.

If the filters come back defaulted, the migration lost the user's data and **this
PR must not merge.**

## Screenshots

The popup settings UI changed (the row is renamed and split into two labelled
groups), so per the repo's PR guidelines screenshots of Settings → Drops are
expected — one before, one after, ideally including the dark theme.
