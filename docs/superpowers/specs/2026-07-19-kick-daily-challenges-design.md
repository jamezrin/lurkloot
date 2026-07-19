# Kick daily challenges, and per-platform claim toggles

Closes #124.

## Problem

Kick ships a gamification feature called challenges: a daily lootbox that unlocks
once a watch-time threshold is met and awards a collectible card. Lurkloot farms
the watch time already but never claims the box, so the reward expires when the
daily window closes.

Separately, `autoClaimChannelPoints` exists in `EngineSettings` and is honored by
the scheduler, but the popup never renders a row for it. Extension users have no
way to turn Twitch channel-point claiming off; only the CLI can set it.

## Scope

Farm Kick challenges behind an on-by-default setting, and give both claim
behaviors a per-platform home the popup exposes. Collectibles
(`/api/v1/gamification/collectibles`) are out of scope: nothing here needs the
inventory, and surfacing owned cards is a separate feature.

## Design

### Settings shape

`PlatformSettings` is one shared interface used by both platforms today. Split it
so each platform can carry its own knobs, mirroring how `CompatibilitySettings`
is already per-platform:

```ts
export interface PlatformSettings {
  enabled: boolean;
  watchQueueChannels: string[];
  excludedChannels?: string[];
  farmAllCategories: boolean;
  categories: CategorySelection[];
}
export interface TwitchPlatformSettings extends PlatformSettings { autoClaimChannelPoints: boolean }
export interface KickPlatformSettings extends PlatformSettings { autoClaimChallenges: boolean }
```

`EngineSettings.platform` becomes `{ twitch: TwitchPlatformSettings; kick:
KickPlatformSettings }`. The top-level `autoClaimChannelPoints` is removed rather
than deprecated in place, so there is exactly one source of truth.

`SettingsPatch.platform` can no longer be `Partial<Record<Platform,
Partial<PlatformSettings>>>`; it becomes an explicit
`{ twitch?: Partial<TwitchPlatformSettings>; kick?: Partial<KickPlatformSettings> }`.

Migration lives in `mergeEngineSettings`: `platform.twitch.autoClaimChannelPoints`
falls back to the legacy top-level `autoClaimChannelPoints` before the default.
Only CLI users can have set it to `false`, since the popup never rendered it. The
legacy key is read, never written back.

Both new fields default to `true`, preserving today's behavior for channel points
and enabling challenge farming out of the box.

### CLI

`CliSettings` drops the flat `autoClaimChannelPoints`. `CLI_PLATFORM_KEYS` becomes
per-platform — Twitch accepts `autoClaimChannelPoints`, Kick accepts
`autoClaimChallenges` — so an unknown key still errors with the offender named.
The generated config template in `config.ts` moves both into their platform
blocks. `CliSettings.platform` no longer reuses `PlatformSettings` verbatim; the
comment saying it does is updated.

### Adapter surface

Challenges are account-level, so they do not fit `claimChannelPoints(channel)`.
Add a separate optional method that takes no channel:

```ts
export interface ClaimedChallenge { id: string; rarity: string; recurrence: string }

// on PlatformAdapter
claimChallenges?(): Promise<ClaimedChallenge[]>;
```

`KickAdapter` implements it through the existing `this.fetcher`, inheriting the
service-worker-first / page-tab-on-WAF-block path for free:

1. `GET https://web.kick.com/api/v1/gamification/challenges`
2. Eligible entries are those with `claimed_at == null` and
   `condition.progress >= condition.threshold`.
3. `POST https://web.kick.com/api/v1/gamification/challenges/{id}/claim` per
   eligible entry; read `data.winner.rarity` from the response.

The `status` string is deliberately ignored. The issue only documents
`"claimed"`, so any check against the other values would be a guess;
`claimed_at` plus the progress threshold is sufficient and self-evident. Any
`recurrence` is handled, not just `daily`.

### Throttle state

Adapters are rebuilt every tick in `createAdapters(settings, emit)`, so an
in-memory timestamp cannot survive. It goes in the persisted `SchedulerState`:

```ts
gamification?: Partial<Record<Platform, { lastCheckedAt: string }>>;
```

Polling runs when `now - lastCheckedAt >= 10 minutes`. The timestamp is stamped on
attempt, not on success, so a persistently failing endpoint is retried on the next
interval instead of on every tick.

### Scheduler wiring

A new per-platform block in `runSchedulerTick`, placed before the watch-decision
branch so it runs regardless of session status:

```
if (platform enabled && settings.platform[p].autoClaimChallenges
    && adapter.claimChallenges && throttleElapsed)
  → claimChallenges(), stamp gamification[p].lastCheckedAt, emit per claim
```

The call is wrapped in try/catch that emits a `warn` diagnostic and swallows,
matching the `claimChannelPoints` block. A gamification failure must never fail
the tick or trip the platform's error backoff — it is strictly additive to
farming.

Running outside the watch branch is the point: the 60-minute threshold is often
met by a session that has since stopped, and the claim still needs to happen.

### Events and notification

New `ActivityEvent` variant in `packages/shared/src/events.ts`:

```ts
| { category: "activity"; code: "challenge_claimed"; level: "info"; platform: Platform;
    message?: never; data: { challengeId: string; rarity: string; recurrence: string } }
```

`emitNotifications` derives everything from a state diff today, and challenge
claims are not in state. Rather than invent state purely to diff, pass the tick's
events in — `runSchedulerTick` already returns them. The call becomes
`emitNotifications(settings, state, result.state, result.events)`, and the
function scans for `challenge_claimed` when `notifyRewardEarned` is on.

This reuses `notifyRewardEarned` for a non-drop reward. Accepted trade-off: from
the user's side it is still "you earned something", and a second notification
toggle for one event type is not worth the settings surface. The cost is that
drop notifications and challenge notifications cannot be separated.

### Popup UI

Both rows render inside `PlatformSettingsGroup`, switched by the active platform
tab: Twitch gets auto-claim channel points, Kick gets auto-claim daily challenges.
The component takes narrow per-field callbacks today, so it gains one more in the
same style rather than a generic patch prop.

New locale keys across all ten catalogs: `autoClaimChannelPointsTitle` /
`autoClaimChannelPointsDescription`, `autoClaimChallengesTitle` /
`autoClaimChallengesDescription`, and `notificationChallengeClaimed`. `en.json` is
authored first, then the other nine translated.

`packages/site/src/faq.ts` already describes channel points as being behind "that
toggle", which only becomes true with this change. No edit needed.

## Testing

Vitest in `packages/extension/tests/`:

- `settings.test.ts` — legacy top-level `autoClaimChannelPoints: false` migrates
  onto `platform.twitch`; both new fields default `true`; `applySettingsPatch`
  round-trips the split platform types.
- `adapters.test.ts` — Kick `claimChallenges` against a mocked fetcher: skips
  already-claimed entries, skips `progress < threshold`, claims eligible entries
  and reports rarity, survives a malformed or error response.
- `scheduler.test.ts` — fires when the platform is idle; respects the 10-minute
  throttle; no call when the setting is off or the adapter lacks the method; a
  throwing `claimChallenges` leaves session status untouched.
- CLI config tests for the moved and new keys, including the rejection message for
  the now-invalid top-level key.

Per repo convention, nothing asserts on `.github/workflows` contents.

## Risks

The response shapes come from the issue's captures, not from a live session. Two
unknowns remain:

- The `status` value for an unclaimed-but-complete challenge is undocumented.
  Mitigated by keying eligibility off `claimed_at` and the progress threshold
  instead.
- Whether `/claim` is idempotent or errors on a double-claim is unknown.
  Mitigated by catching and logging claim errors rather than propagating them.

Both resolve on the first real run against a live Kick account.
