# Twitch Extension foundation (#507)

The integration must run fully tabless. Neither authorization acquisition nor
provider activity may depend on a Twitch tab or an overlay iframe. The current
implementation is in draft #541 and is not exposed in settings or wired into
background startup yet. No provider earns rewards in the shipped build.

The authoritative design, public protocol evidence and credential-safe live
validation instructions are in
[the tabless design](../superpowers/specs/2026-09-12-tabless-twitch-extensions-design.md).

## Implemented primitives

- Browser-free provider descriptors include the optional backend origin,
  discovery categories and refresh floor. Published overlay origins are
  metadata only.
- A selected-channel session source reads Twitch's shipped
  `CoordinatorExtensionsForChannel` installation/token fields through an
  injected privileged transport. It checks active installation, channel
  binding, viewer role, linked identity and expiry. Claims checks do not replace
  provider-side cryptographic verification.
- Authorization, expiry and cancellation are handed only to the privileged
  driver callback. Only a bounded outcome class returns to the host. Late
  responses are discarded after cancellation; vendor exceptions are suppressed.
- A channel-scoped lifecycle coalesces repeated selection, aborts the previous
  channel synchronously, and disposes resources initialized after cancellation.
- Permission gating requests the backend directly from the enable gesture,
  verifies grants, handles denial/startup/revocation, and invalidates stale
  enable/reconciliation operations before they can restart resources.
- Chromium and Firefox manifests add optional backend grants while preserving
  existing required permissions. Runtime content-script registration was removed.

## Remaining foundation work

Replace the unwired legacy frame relay/protocol with direct credential-free
report validation. Wire a privileged runtime and settings/permission lifecycle
into background startup, logout and revocation, with renewal/restart tests.
Verify authenticated session acquisition without a Twitch tab, sharing only
booleans/outcomes. Then finish the shared supplemental lane and settings UI
(#508), NoPixelV earning (#509), and Fortnite transport plus earning (#510/#511).
Both Fortnite issues must ship together; status-only support is incomplete.

Provider JWTs and vendor device/session properties remain in memory. They must
never enter settings, snapshots, messages, activity, diagnostics or exports.
No hidden frames, CSP modification, Origin spoofing, credential export or
platform detection bypass is part of this design.
