# Campaign filters gate farming

Date: 2026-07-24
Status: approved, not yet implemented

## Problem

`campaignVisibility` is the only filter in the product that does not affect farming. It
hides campaigns from the Drops list and nothing else. The engine never reads it:
`campaignVisibility` appears nowhere in `packages/core`, and `packages/cli/src/settings.ts`
lists it in `EXTENSION_ONLY_KEYS`, so the CLI rejects it as a knob.

Every other filter-shaped control already gates farming, in the engine:

- per-platform category curation (`farmAllCategories`, `categories`) — enforced by
  `isEligible`, and its list order also drives farming priority
- `excludedCampaignIds` — enforced by `isEligible`
- `priorityMode` — enforced by `isEligible`

So the settings UI presents two filter-shaped controls, "Categories" and "Visible
campaigns", that look equivalent but have completely different power. Nothing says which
is which. A user who hides a campaign reasonably assumes it stops being farmed; it does
not.

Two cases where a hidden campaign is farmed today:

1. **Kick unlinked campaign.** `isEligible` deliberately exempts Kick from the
   `accountLinked === false` rejection, because Kick accrues watch progress before
   linking. The popup tags the campaign `notLinked`. Turning that toggle off hides it
   while the scheduler keeps farming it.
2. **Mixed subscription/watch campaign.** Hidden by the `subscription` toggle, but
   `isEligible` still finds its earnable watch rewards.

## Decision

The campaign filters become a farming filter, not a display filter. The setting is
renamed to reflect its new power.

Of the six keys, only two have any farming meaning. The other four are no-ops against
`isEligible` — a campaign that is expired, finished or upcoming is already rejected, and
`excluded` is contradictory (exclusion already means "do not farm", so an `excluded: true`
farming filter would have to mean "farm the campaigns I explicitly excluded").

| Key | Farming effect |
| --- | --- |
| `notLinked` | **Real** — off stops farming unlinked Kick campaigns |
| `subscription` | **Real** — off stops farming mixed subscription/watch campaigns |
| `expired` | None — `isEligible` already rejects ended campaigns |
| `finished` | None — nothing earnable remains |
| `upcoming` | None — `status !== "active"` already rejected |
| `excluded` | None — but excluded campaigns are already never farmed, via `excludedCampaignIds` (see below) |

This is migration-safe. The only keys defaulting to `false` are `expired` and `excluded`,
neither of which is a farming key, so no existing user's farming behaviour changes on
upgrade.

### Exclusion is two independent mechanisms

Excluding a campaign and showing an excluded campaign are separate concerns, and stay
that way:

- **Never farmed** — enforced by `excludedCampaignIds` in `isEligible`. Already engine
  logic; untouched by this design. An excluded campaign is never farmed on either host,
  regardless of any filter setting.
- **Shown or hidden** — the `excluded` display key. Defaults to `false`, so excluded
  campaigns are hidden from the Drops list; set it to `true` and they appear, still
  unfarmed.

So an excluded campaign is never farmed, and is visible exactly when the user asks to see
excluded campaigns. This is why the `excluded` key must never become a farming key: it
would have to mean "farm the campaigns I explicitly excluded", contradicting the mechanism
that already implements exclusion.

## Settings contract

`campaignVisibility` moves from `ExtensionSettings` into `EngineSettings`, renamed
`campaignFilters`, and is removed from the CLI's `EXTENSION_ONLY_KEYS`. The CLI gains it
as a real knob.

The key set splits by farming meaning, in the type rather than in a comment:

```ts
type FarmingFilterKey = "notLinked" | "subscription";
type DisplayFilterKey = "expired" | "finished" | "upcoming" | "excluded";
type CampaignFilterKey = FarmingFilterKey | DisplayFilterKey;
```

`isEligible` consults only `FarmingFilterKey`. The display keys are structurally incapable
of affecting farming, rather than incidentally so.

Migration is schema version 1 → 2, emitting a `moved_property` diagnostic for
`campaignVisibility` → `campaignFilters`, carrying values across unchanged and defaulting
sanely when the old key is absent.

`notLinked` and `subscription` become load-bearing for the CLI, where they have never
existed. A CLI user who sets `campaignFilters: { notLinked: false }` will farm less, and
the CLI has no popup to explain why — so `lurkloot status` must name the filter when it
suppresses campaigns.

## Shared predicate

`campaignFilterCategories` moves from `packages/popup-ui/src/viewModels.ts` to a new
`packages/shared/src/campaignFilters.ts`, alongside `FARMING_FILTER_KEYS` and two
consumers of the same categorisation:

```ts
campaignPassesFarmingFilters(campaign, filters)     // engine
isCampaignVisible(campaign, filters, excludedIds)   // popup
```

Both derive from one `campaignFilterCategories` call, so the engine and the popup cannot
disagree about what "subscription-gated" means. `isEligible` gains a single line after its
exclusion check.

The farming predicate deliberately takes no `excludedIds`: the only keys it consults are
`notLinked` and `subscription`, neither of which needs it, and `isEligible` already rejects
excluded campaigns on its own line. Threading `excludedIds` through it would imply the
farming filter has an opinion about exclusion, which is exactly the confusion this design
removes.

The popup predicate keeps its existing escape hatch: a campaign with a claimable reward is
always shown. That must not leak into the farming predicate — a claimable-but-filtered
campaign stays visible so the user can claim it, without becoming farmable again.

Moving `campaignFilterCategories` brings `isCampaignExpired` and `isCampaignFinished` into
`shared` with it. That exposes a duplication: the scheduler's `hasCampaignEnded` and the
popup's `isCampaignExpired` both answer "has this ended", differently. Define
`isCampaignExpired(c) = c.status === "expired" || hasCampaignEnded(c)`, exactly equivalent
to today's popup behaviour, leaving the scheduler's callers untouched. Dedup with zero
behaviour change; no wider refactor.

`noEligibleCampaignReason` gains a branch for the new filter, so the reason surfaces in
diagnostics and `lurkloot status` instead of falling through to the generic "No eligible
campaigns".

## Settings UI

The filter control splits into two labelled groups in the same settings row, mirroring the
type split:

- **Farmed campaigns** — `notLinked`, `subscription`. Changes what you earn.
- **Shown in the Drops list** — `expired`, `finished`, `upcoming`, `excluded`. Display only.

The two groups are visibly different in power, so nobody has to infer it. The section
renames from "Visible campaigns" to "Campaign filters"; the registry id
`general.drops.campaignVisibility` becomes `general.drops.campaignFilters`. Existing
per-key labels are reused. `settingsSearch` keywords are updated so searching "visible"
still finds the row.

## Internationalisation

`packages/extension/tests/i18n.test.ts` asserts every locale's key set exactly equals
English's, so a key added to `en.json` alone fails the suite. Every new string ships in all
11 catalogs in the same commit: `ar, de, en, es, fr, hi, it, pt_BR, ru, tr, zh_CN`.

Roughly four new keys (section title, description, two group labels), so about 44
translated strings. Translations are provided for every locale present, not left to the
English runtime fallback.

## Testing

- **shared** — categorisation; the farming predicate ignores display keys, including
  `excluded`; the popup predicate keeps the claimable escape hatch and the farming
  predicate does not.
- **scheduler** — `isEligible` honours `notLinked` and `subscription`; the four display
  keys are provable no-ops; the new `noEligibleCampaignReason` branch fires. The Kick
  unlinked and mixed subscription/watch cases become explicit regression tests, as they
  are the two behaviours actually changing.
- **settingsMigrations** — v1 → v2 carries values across the rename, emits the
  `moved_property` diagnostic, defaults sanely when the old key is absent.
- **cli** — `campaignFilters` is accepted rather than rejected as extension-only; `status`
  names the filter when it suppresses campaigns.
- **popup** — both groups render, toggles still save, `settingsSearch` finds the renamed
  row.
- **i18n** — the existing parity test passes with all 11 catalogs.

## Rollout

One PR off `develop`. The change is only coherent as a whole; splitting the rename across
PRs would leave `develop` broken in between. Includes a `docs/architecture.md` update,
which its "Settings Migrations" section requires when adding a migration.

**Risk.** `CURRENT_SETTINGS_SCHEMA_VERSION` is still `1`, so the v1 → v2 path has never run
against real persisted data. Exercise the extension manually with pre-existing settings
before merging rather than trusting the unit test alone.

## Follow-up, out of scope

The Drops empty state gets its own spec, built on this one. Today `DropsPanel` renders a
single flat string, "No campaigns discovered yet.", for every cause — including the two
where campaigns *were* discovered and are merely filtered, which is false and is what sent
the user filter-toggling in the first place. Once filters are split into farming and
display, the empty state can distinguish "hidden by a display filter" from "excluded from
farming by a filter" and offer a one-tap fix that flips only the blocking toggles.
