# Activity as a rewards summary

Status: design, agreed in conversation on 2026-10-30. Origin: issue #940 (show the Kick daily-challenge
card in Activity), widened by the maintainer to cover every reward Lurkloot obtains.

## Intent

Activity is where a user goes after an hour or a day of farming to find **everything they were given**:
Twitch drops, Twitch channel points (watch gains, bonus claims, watch-streak payouts), Kick
daily-challenge cards, and Twitch Extension rewards (Fortnite captures, NoPixel packs and giveaways). It
stops being an append-only log and becomes a **summary of what happened, per farming session**.

Each reward shows every fact we hold about it: name, picture, amount, rarity, channel, game, campaign.
Today most of that is dropped before it reaches the event (see "Data we drop today").

It must grow: a new reward type or a new Twitch Extension provider should report its rewards through a
general contract, and the popup should show it reasonably without a bespoke layout.

## Goals

- One session block per farming session per platform, newest first, with:
  - totals tiles (points, drops, cards, extension rewards: whichever are non-zero),
  - **Rewards** (listed one by one, newest first) above
  - **Points by channel** (tallied: one row per channel, total plus a per-reason breakdown), and
  - **Status** (farming started/stopped, interruptions, auth changes, critical failures) collapsed by
    default behind a "Status (n)" disclosure.
- Past sessions collapse to one line (time range, points total, reward count) and expand on click into
  the same block.
- Points aggregate per channel **within a session**. A session runs from when farming is enabled for
  the platform until it is disabled, and survives browser and extension restarts.
- Past sessions are kept for 30 days, the existing Activity retention.
- Tab open/close events (`page_context_*`) leave Activity and appear only in Diagnostics.
- Reward kinds declare whether they are **listed** (one entry each) or **tallied** (summed per key per
  session). The popup picks a layout per kind and falls back to a generic row for any kind it has no
  layout for.
- Fortnite may now keep item names and images (maintainer relaxed the no-images rule in
  `packages/core/src/extensions/fortnite/state.ts`).

## Non-goals

- A date-range picker (Today / 7 days / 30 days). Considered as layout B and rejected: ranges cross
  sessions, and the maintainer chose sessions as the unit.
- Kick channel points. Kick exposes no per-gain points feed we use today.
- Click-to-enlarge card art. Possible follow-up.
- Changing what Diagnostics records or its 7-day retention.

## Anti-goals

- One stored row per points gain. Activity is capped at `MAX_RECORDS_PER_CATEGORY = 2_000`. At roughly
  20 gains per channel per hour, per-gain rows would push drops out of storage within days.
- A popup that crashes or shows `[object Object]` on stored rows from older versions, including
  `page_context_*` rows and any code the current build no longer emits.
- Platform parsing in the popup or the scheduler. Kick, Twitch and extension parsing stays behind
  `PlatformAdapter` and the extension drivers.

## Data we drop today

| Source | Dropped today | Where |
|---|---|---|
| Twitch/Kick drop (`reward_claimed`, `farming_*`) | campaign `gameName`, `gameImageUrl`, channel on claim | emit sites in `claimService.ts`, `rewardClaims.ts`, `scheduler.ts`, `helpers.ts` |
| Kick daily card (`challenge_claimed`) | `winner.card_url`; `consolation` (watch-time minutes, next-level badge image) | `KickChallengeClaimResponse` in `platforms/kick/index.ts` |
| Twitch points | every `points-earned` (reason, amount, channel id); only logged at debug | `channelPointsPush.ts` |
| NoPixel pack | per-card `card_id` and `edition` (normal/legendary/gold) | `extensions/nopixel/driver.ts` |
| Fortnite capture | anything beyond collectable `id` and `phaseId` | `extensions/fortnite/state.ts` |

## Design

### Events

Split codes by **who consumes them**, not by how they look.

- **`reward_claimed`** stays the drop event. It drives state in `tickRun.ts`, `claimService.ts` and the
  claim notifications, so it is not renamed. Its data gains optional `gameName`, `gameImageUrl` and
  `channel`. `farming_started`/`farming_stopped` gain the same game fields.
- **New `reward_obtained`** is the one general listed-reward event. Data:
  - `kind`: a member of a closed union in `@lurkloot/shared` (initially `challenge_card`,
    `extension_capture`, `extension_pack`, `extension_giveaway`), extended by adding a member;
  - `source`: `{ platform, extension?: TwitchExtensionProviderId }`;
  - optional `name`, `imageUrl` (https only), `amount`, `rarity`, `channel`, `itemId`, and
    `details: Array<{ key; value }>` for kind-specific extras (Kick recurrence, consolation minutes,
    NoPixel edition counts) that the generic row can show as chips;
  - `sessionId` (below).
  The Kick card and every extension emitter move onto it.
- **New `points_earned`** is the tallied points event: `{ channelId, channelLogin?, reason, amount,
  sessionId }`, with `reason` one of Twitch's `reason_code` values kept as a string (WATCH, CLAIM,
  WATCH_STREAK, RAID, …) so new reasons show without a code change.
- **`challenge_claimed`** and **`twitch_extension_action`** stay in the union as read-only legacy codes,
  so 30 days of stored rows keep rendering. Nothing emits them. Before retiring each emitter, move its
  consumers over: `reporting.ts:485` (the challenge notification), `tickRun.ts:587`,
  `cli/src/events.ts`, `activityDiagnostics.ts`.
- **`page_context_opened`/`_closed`** stop being Activity. `tickRun.ts:664` reads `page_context_opened`
  to call `recordManagedTabOpen`, so that accounting must keep working; the builder chooses whether the
  events become typed diagnostics (and the churn reader follows) or stay in the engine contract and are
  filtered out of Activity storage. A test must show churn is still recorded. The old rows stay readable
  (see "Legacy rows").

The extension point is a **kind registry** in `@lurkloot/shared`: for each kind, whether it is listed or
tallied, plus its tally key for tallied kinds. Points are tallied by `channelId`; the registry shape
should let a future tallied kind (say Fortnite captures per item) key by channel plus item.

### Sessions

- The engine owns session identity. `SchedulerState` gains an open session per platform
  (`{ id, startedAt }`). Only the settings transition (farming enabled/disabled for a platform) and a
  startup reconcile write it. The reconcile opens a session when the platform is already enabled and
  none is open (fresh install, update from a version without sessions).
- "Enabled" is `settings.platform[p].enabled`. There is no global automation switch any more
  (`isFarmingActive` in `packages/shared/src/settings.ts`). **Only that toggle starts or ends a session.**
  Signing out, `pauseOnManualWatch`, a parked platform after a manual tab close, and backoff do not end
  or split a session; they appear as Status rows inside it. This keeps one writer for session state.
  *(My call.)*
- Session boundaries are activity events `session_started`/`session_ended` (data: `sessionId`,
  `startedAt`; the end carries reason `disabled`).
- **Every activity event** for a platform emitted while its session is open carries `sessionId`:
  rewards, points and status rows alike. The popup groups by `sessionId`. Events with no platform
  (`interruption` may have none) are the one exception: they show in the block of the session that was
  open when they happened, by time, in the platform tab being viewed (the tab already shows
  platformless events in both). *(My call.)* Rows stored before this change go into one **Earlier**
  block at the bottom.
- Points that arrive while no session is open are not counted.

### Storage (extension)

- A pure **fold reducer** lives browser-free (`@lurkloot/shared` or core) and turns a session's events
  into a summary: per-channel totals with per-reason `{ count, amount }`, reward counts, start and end.
  It has its own unit tests.
- The extension's IndexedDB activity database goes from version 2 to 3 and adds a `sessions` store.
  Tallied events are folded into their session record **inside one readwrite transaction** (push and
  tick writes race). They are never appended to the events store.
- Listed rewards, status and session boundary events are still appended to the events store as today.
  With points out of it, the 2,000-row cap is ample for 30 days. Reward counts in the totals tiles are
  computed from the rows returned, not from stored counters, so a trimmed row can never leave a tile
  saying "3 drops" over two entries. Only tallied points are stored as folded totals. *(My call.)*
- The flat paged `getActivity` stays for the search box and for the activity export: a non-empty search
  shows today's flat filtered list; an empty search shows sessions. *(My call.)*
- `clear()`, reset, `prune()` and `deleteDatabase()` cover the sessions store. Sessions whose end is
  older than 30 days are pruned. The open session is never pruned.
- A new message (e.g. `getActivitySessions`, with a cursor) returns session summaries plus their listed
  rewards and status rows, because the paged `getActivity` (80 per page) cannot return whole sessions.
- Diagnostics: tallied events **skip** the activity-to-diagnostic mirror in `withActivityDiagnostics`,
  since `channelPointsPush.ts` already logs each gain at debug and the diagnostic cap is the same 2,000.
- The CLI (`cli/src/events.ts`) prints listed rewards as today, prints `session_started`/`session_ended`
  as one line each, and prints points gains at debug level only. It does not persist or fold sessions;
  the fold reducer lives in `@lurkloot/shared` so a later CLI summary can reuse it. *(My call.)*

### Twitch points

- Hermes subscribes the viewer's `community-points-user-v1` topic only when a claim or streak owner
  exists (`wantsPointsTopic()`). Add a **points owner**, active while a Twitch session is open, so
  points are observed with auto-claim off.
- In `handleNotification`, the `WATCH_STREAK` branch returns early. The points hook runs **before** that
  return so streak payouts are counted.
- `points-earned` carries only `channel_id`. Tally by id and resolve the login and display name
  separately: from channels the engine already knows (candidates, the watch target, the watchlist),
  else a cached lookup through the Twitch adapter. Unresolved channels show their id until resolved.
- **Open question for the maintainer:** the topic covers the whole account, so points earned on a phone
  or TV also arrive. Count everything on the account, or only channels the extension watched or
  claimed on?

### Kick card, NoPixel, Fortnite

- **Kick:** `claimChallenges` parses `winner.card_url` (https only) and `consolation`
  (`watch_time_minutes`, `next_level_badge.image_url`) into `ClaimedChallenge`. The emitter sends
  `reward_obtained` with kind `challenge_card`, `imageUrl`, `rarity`, and details for recurrence and
  consolation. There is no card name; the summary reads like "Legendary card".
- **NoPixel:** the driver reports a pack open with its card count and per-edition counts (kind
  `extension_pack`), and a giveaway entry (kind `extension_giveaway`). Card art and names are unknown.
- **Fortnite:** the state model may keep the collectable's display name and image if the vendor state
  carries them. Field names are **not known**: until a live sample confirms them, a capture is reported
  without name or image and renders through the generic row.
- Extension rewards are reported through the driver's `publish` (sessions end with the driver, #594),
  carrying the generic `reward_obtained` shape, so a new provider needs no popup change.

### Popup

Layout A ("Sessions"), with two changes taken from layout B: Rewards sit above Points by channel, and
Status is collapsed by default.

- `buildActivityCard` becomes a reward **view model** built from a kind-keyed registry in popup-ui.
  `reward_claimed`, `reward_obtained` and the legacy `challenge_claimed`/`twitch_extension_action` all map
  into it.
- Layouts:
  - **drop**: square reward art with the game's box art as a small overlay; name; game · campaign ·
    channel; external link to the campaign.
  - **challenge_card**: portrait card art (128×169 native) with a rarity-coloured frame; rarity and
    recurrence chips; consolation watch time and badge when present.
  - **extension_pack**: provider art; per-edition chips.
  - **extension_capture / extension_giveaway**: item art if any; name; channel.
  - **generic fallback**: image if any, else a dashed placeholder; name or a kind label; source and
    channel; `details` as chips.
- Points rows: channel avatar (if resolved), name, bold total, reason chips (Watching, Bonus ×n,
  Streak, highlighted), with unknown reasons shown by their raw code.
- Images use the existing `ImageWithFallback`, with https-only URLs.
- Update `popup-ui/src/demo.ts` and `marketing.tsx`, which feed the site demo and the store screenshots.
  Store assets must not depict store standing (no ratings).

### Legacy rows

`formatCurrentActivity` and `buildActivityCard` end in `default: return exhaustive`, which returns the
event object at runtime. A stored row whose code the build no longer renders would reach React as an
object. Rendering must guard unknown codes (render nothing, or a neutral line), and `page_context_*` rows
must be filtered out of Activity. Add tests that load a stored `page_context_opened` row and a row with
an invented code. The `activityPageContext*` locale keys go only once nothing renders them.

### Localization

New keys (session headings, totals labels, reason labels, kind labels, Status disclosure, Earlier) are
added to every catalog in `packages/locales/messages/`. Per CLAUDE.md, each locale's translation is
delegated to an inexpensive subagent; preserve `$1` placeholders and brand names; no `diagnostic*` keys.

## Verify live

- Kick claim response: `winner.card_url` and `consolation` (taken from a third-party client's models),
  and whether there is any card name field.
- Fortnite collectable: whether vendor state carries a display name or image, and under which fields.
- Twitch `points-earned`: the full set of `reason_code` values seen in practice.

## Constraints

- `@lurkloot/core` stays browser-free (`coreBoundary.test.ts`).
- No new permissions expected; card and item art load from hosts the popup already shows images from.
  If an image host is outside current permissions, say so in the PR.
- Architecture rules in CLAUDE.md apply; `docs/architecture.md` gains the reward-kind registry, session
  ownership and the sessions store.

## Delivery

Phases that each pass `pnpm check` on their own:

1. Enrich drop events; add `reward_obtained` and move the Kick card and extension emitters; move
   `page_context_*` out of Activity with legacy-safe rendering.
2. Session identity in the engine; Twitch points owner; fold reducer; sessions store and query.
3. Popup session layout, reward registry and layouts; demo and marketing data.
4. Locale keys and translations.

Tests guard: no per-gain rows in the events store; tallied events skip the diagnostic mirror; the fold
is correct under concurrent writes; churn accounting survives the page-context move; legacy rows render.

## Calls left to the builder

Marked above: the page-context mechanism and channel name resolution order. Calls I made are marked
*(My call.)*. The diagnostic mirror of `reward_obtained` flattens `source` and `details`, since
diagnostic `data` is a flat record. Everything not covered here follows the existing code's conventions.
