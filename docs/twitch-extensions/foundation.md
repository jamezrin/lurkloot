# Twitch Extension foundation (#507)

The provider registry, permission/registration lifecycle and same-frame relay
are implemented as independently tested modules. They are not wired into the
background or exposed in settings yet. No provider code executes in a shipped
build. Only the two optional frame origins are added to the manifest; existing
required permissions are unchanged.

## Integration gate: live overlay mounting

Issue #507 requires proving that both video-overlay frames mount and receive
`Twitch.ext.onAuthorized` in the existing pinned, muted background watch tab,
with the overlay collapsed, **before writing the driver host**.

On 2026-09-12 a fresh, separate Playwright Chromium session opened `buddha` and
`loserfruit`, then returned focus to an unrelated page. After 20 seconds per
channel there were no `ext-twitch.tv` frames. This session was not logged in;
channel eligibility/liveness was not confirmed. This is **inconclusive** and
cannot distinguish session restrictions, channel state, delayed loading or an
actual overlay mounting requirement. It is not grounds to implement a hidden
frame or change the design.

To complete the gate in the normal logged-in farming environment:

1. Confirm the channel is live and runs the intended extension. The issue's
   previously verified candidates are `buddha`/`koil` for NoPixel and
   `loserfruit` for Fortnite; installations and liveness may change.
2. Let LurkLoot open its normal pinned muted watch tab. Keep another tab active
   and leave the overlay collapsed.
3. Inspect the channel's iframe list for the exact origin below. If inspecting
   requires activation, record that fact; mounting only after activation is a
   different result from mounting in the background.
4. In the matching frame's DevTools execution context, observe authorization
   with `Twitch.ext.onAuthorized(() => console.info("authorization observed"))`.
   This callback intentionally ignores the authorization argument. Never log,
   copy, save or share the JWT or other credentials.
5. Record mounting and authorization for each provider, and whether foreground
   activation or expansion was necessary, in #507.

Origins:

- `https://nstuq90nghenyqwqme61jgvmtp253a.ext-twitch.tv`
- `https://x2nfeda4neuzvsp2zdqfln9nwxc7tp.ext-twitch.tv`

If foreground activation is necessary, investigate the existing brief player
priming path. If expansion is necessary, re-plan as required by the issue.

## Module contracts

`@lurkloot/core/extensions/registry` exposes immutable descriptors and exact
origin lookup. It performs no I/O and contains no backend endpoints.

`createProviderPermissions` takes injected permission, registration, settings
and transient-state ports. Its `enable` method invokes the permission request
synchronously to preserve the initiating user gesture, verifies the resulting
grant, registers the pair, and only then persists enabled. The eventual UI /
background integration must preserve this gesture and retain Firefox
registration handles in the persistent background page, never in a popup.
Revocation disables the provider and tears down registrations and transient
state. Startup reconciliation verifies enabled providers and removes stale
registrations for disabled ones. Callers must attach `permissions.onRemoved`
and reconcile on every background initialization; these connections are pending.

`createProviderRegistration` selects Firefox MV2 when `contentScripts` is
available; otherwise it uses MV3 `scripting`. It retains partial Firefox handles
until cleanup succeeds, removes stale MV3 IDs on wake, and scopes both worlds
to one provider frame origin. The referenced bundled entrypoints remain pending
the live gate, so this module must not be invoked in production yet.

`startFrameRelay` accepts a report contract table, forwards only screened
same-frame envelopes, supports bounded request correlation/cancellation, and
tears down its listener on stop, credential violations or transport loss.
Unknown report payload fields are stripped. Credential screening covers the entire envelope before
stripping, recursively, and diagnostics contain fixed English text only.
Report schemas should list explicit DTO fields; do not allow raw vendor objects.
The integration must cancel timed-out requests and connect pagehide/runtime
lifecycle cleanup. No production report kinds are registered yet.

## Remaining #507 work

- Live spike result recorded in the issue.
- MAIN-world host and runtime content-script entrypoints, with a throwaway test
  provider and authorization renewal/channel-switch/relay-loss lifecycle tests.
- Background observers, settings enable/disable plumbing, transient-state port.
- The optional-only manifest origins and promotion guard are implemented.
  Recheck generated manifests once runtime entrypoints are integrated.
- Inspect both generated manifests and confirm the existing required permissions
  are unchanged after integration.
