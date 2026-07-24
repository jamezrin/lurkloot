# Campaign filters gate farming

Date: 2026-07-24
Status: implemented as a single `campaignFilters` control (commits on
`feat/campaign-filters-gate-farming`); superseded before merge by Revision 2
below, which decouples the farming and display axes. Read Revision 2 first — the
original design in the body is retained for history but is NOT the shipping shape.

---

## Revision 2 — decouple the farming and display axes

Date: 2026-07-24 (same branch, before PR #236 merged)

### Why revise

The single `campaignFilters` control shipped in the first pass conflates two
unrelated concerns in one field, and the conflation is observable as a bug: the
popup's `isCampaignVisible` consults *every* filter key, so turning off farming
for the `notLinked` or `subscription` group **also hides those campaigns from the
Drops list**. The two-group UI ("Farmed campaigns" / "Shown in the Drops list")
promises a separation the code does not honour — the farming-group toggles also
hide, while the display-group toggles only hide. There is no way to stop farming
a subscription campaign while still watching for it in the list.

The root cause is that "farm this" and "show this" are two independent axes fused
into one `Record<CampaignFilterKey, boolean>` that half-belongs to the engine.
Splitting them also fixes an architecture smell the first pass introduced: the
CLI now accepts four display-only keys (`upcoming`/`expired`/`finished`/`excluded`)
that do nothing headless.

### The two axes, on the correct side of the engine/extension boundary

**Farming eligibility — `EngineSettings.farmingEligibility`** (the CLI honours it):

```ts
farmingEligibility: {
  farmUnlinkedCampaigns: boolean;      // default true
  farmSubscriptionCampaigns: boolean;  // default true
}
```

Only these two categories have farming meaning. `expired`/`finished`/`upcoming`
describe campaigns `isEligible` already rejects, and `excluded` is enforced by
`excludedCampaignIds`. `isEligible` reads the two flags directly:

```ts
if (!settings.farmingEligibility.farmUnlinkedCampaigns && campaign.accountLinked === false) return false;
if (!settings.farmingEligibility.farmSubscriptionCampaigns && campaignHasSubscriptionRewards(campaign)) return false;
```

A small shared helper `campaignPassesFarmingEligibility(campaign, farmingEligibility)`
holds this so the popup can show the same "won't be farmed" state the engine
computes. It replaces `campaignPassesFarmingFilters`.

**Drops list view — `ExtensionSettings.dropsListFilter`** (extension-only, where
view preferences live; the CLI rejects it):

```ts
dropsListFilter: {
  showUpcoming: boolean;   // default true
  showExpired: boolean;    // default false
  showFinished: boolean;   // default true
  showExcluded: boolean;   // default false
}
```

`isCampaignVisible(campaign, dropsListFilter, excludedIds)` consults only these
four lifecycle/excluded categories plus the existing claimable-reward escape
hatch. It never consults link status or subscription — so a campaign you have
chosen not to farm still appears in the list, subject only to its lifecycle
state. Defaults preserve today's visible set exactly.

### UI

Settings → Drops, sectioned so behaviour and view are visibly different kinds of
thing:

- The two **farming eligibility** toggles are full `SettingRow`s grouped with the
  other farming-behaviour controls (auto-claim, priority mode): *Farm campaigns
  without a linked account* and *Farm campaigns that require a subscription*.
  Importance earns a full row with a description.
- The four **Drops list** view toggles remain a compact chip row, inheriting the
  `--accent-contrast` fix so active chips are legible on the Kick accent.

The two-group pill widget from the first pass is removed.

### Deliberately out of scope

"What gets farmed" is spread across four controls (category curation, farming
eligibility, exclusions, priority mode's `priority_list_only`). Three are
different interaction models — per-platform selection, per-campaign imperative
action, and an ordering mode — and merging them into one widget is worse UI, not
better. The runtime unifier is the Drops **empty state** ("why is nothing being
farmed / shown?"), speced separately and unblocked by this decoupling because it
can now distinguish "hidden by a view filter" from "skipped by a farming rule".
That is the immediate follow-up, not part of this change.

### Migration

Schema v2 has not shipped (`CURRENT_SETTINGS_SCHEMA_VERSION` was `1` in every
released build, and PR #236 is unmerged), so v2 is reshaped in place rather than
stacking a v3. The only shape any real install carries is the original
`campaignVisibility` record; v2 maps it into the two new fields and deletes it:

```
campaignVisibility.notLinked      -> farmingEligibility.farmUnlinkedCampaigns
campaignVisibility.subscription   -> farmingEligibility.farmSubscriptionCampaigns
campaignVisibility.upcoming       -> dropsListFilter.showUpcoming
campaignVisibility.expired        -> dropsListFilter.showExpired
campaignVisibility.finished       -> dropsListFilter.showFinished
campaignVisibility.excluded       -> dropsListFilter.showExcluded
```

Values carry over untouched, so no existing user's farming or visible set
changes on upgrade. The interim `campaignFilters` name never shipped and is
dropped entirely; no persisted document ever contained it.

### CLI

`farmingEligibility` is a real CLI knob in `EngineSettings`, validated key-and-value
like the first pass validated `campaignFilters`. `dropsListFilter` is
extension-only — added to `EXTENSION_ONLY_KEYS`, so a CLI config that sets it gets
a clear "extension-only" diagnostic rather than silently accepting inert keys.

### Testing delta from the first pass

- shared: `campaignPassesFarmingEligibility` reads only the two flags;
  `isCampaignVisible` provably ignores link status and subscription (the coupling
  regression test — a not-farmed subscription campaign is still visible).
- scheduler: the two eligibility flags gate farming; the reason branch still
  fires; unchanged defaults farm the same set.
- migration: v2 maps the six old keys into the two new fields with values intact.
- cli: `farmingEligibility` accepted and validated; `dropsListFilter` rejected as
  extension-only.
- popup: two farming rows + one view chip row render; search still finds them.
- storage end-to-end: a stored `campaignVisibility` document loads with both new
  fields populated and the canonical envelope written once.

---

## Original design (Revision 1 — superseded, retained for history)

Date: 2026-07-24
Status: implemented then superseded by Revision 2

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

Migration is schema version 1 → 2, using the existing `renameProperty` helper, which emits
a `deprecated_property` diagnostic for `campaignVisibility` → `campaignFilters`, carries
the value across unchanged, and lets a present current key win. (`moved_property` is for
relocations into a nested block, like `autoClaimChannelPoints` → `platform.twitch`; this is
a same-level rename.)

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
  `deprecated_property` diagnostic, defaults sanely when the old key is absent.
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
