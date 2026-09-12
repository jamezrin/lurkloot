# Twitch Extension foundation (#507)

The integration runs fully tabless. Authorization acquisition and provider
activity use the privileged background; neither requires a Twitch tab or an
overlay iframe. Work is tracked in draft #541. No settings toggle is exposed
in the popup yet, and independent supplemental channel selection is pending.

The authoritative design, public protocol evidence and credential-safe live
validation instructions are in
[the tabless design](../superpowers/specs/2026-09-12-tabless-twitch-extensions-design.md).

## Implemented

- Browser-free descriptors contain optional backend origins, discovery
  categories and refresh floors. Frame registration/relay/protocol code is removed.
- The selected-channel session source uses Twitch's shipped
  `CoordinatorExtensionsForChannel` fields through the existing browser session
  fetcher. It does not acquire page context or create an integrity tab. Active
  installation, channel binding, viewer role, linked identity and expiry are
  checked; provider backends still perform cryptographic verification.
- Credentials stay within the privileged source/driver callback. Only bounded
  outcomes and validated reports reach the host. Discarded report fields are
  screened too, and summaries contain only known enum values and counters.
- The runtime coalesces channel initialization, bounds polling, renews expiring
  sessions on reconciliation and stops resources at authorization expiry.
  Stop/channel change/revocation/logout discard late session, driver and report
  results. Failed initialization aborts signal-bound resources immediately.
- Permission gating requests backend access directly from an enable gesture;
  background enable verifies a pregranted origin. Denial leaves a provider off.
  Startup verifies grants, revocation stops resources before async cleanup, and
  stale grants/verification cannot restart disabled resources.
- Background startup/wake, alarms, settings/scheduler changes, credential
  changes and permission removal reconcile the runtime. Snapshots attach cloned
  transient summaries; no active provider session is restored from storage.
- Browser-only settings default NoPixelV, Fortnite and takeovers off. CLI config
  rejects those keys. Required browser grants are unchanged; both vendor
  backends are optional.
- The NoPixel 1.1.2 driver uses Bearer auth, an initialization ping, channel
  setup, daily-watchtime reads and giveaway join/refetch. Joins are reported
  only after server membership confirms them. Definite HTTP failures can retry;
  ambiguous submissions remain guarded. No packs/inventory are modified.

## Remaining

Authenticated session acquisition and actual earning without a Twitch tab
still need live confirmation; anonymous reachability is not earning proof.
Finish the supplemental lane, independent channel discovery and settings/status
UI (#508), NoPixelV lane ownership (#509), and Fortnite transport plus earning
(#510/#511). Both Fortnite issues must ship together.

Provider JWTs and vendor device/session properties stay in memory. They never
enter settings, snapshots, messages, activity, diagnostics or exports. No hidden
frames, CSP modification, Origin spoofing, credential export or platform
detection bypass is part of this design.

## NoPixel evidence

The published NoPixel 1.1.2 bundles use `Authorization: Bearer ...` and expose
`/ping`, `/channel/setup`, `/cards/rewards/daily-watchtime/progress`,
`/channel/giveaway` and `/channel/giveaway/join`. The collection hook reads
`watch_time_earned` and `watch_time_required`; the giveaway hook refetches after
joining and reads `has_user_entered_giveaway`. The initialization ping is a
stale-forever read enabled for a linked viewer. The collection progress hook
currently refreshes every ten seconds; LurkLoot conservatively polls no faster
than once per minute.

Public source base:
`https://nstuq90nghenyqwqme61jgvmtp253a.ext-twitch.tv/nstuq90nghenyqwqme61jgvmtp253a/1.1.2/3d6b2e718e0d4f67822b75a68ca922b7/assets/`.
Relevant bundled assets: `Alert-D-LPMaDd.js`, `TwatterView-C2JjPIqz.js`,
`useGiveaway--y3iy8yN.js`. Tests use synthetic schemas, never live responses.
