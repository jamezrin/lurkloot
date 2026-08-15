# Twitch Progressing Availability Design

## Problem

Twitch channel selection currently treats a successful
`DropsHighlightService_AvailableDrops` response as an authoritative snapshot for
the channel for two minutes. The cache is keyed only by channel ID. In practice,
the answer can change as channels go offline and begin new broadcasts, and Twitch
can temporarily omit a campaign even while the exact channel is advancing one of
that campaign's rewards.

This creates two correctness failures:

- a negative learned during one broadcast can reject the channel during a later
  broadcast; and
- a negative response can overrule stronger authenticated evidence that the
  selected channel is advancing the selected campaign.

The observed EWC and Tarkov cases also show why a broad category fallback is not
safe. Many live streams can match the game while remaining genuinely ineligible
for the selected campaign.

## Goals

- Revalidate negative channel availability when the underlying Twitch broadcast
  changes.
- Let material reward progress prove availability for the exact channel and
  campaign that produced it.
- Preserve rejection of unrelated channels and unrelated campaigns.
- Make batch selection and single-channel checking use identical availability
  semantics.
- Keep shared discovery state bounded and isolated by authenticated Twitch user.
- Leave complete negative searches eligible for ordinary future retries; do not
  classify them as authoritative input for long negative-search backoff.

## Non-goals

- Do not accept every live stream in the campaign's category.
- Do not infer campaign equivalence from names, categories, artwork, or reward
  display text.
- Do not replace `AvailableDrops` with a per-candidate
  `DropCurrentSessionContext` request.
- Do not solve campaign-ID aliases without a captured response that proves such
  an alias relationship.
- Do not add browser permissions or persist credentials.

## Design

### Broadcast-scoped availability snapshots

An authoritative `AvailableDrops` snapshot will be cached against a channel ID
and the broadcast ID observed when the request was made. A lookup is reusable
only when both identities match. If the same channel is checked with a different
broadcast ID, the old snapshot is discarded and Twitch is queried again.

Channel candidates that do not yet carry a broadcast ID must obtain one from the
existing `StreamInfo` validation before an availability result can be reused as
an authoritative negative. Twitch directory candidates currently bypass that
validation, so the selection path must retain or obtain their stream ID rather
than treating a channel-only negative as valid across broadcasts.

Positive and negative observations have different risk. Positive snapshots keep
the existing two-minute lifetime. Negative snapshots live for 30 seconds, so the
next one-minute scheduler tick can recover even when the broadcast is unchanged.
The constants live beside the existing bounded availability-cache constants.

### Progress-confirmed positive evidence

`refreshCampaigns` already queries `DropCurrentSessionContext` for the current
watch session. Before merging its result, the adapter can identify the campaign
containing the returned `dropID` and compare `currentMinutesWatched` with that
reward's pre-merge watched minutes.

When the current-session value is strictly greater, Twitch has provided material
evidence that this exact channel is advancing this exact campaign. The discovery
state records a bounded, expiring positive fact keyed by channel ID and campaign
ID. Recording it also removes any contradictory cached negative for that pair.
Progress-confirmed facts live for five minutes and use the existing 128-entry
FIFO bound. A later material-progress observation refreshes the fact's lifetime.

The proof is not created when:

- the drop ID cannot be mapped to exactly one discovered campaign;
- watched minutes are absent or unchanged;
- the session channel cannot be resolved to a Twitch channel ID; or
- the authenticated identity changes while the request is in flight.

Progress-confirmed evidence is consulted before an `AvailableDrops` snapshot in
both batch and single paths. It can only turn the proven pair positive. It cannot
make another campaign available on that channel or make the same campaign
available on another channel.

### Shared state and identity isolation

Both availability snapshots and progress-confirmed facts live in
`TwitchDiscoveryState`, because adapters are reconstructed on every scheduler
tick. They use the existing authenticated-user generation guard so requests
started under an old identity cannot populate the current user's state.

The state remains bounded with FIFO eviction and TTL expiry. An authenticated
user change clears both collections. Broadcast changes invalidate only the
affected channel snapshot; they do not erase unrelated channel evidence.

### Unified availability decision

Batch selection and `checkChannel` will resolve availability in the same order:

1. A live/category mismatch is rejected before campaign availability work.
2. A valid progress-confirmed fact for the exact channel/campaign returns true.
3. A broadcast-matching cached `AvailableDrops` snapshot answers normally.
4. Otherwise Twitch is queried and the result is cached with the current
   broadcast identity and positive/negative lifetime.
5. An ambiguous or failed response remains `undefined`, preserving the current
   fail-open behavior for transport uncertainty.

If a full campaign search has no winner, the scheduler remains idle or keeps its
existing lower-priority watch according to current behavior. The search is not
promoted into a long-lived authoritative negative: later ticks re-evaluate new
broadcasts, newly live candidates, expired negative snapshots, and any newly
observed progress.

## Diagnostics

Existing English selection diagnostics will continue reporting cache hits,
misses, and expirations. They will additionally distinguish broadcast
invalidations and progress-confirmed overrides so future reports show why a
channel was rechecked or accepted. These are diagnostic literals, not localized
activity events.

No OAuth tokens, cookies, request headers, or raw authenticated responses are
logged.

## Testing

Deterministic adapter tests will cover:

- a cached negative being reused during the same broadcast;
- a new broadcast ID invalidating that negative and triggering a request;
- a negative expiring sooner than a positive snapshot;
- increased current-session minutes creating an exact positive override;
- unchanged minutes creating no override;
- the override defeating a contradictory cached or fresh negative;
- the override not affecting another channel or campaign;
- authenticated-user changes clearing snapshots and progress evidence;
- stale in-flight requests failing the generation guard; and
- batch and single-channel paths producing the same result for each case.

Focused tests will be run first, followed by the repository's full `pnpm test`,
`pnpm typecheck`, and proportionate build verification.

## Expected Outcome

Normal channel churn causes fresh availability checks instead of reusing a
negative from an obsolete broadcast. Transient negatives recover promptly. If
Twitch nevertheless contradicts itself for the active channel, observed reward
progress wins only for the exact proven channel/campaign pair. Genuine
live/category matches without the selected campaign remain rejectable.
